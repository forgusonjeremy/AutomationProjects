#!/bin/bash
# =============================================================================
# generate_snapshot_io.sh
# Purpose : Generate controlled block-level churn targeting a specific snapshot
#           delta size per interval. Writes are rate-limited so that each
#           3-minute snapshot interval accumulates approximately --target-gb GB
#           of unique dirty blocks — giving predictable, manageable delta sizes.
#
# How delta size is controlled:
#   Delta size = unique blocks written per snapshot interval.
#   This script calculates the required MB/s rate to hit the target and uses
#   a token-bucket rate limiter (sleep between writes) to stay on target.
#   A sequential sweep pattern ensures every write hits a new block rather
#   than re-dirtying an already-tracked block.
#
# Disk usage:
#   Fixed at --working-set MB. Files are pre-allocated once and overwritten
#   in place — disk usage does not grow beyond the initial allocation.
#   Working set must be >= target-gb to ensure the sweep covers enough blocks.
#
# Usage:
#   bash generate_snapshot_io.sh [options]
#
#   Copy to target VM and run as sshuser:
#     scp generate_snapshot_io.sh sshuser@<vm-ip>:/tmp/
#     ssh sshuser@<vm-ip> "bash /tmp/generate_snapshot_io.sh"
#
# Options:
#   --dir           Working directory          (default: ~/snapshot_io_test)
#   --working-set   Total fixed data, MB       (default: 4096 — 4GB)
#   --duration      How long to run, seconds   (default: 1800 — 30 min)
#   --threads       Parallel writer threads    (default: 4)
#   --target-gb     Dirty blocks per 3-min interval, GB  (default: 2)
#   --interval-sec  Snapshot interval to target, seconds (default: 180 — 3 min)
# =============================================================================

set -u

# ── Defaults ─────────────────────────────────────────────────────────────────
IO_DIR="${HOME}/snapshot_io_test"
WORKING_SET_MB=4096
DURATION=1800
THREADS=4
TARGET_GB=2           # Desired delta size per snapshot interval in GB
INTERVAL_SEC=180      # Must match your snapshot interval (default 3 min)
LOG_FILE="${HOME}/snapshot_io_test.log"

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)           IO_DIR="$2";          shift 2 ;;
    --working-set)   WORKING_SET_MB="$2";  shift 2 ;;
    --duration)      DURATION="$2";        shift 2 ;;
    --threads)       THREADS="$2";         shift 2 ;;
    --target-gb)     TARGET_GB="$2";       shift 2 ;;
    --interval-sec)  INTERVAL_SEC="$2";    shift 2 ;;
    --help|-h)
      grep '^# Usage\|^#   --' "$0" | sed 's/^# //'
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ── Rate calculation ──────────────────────────────────────────────────────────
# Target MB/s aggregate = (target GB * 1024) / interval seconds
# Per-thread MB/s       = aggregate / threads
# Write block size      = 64MB (large blocks = fewer syscalls = more accurate rate)
# Sleep per block       = block_size_mb / per_thread_mbps  (seconds)

TARGET_MB=$(( TARGET_GB * 1024 ))
PER_THREAD_MB=$(( WORKING_SET_MB / THREADS ))
[[ $PER_THREAD_MB -lt 256 ]] && PER_THREAD_MB=256

BLOCK_MB=64   # Write block size in MB

# Use awk for float arithmetic since bash only does integers
AGG_MBPS=$(awk "BEGIN { printf \"%.4f\", $TARGET_MB / $INTERVAL_SEC }")
PER_THREAD_MBPS=$(awk "BEGIN { printf \"%.4f\", $AGG_MBPS / $THREADS }")
SLEEP_PER_BLOCK=$(awk "BEGIN { printf \"%.4f\", $BLOCK_MB / $PER_THREAD_MBPS }")
BLOCKS_PER_FILE=$(( PER_THREAD_MB / BLOCK_MB ))

START_TIME=$(date +%s)
END_TIME=$(( START_TIME + DURATION ))

# ── Setup ─────────────────────────────────────────────────────────────────────
mkdir -p "$IO_DIR"
echo "" > "$LOG_FILE"

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

cleanup() {
  log "Stopping — removing working set from $IO_DIR ..."
  kill 0 2>/dev/null || true
  wait 2>/dev/null || true
  rm -rf "$IO_DIR"
  log "Done. Disk space fully returned."
}
trap cleanup INT TERM EXIT

# ── Disk space check ──────────────────────────────────────────────────────────
AVAIL_MB=$(df -m "$IO_DIR" | awk 'NR==2{print $4}')
NEEDED_MB=$(( WORKING_SET_MB + 256 ))
if [[ $AVAIL_MB -lt $NEEDED_MB ]]; then
  log "ERROR: Need ~${NEEDED_MB}MB free but only ${AVAIL_MB}MB available."
  log "       Reduce --working-set or free up space. Exiting."
  exit 1
fi

# Warn if working set is smaller than one interval's target — the sweep will
# wrap around and re-dirty blocks, producing smaller deltas than targeted.
TARGET_PER_THREAD_MB=$(( TARGET_MB / THREADS ))
if [[ $PER_THREAD_MB -lt $TARGET_PER_THREAD_MB ]]; then
  log "WARNING: Per-thread working set (${PER_THREAD_MB}MB) is smaller than"
  log "         per-thread target dirty data (${TARGET_PER_THREAD_MB}MB)."
  log "         Increase --working-set to at least $(( TARGET_MB * 2 ))MB for accurate targeting."
fi

log "====================================================="
log " Snapshot Churn Generator (rate-controlled mode)"
log "====================================================="
log " Working dir    : $IO_DIR"
log " Working set    : ${WORKING_SET_MB}MB total (${PER_THREAD_MB}MB x ${THREADS} threads)"
log " Duration       : ${DURATION}s ($(( DURATION / 60 )) min)"
log " Target delta   : ${TARGET_GB}GB per ${INTERVAL_SEC}s snapshot interval"
log " Aggregate rate : ${AGG_MBPS} MB/s"
log " Per-thread rate: ${PER_THREAD_MBPS} MB/s"
log " Block size     : ${BLOCK_MB}MB"
log " Sleep/block    : ${SLEEP_PER_BLOCK}s"
log " Disk available : ${AVAIL_MB}MB"
log "====================================================="
log ""

# ── Worker: rate-controlled sequential sweep ──────────────────────────────────
# Writes sequentially through the file in BLOCK_MB chunks.
# Sleeps SLEEP_PER_BLOCK seconds after each block to hit the target rate.
# Sequential pattern guarantees every write hits a previously-untracked block
# within the current snapshot interval (no re-dirties until after full sweep).
dd_worker() {
  local id="$1"
  local file="$IO_DIR/worker_${id}.dat"

  log "  [Worker $id] Allocating ${PER_THREAD_MB}MB working file..."
  fallocate -l "${PER_THREAD_MB}M" "$file" 2>/dev/null || \
    dd if=/dev/zero of="$file" bs=1M count="$PER_THREAD_MB" status=none 2>/dev/null
  log "  [Worker $id] Ready — starting rate-controlled sweep at ${PER_THREAD_MBPS} MB/s"

  local pass=0
  local total_written_mb=0

  while [[ $(date +%s) -lt $END_TIME ]]; do
    pass=$(( pass + 1 ))
    local block=0

    while [[ $block -lt $BLOCKS_PER_FILE ]] && [[ $(date +%s) -lt $END_TIME ]]; do
      local write_start
      write_start=$(date +%s%N)   # nanoseconds for accurate sleep calculation

      dd if=/dev/zero of="$file" bs="${BLOCK_MB}M" count=1 \
         seek="$block" conv=notrunc status=none 2>/dev/null

      total_written_mb=$(( total_written_mb + BLOCK_MB ))
      block=$(( block + 1 ))

      # Rate limiter: calculate actual elapsed time for this write and sleep
      # the remainder of the target period. This self-corrects for dd overhead.
      local write_end
      write_end=$(date +%s%N)
      local elapsed_ns=$(( write_end - write_start ))
      local target_ns
      target_ns=$(awk "BEGIN { printf \"%d\", $SLEEP_PER_BLOCK * 1000000000 }")
      local sleep_ns=$(( target_ns - elapsed_ns ))

      if [[ $sleep_ns -gt 0 ]]; then
        local sleep_sec
        sleep_sec=$(awk "BEGIN { printf \"%.6f\", $sleep_ns / 1000000000 }")
        sleep "$sleep_sec"
      fi
    done

    # Flush at end of each sweep pass
    sync "$file" 2>/dev/null || true
    log "  [Worker $id] Pass $pass complete — ~${total_written_mb}MB written total"
  done

  log "  [Worker $id] Done — $pass passes, ~${total_written_mb}MB written"
}

# ── fio mode (if available) ───────────────────────────────────────────────────
# fio's --rate option gives more precise rate control than shell sleep loops.
run_fio() {
  log "fio detected — using fio rate-controlled mode"

  local per_thread_kbps
  per_thread_kbps=$(awk "BEGIN { printf \"%d\", $PER_THREAD_MBPS * 1024 }")

  log "  Pre-allocating ${THREADS} worker files..."
  for i in $(seq 1 "$THREADS"); do
    fallocate -l "${PER_THREAD_MB}M" "$IO_DIR/worker_${i}.dat" 2>/dev/null || \
      dd if=/dev/zero of="$IO_DIR/worker_${i}.dat" bs=1M count="$PER_THREAD_MB" status=none 2>/dev/null
  done

  local jobfile="$IO_DIR/fio_jobs.ini"
  cat > "$jobfile" <<FIOEOF
[global]
ioengine=sync
rw=write
bs=${BLOCK_MB}M
direct=0
buffered=1
end_fsync=1
runtime=${DURATION}
time_based=1
group_reporting=1
rate=${per_thread_kbps}k

FIOEOF

  for i in $(seq 1 "$THREADS"); do
    cat >> "$jobfile" <<FIOEOF
[worker_${i}]
filename=$IO_DIR/worker_${i}.dat
size=${PER_THREAD_MB}M

FIOEOF
  done

  log "  Launching fio — ${THREADS} workers at ${PER_THREAD_MBPS} MB/s each..."
  log "  Target aggregate: ${AGG_MBPS} MB/s = ~${TARGET_GB}GB per ${INTERVAL_SEC}s interval"
  fio "$jobfile" 2>&1 | tee -a "$LOG_FILE"
}

# ── Progress monitor ──────────────────────────────────────────────────────────
monitor() {
  local last_check=$START_TIME
  while [[ $(date +%s) -lt $END_TIME ]]; do
    sleep 60
    [[ $(date +%s) -ge $END_TIME ]] && break
    local remaining=$(( END_TIME - $(date +%s) ))
    local elapsed=$(( $(date +%s) - START_TIME ))
    local elapsed_intervals
    elapsed_intervals=$(awk "BEGIN { printf \"%.1f\", $elapsed / $INTERVAL_SEC }")
    log "  [Monitor] ${remaining}s remaining | ~${elapsed_intervals} snapshot intervals elapsed"
  done
}

# ── Run ───────────────────────────────────────────────────────────────────────
if command -v fio &>/dev/null; then
  monitor &
  MONITOR_PID=$!
  run_fio
  kill "$MONITOR_PID" 2>/dev/null || true
else
  log "fio not found — using dd rate-limiter (install fio for better accuracy)"
  log "  Run: sudo yum install -y fio"
  log ""

  PIDS=()
  for i in $(seq 1 "$THREADS"); do
    dd_worker "$i" &
    PIDS+=($!)
  done

  monitor &
  PIDS+=($!)

  for pid in "${PIDS[@]}"; do
    wait "$pid" 2>/dev/null || true
  done
fi

log ""
log "====================================================="
log " Complete. Working set will be removed on exit."
log "====================================================="
