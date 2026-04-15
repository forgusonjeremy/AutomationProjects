#!/bin/bash
# =============================================================================
# generate_snapshot_io.sh
# Purpose : Generate realistic block-level churn for snapshot cleanup testing.
#           Works by repeatedly OVERWRITING a fixed working set rather than
#           growing files — snapshot deltas track changed blocks, not file
#           growth, so this drives meaningful snapshot divergence without
#           filling the disk.
#
# What this does NOT do:
#   - It does not grow the disk indefinitely
#   - It does not fill free space
#   - Files deleted inside the guest do NOT reclaim space from a snapshot delta
#     (VMFS doesn't punch holes), so the "create + delete" pattern is avoided
#
# What it DOES do:
#   - Pre-allocates a fixed working set (bounded disk usage)
#   - Continuously overwrites random regions of those files (dirty blocks)
#   - Simulates metadata churn (renames, appends, truncates) on small files
#   - Flushes to disk so changes are real and visible to the snapshot mechanism
#
# Usage:
#   sudo bash generate_snapshot_io.sh [options]
#
# Options:
#   --dir         Working directory        (default: /tmp/snapshot_io_test)
#   --working-set Size of fixed data in MB (default: 512)
#   --duration    How long to run, seconds (default: 300)
#   --threads     Parallel churn workers   (default: 4)
# =============================================================================

set -euo pipefail

# ── Defaults ─────────────────────────────────────────────────────────────────
IO_DIR="/tmp/snapshot_io_test"
WORKING_SET_MB=512    # Total disk space consumed — stays fixed after init
DURATION=300
THREADS=4
LOG_FILE="/tmp/snapshot_io_test.log"

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)          IO_DIR="$2";           shift 2 ;;
    --working-set)  WORKING_SET_MB="$2";   shift 2 ;;
    --duration)     DURATION="$2";         shift 2 ;;
    --threads)      THREADS="$2";          shift 2 ;;
    --help|-h)
      grep '^# Usage\|^#   --' "$0" | sed 's/^# //'
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ── Per-thread working set ────────────────────────────────────────────────────
PER_THREAD_MB=$(( WORKING_SET_MB / THREADS ))
[[ $PER_THREAD_MB -lt 32 ]] && PER_THREAD_MB=32

START_TIME=$(date +%s)
END_TIME=$(( START_TIME + DURATION ))

# ── Helpers ───────────────────────────────────────────────────────────────────
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

log "====================================================="
log " Snapshot Churn Generator"
log "====================================================="
log " Working dir   : $IO_DIR"
log " Working set   : ${WORKING_SET_MB} MB total (fixed — will not grow)"
log " Duration      : ${DURATION}s"
log " Threads       : $THREADS x ${PER_THREAD_MB} MB each"
log "====================================================="
log " Disk usage before: $(df -h "$IO_DIR" | awk 'NR==2{print $3 " used, " $4 " free"}')"
log ""

# ── Worker: large-file overwrite churn ───────────────────────────────────────
# Simulates: database page writes, VM guest disk activity, log rotation
# Pattern:   pre-allocate once, then overwrite random offsets indefinitely
large_file_worker() {
  local id="$1"
  local dir="$IO_DIR/worker_${id}"
  mkdir -p "$dir"

  # Pre-allocate the working file ONCE — this is the fixed disk cost
  local file="$dir/workingset.dat"
  local size_mb="$PER_THREAD_MB"
  log "  [Worker $id] Allocating ${size_mb}MB working file..."
  dd if=/dev/zero of="$file" bs=1M count="$size_mb" conv=fsync status=none 2>/dev/null
  log "  [Worker $id] Ready — starting overwrite churn"

  local total_size_bytes=$(( size_mb * 1024 * 1024 ))
  local chunk_size=$(( 64 * 1024 ))  # 64k writes — realistic block churn
  local iteration=0

  while [[ $(date +%s) -lt $END_TIME ]]; do
    iteration=$(( iteration + 1 ))

    # Pick a random offset within the file (aligned to chunk_size)
    local max_offset=$(( total_size_bytes - chunk_size ))
    local offset=$(( (RANDOM * RANDOM) % max_offset ))
    offset=$(( offset - (offset % chunk_size) ))  # align

    # Overwrite that region — this dirties blocks for the snapshot delta
    dd if=/dev/urandom of="$file" bs="$chunk_size" count=1 \
       seek=$(( offset / chunk_size )) conv=notrunc,fsync status=none 2>/dev/null

    # Every 100 iterations, do a full sequential pass (simulates heavy write burst)
    if (( iteration % 100 == 0 )); then
      dd if=/dev/urandom of="$file" bs=1M count="$size_mb" \
         conv=notrunc,fsync status=none 2>/dev/null
      log "  [Worker $id] Full pass #$(( iteration / 100 )) complete"
    fi
  done

  log "  [Worker $id] Done — $iteration overwrite operations"
}

# ── Worker: small-file metadata churn ────────────────────────────────────────
# Simulates: application logs, temp files, config changes
# Pattern:   fixed pool of small files, continuously appended/truncated/renamed
# Disk cost: fixed at ~16 MB regardless of duration
metadata_worker() {
  local dir="$IO_DIR/metadata"
  mkdir -p "$dir"

  local pool_size=32          # number of files in the pool
  local file_size_kb=512      # each file capped at 512KB

  # Pre-create the pool
  log "  [Metadata worker] Creating ${pool_size}-file pool (fixed ~$(( pool_size * file_size_kb / 1024 ))MB)..."
  for i in $(seq 1 "$pool_size"); do
    dd if=/dev/zero of="$dir/pool_${i}.dat" bs=1k count="$file_size_kb" \
       conv=fsync status=none 2>/dev/null
  done
  log "  [Metadata worker] Ready — starting metadata churn"

  local op=0
  while [[ $(date +%s) -lt $END_TIME ]]; do
    op=$(( op + 1 ))
    local idx=$(( (RANDOM % pool_size) + 1 ))
    local file="$dir/pool_${idx}.dat"
    local pattern=$(( op % 4 ))

    case $pattern in
      0)  # Append a line then truncate back to original size (simulates log rotation)
          echo "churn_op_${op}_$(date +%N)" >> "$file"
          truncate -s "${file_size_kb}k" "$file"
          sync "$file" 2>/dev/null || true
          ;;
      1)  # Overwrite random 4K block within file (simulates record update)
          local fsize=$(( file_size_kb * 1024 ))
          local offset=$(( (RANDOM % (fsize / 4096)) * 4096 ))
          dd if=/dev/urandom of="$file" bs=4096 count=1 \
             seek=$(( offset / 4096 )) conv=notrunc,fsync status=none 2>/dev/null
          ;;
      2)  # Rename (simulates atomic log/config file replacement)
          local tmp="$dir/pool_${idx}.tmp"
          cp "$file" "$tmp"
          mv "$tmp" "$file"
          ;;
      3)  # Overwrite entire file (simulates full config rewrite)
          dd if=/dev/urandom of="$file" bs=1k count="$file_size_kb" \
             conv=notrunc,fsync status=none 2>/dev/null
          ;;
    esac
  done

  log "  [Metadata worker] Done — $op metadata operations"
}

# ── Progress monitor ──────────────────────────────────────────────────────────
monitor() {
  while [[ $(date +%s) -lt $END_TIME ]]; do
    sleep 30
    [[ $(date +%s) -ge $END_TIME ]] && break
    local used free remaining
    used=$(df -h "$IO_DIR" 2>/dev/null | awk 'NR==2{print $3}')
    free=$(df -h "$IO_DIR" 2>/dev/null | awk 'NR==2{print $4}')
    remaining=$(( END_TIME - $(date +%s) ))
    log "  [Monitor] Disk: ${used} used / ${free} free | ${remaining}s remaining"
  done
}

# ── Launch ────────────────────────────────────────────────────────────────────
log "Starting workers..."

PIDS=()

# Large-file overwrite workers (main churn)
for i in $(seq 1 "$THREADS"); do
  large_file_worker "$i" &
  PIDS+=($!)
done

# Metadata churn worker (one is enough)
metadata_worker &
PIDS+=($!)

# Monitor
monitor &
PIDS+=($!)

# ── Wait ──────────────────────────────────────────────────────────────────────
for pid in "${PIDS[@]}"; do
  wait "$pid" 2>/dev/null || true
done

log ""
log "Disk usage after : $(df -h "$IO_DIR" | awk 'NR==2{print $3 " used, " $4 " free"}')"
log "====================================================="
log " Complete. Working set will be removed on exit."
log "====================================================="
