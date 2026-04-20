#!/bin/bash
# =============================================================================
# generate_snapshot_io.sh
# Purpose : Generate GB-scale block-level churn per snapshot interval so that
#           snapshot deltas are large enough to stress cleanup testing and
#           affect datastore performance metrics.
#
# Why previous versions produced small deltas:
#   - dd from /dev/urandom is CPU-bound — entropy generation caps throughput
#     well below disk speed, so writes were slow and covered few blocks.
#   - conv=fsync on every dd call serialized writes, killing throughput further.
#   - A small working set got fully covered in seconds, after which no new
#     blocks were being dirtied (re-writes don't grow the delta).
#
# How this version fixes it:
#   - Uses fio (preferred) with libaio for async high-queue-depth sequential
#     writes — this is what actually saturates disk throughput.
#   - Falls back to dd using /dev/zero (compressible but fast) if fio is absent.
#   - Syncs periodically (every 512MB written) rather than after every write.
#   - Uses a large enough working set that a full sequential sweep takes longer
#     than one snapshot interval, so each snapshot sees fresh dirty blocks.
#   - Each thread writes to its own file so there is no lock contention.
#
# Disk usage:
#   Fixed at --working-set MB. Files are pre-allocated once and overwritten
#   in place — disk usage does not grow beyond the initial allocation.
#
# Usage:
#   bash generate_snapshot_io.sh [options]
#
#   Copy to target VM and run as sshuser:
#     scp generate_snapshot_io.sh sshuser@<vm-ip>:/tmp/
#     ssh sshuser@<vm-ip> "bash /tmp/generate_snapshot_io.sh"
#
# Options:
#   --dir          Working directory         (default: ~/snapshot_io_test)
#   --working-set  Total fixed data, MB      (default: 8192  — 8GB)
#   --duration     How long to run, seconds  (default: 1800  — 30 min)
#   --threads      Parallel writer threads   (default: 4)
#   --sync-mb      Flush to disk every N MB  (default: 512)
# =============================================================================

# Note: set -euo pipefail is intentionally avoided here.
# When launched via nohup from a wrapper script, pipefail combined with
# bash's subshell variable scoping corrupts the function context stack on
# CentOS, producing "head of shell_variables not a function context" errors.
# Individual protections are applied explicitly where needed instead.
set -u   # treat unset variables as errors

# ── Defaults ─────────────────────────────────────────────────────────────────
IO_DIR="${HOME}/snapshot_io_test"
WORKING_SET_MB=4096   # 4GB — fits comfortably on VMs with ~7GB free.
                      # Increase if you have more disk and want larger deltas.
DURATION=1800         # 30 minutes default — adjust to match your test window
THREADS=4
SYNC_EVERY_MB=512     # Flush periodically, not on every write
LOG_FILE="${HOME}/snapshot_io_test.log"

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)          IO_DIR="$2";           shift 2 ;;
    --working-set)  WORKING_SET_MB="$2";   shift 2 ;;
    --duration)     DURATION="$2";         shift 2 ;;
    --threads)      THREADS="$2";          shift 2 ;;
    --sync-mb)      SYNC_EVERY_MB="$2";    shift 2 ;;
    --help|-h)
      grep '^# Usage\|^#   --' "$0" | sed 's/^# //'
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

PER_THREAD_MB=$(( WORKING_SET_MB / THREADS ))
[[ $PER_THREAD_MB -lt 512 ]] && PER_THREAD_MB=512

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

log "====================================================="
log " Snapshot Churn Generator (high-throughput mode)"
log "====================================================="
log " Working dir   : $IO_DIR"
log " Working set   : ${WORKING_SET_MB} MB total (${PER_THREAD_MB} MB x ${THREADS} threads)"
log " Duration      : ${DURATION}s ($(( DURATION / 60 )) min)"
log " Sync interval : every ${SYNC_EVERY_MB}MB written"
log " Disk avail    : ${AVAIL_MB}MB"
log "====================================================="

# ── fio mode (preferred) ──────────────────────────────────────────────────────
# fio with libaio saturates disk write throughput far better than dd.
# Each thread gets its own file and does sequential writes with periodic rewind,
# ensuring a continuous stream of new dirty blocks throughout the run.
run_fio() {
  log "fio detected — using async libaio mode"

  local jobs_args=""
  for i in $(seq 1 "$THREADS"); do
    local file="$IO_DIR/worker_${i}.dat"
    # Pre-allocate
    log "  Pre-allocating worker $i file (${PER_THREAD_MB}MB)..."
    fallocate -l "${PER_THREAD_MB}M" "$file" 2>/dev/null || \
      dd if=/dev/zero of="$file" bs=1M count="$PER_THREAD_MB" status=none 2>/dev/null
  done

  log "  Launching fio — sequential writes, iodepth=16, bs=1M..."

  # Build a fio job file dynamically
  local jobfile="$IO_DIR/fio_jobs.ini"
  cat > "$jobfile" <<FIOEOF
[global]
ioengine=libaio
iodepth=16
rw=write
bs=1M
direct=0
buffered=1
fsync_on_close=0
end_fsync=1
runtime=${DURATION}
time_based=1
group_reporting=1
randrepeat=0

FIOEOF

  for i in $(seq 1 "$THREADS"); do
    cat >> "$jobfile" <<FIOEOF
[worker_${i}]
filename=$IO_DIR/worker_${i}.dat
size=${PER_THREAD_MB}M

FIOEOF
  done

  fio "$jobfile" 2>&1 | tee -a "$LOG_FILE"
}

# ── dd fallback mode ──────────────────────────────────────────────────────────
# Uses /dev/zero (not /dev/urandom) — entropy generation was the bottleneck
# that capped throughput in the previous version. /dev/zero is effectively
# unlimited speed. VMFS does not deduplicate unless you have vSAN dedup enabled,
# so zero-filled blocks still register as dirty and grow the snapshot delta.
#
# Syncs every SYNC_EVERY_MB rather than after every write — this allows the
# OS page cache to coalesce writes and hand them to the storage stack in large
# sequential bursts, which is what drives high MB/s on iSCSI/NFS datastores.
run_dd() {
  log "fio not found — using dd fallback (install fio for better throughput)"
  log "  Run: sudo yum install -y fio"

  dd_worker() {
    local id="$1"
    local file="$IO_DIR/worker_${id}.dat"
    local size_mb="$PER_THREAD_MB"
    local sync_counter=0
    local total_written_mb=0
    local pass=0

    log "  [Worker $id] Allocating ${size_mb}MB..."
    fallocate -l "${size_mb}M" "$file" 2>/dev/null || \
      dd if=/dev/zero of="$file" bs=1M count="$size_mb" status=none 2>/dev/null
    log "  [Worker $id] Ready"

    # Sequential sweep loop — write through the entire file start to end,
    # then rewind and repeat. Each sweep dirties every block in the file.
    # Write in 64MB batches to keep dd overhead low.
    local batch_mb=64
    local blocks_per_file=$(( size_mb / batch_mb ))

    while [[ $(date +%s) -lt $END_TIME ]]; do
      pass=$(( pass + 1 ))
      local block=0

      while [[ $block -lt $blocks_per_file ]] && [[ $(date +%s) -lt $END_TIME ]]; do
        dd if=/dev/zero of="$file" bs="${batch_mb}M" count=1 \
           seek="$block" conv=notrunc status=none 2>/dev/null
        block=$(( block + 1 ))
        total_written_mb=$(( total_written_mb + batch_mb ))
        sync_counter=$(( sync_counter + batch_mb ))

        # Periodic sync — flush to disk every SYNC_EVERY_MB
        if [[ $sync_counter -ge $SYNC_EVERY_MB ]]; then
          sync
          sync_counter=0
        fi
      done

      log "  [Worker $id] Pass $pass complete — ~${total_written_mb}MB written total"
    done

    log "  [Worker $id] Done — $pass passes, ~${total_written_mb}MB written"
  }

  PIDS=()
  for i in $(seq 1 "$THREADS"); do
    dd_worker "$i" &
    PIDS+=($!)
  done

  # Progress monitor
  while [[ $(date +%s) -lt $END_TIME ]]; do
    sleep 30
    [[ $(date +%s) -ge $END_TIME ]] && break
    local used free remaining
    used=$(df -h "$IO_DIR" 2>/dev/null | awk 'NR==2{print $3}')
    free=$(df -h "$IO_DIR" 2>/dev/null | awk 'NR==2{print $4}')
    remaining=$(( END_TIME - $(date +%s) ))
    log "  [Monitor] Disk: ${used} used / ${free} free | ${remaining}s remaining"
  done

  for pid in "${PIDS[@]}"; do
    wait "$pid" 2>/dev/null || true
  done
}

# ── Run ───────────────────────────────────────────────────────────────────────
if command -v fio &>/dev/null; then
  run_fio
else
  run_dd
fi

log ""
log "Disk usage after : $(df -h "$IO_DIR" | awk 'NR==2{print $3 " used, " $4 " free"}')"
log "====================================================="
log " Complete. Working set will be removed on exit."
log "====================================================="
