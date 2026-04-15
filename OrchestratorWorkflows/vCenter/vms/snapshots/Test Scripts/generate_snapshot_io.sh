#!/bin/bash
# =============================================================================
# generate_snapshot_io.sh
# Purpose : Generate realistic disk I/O (writes) to simulate real-world VM
#           workload for snapshot cleanup testing.
# Target  : CentOS 7/8/Stream
# Usage   : sudo bash generate_snapshot_io.sh [--dir /path] [--duration 300]
#                                              [--size-gb 10] [--threads 4]
# =============================================================================

set -euo pipefail

# ── Defaults ─────────────────────────────────────────────────────────────────
IO_BASE_DIR="/tmp/snapshot_io_test"
DURATION=300          # seconds to run
TARGET_SIZE_GB=10     # total data to write (GB)
THREADS=4             # parallel writer threads
LOG_FILE="/tmp/snapshot_io_test.log"
BLOCK_SIZE="64k"      # write block size (mix of sizes = more realistic)

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)      IO_BASE_DIR="$2"; shift 2 ;;
    --duration) DURATION="$2";   shift 2 ;;
    --size-gb)  TARGET_SIZE_GB="$2"; shift 2 ;;
    --threads)  THREADS="$2";    shift 2 ;;
    --help|-h)
      grep '^# Usage' "$0" | sed 's/# //'
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ── Derived values ────────────────────────────────────────────────────────────
PER_THREAD_GB=$(( TARGET_SIZE_GB / THREADS ))
PER_THREAD_MB=$(( PER_THREAD_GB * 1024 ))
START_TIME=$(date +%s)
END_TIME=$(( START_TIME + DURATION ))

# ── Setup ─────────────────────────────────────────────────────────────────────
mkdir -p "$IO_BASE_DIR"
echo "" > "$LOG_FILE"

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

cleanup() {
  log "Caught signal – cleaning up worker processes..."
  kill 0 2>/dev/null || true
  log "Removing test data from $IO_BASE_DIR ..."
  rm -rf "$IO_BASE_DIR"
  log "Done."
}
trap cleanup INT TERM EXIT

log "====================================================="
log " Snapshot I/O Generator"
log "====================================================="
log " Base dir      : $IO_BASE_DIR"
log " Duration      : ${DURATION}s"
log " Total data    : ${TARGET_SIZE_GB} GB across $THREADS threads"
log " Per-thread    : ${PER_THREAD_GB} GB (~${PER_THREAD_MB} MB)"
log " Log           : $LOG_FILE"
log "====================================================="

# ── Worker function ───────────────────────────────────────────────────────────
# Simulates: large sequential writes, small random writes, file churn (create/delete)
worker() {
  local id="$1"
  local dir="$IO_BASE_DIR/worker_${id}"
  mkdir -p "$dir"

  local file_num=0
  local bytes_written=0
  local target_bytes=$(( PER_THREAD_MB * 1024 * 1024 ))

  while [[ $(date +%s) -lt $END_TIME ]] && [[ $bytes_written -lt $target_bytes ]]; do
    file_num=$(( file_num + 1 ))

    # Vary write pattern to mimic real workloads
    local pattern=$(( file_num % 4 ))

    case $pattern in
      0)  # Large sequential file (simulates DB writes, logs, VM disk activity)
          local size_mb=$(( RANDOM % 256 + 64 ))
          local filepath="$dir/large_${file_num}.dat"
          dd if=/dev/urandom of="$filepath" bs=1M count="$size_mb" \
             conv=fsync status=none 2>/dev/null
          bytes_written=$(( bytes_written + size_mb * 1024 * 1024 ))
          ;;
      1)  # Many small files (simulates app logs, temp files, cache)
          for i in $(seq 1 20); do
            local size_kb=$(( RANDOM % 512 + 4 ))
            local filepath="$dir/small_${file_num}_${i}.tmp"
            dd if=/dev/urandom of="$filepath" bs=1k count="$size_kb" \
               conv=fsync status=none 2>/dev/null
            bytes_written=$(( bytes_written + size_kb * 1024 ))
          done
          ;;
      2)  # Overwrite existing file (simulates database page updates)
          local filepath="$dir/overwrite.dat"
          local size_mb=$(( RANDOM % 128 + 32 ))
          dd if=/dev/urandom of="$filepath" bs=1M count="$size_mb" \
             conv=fsync status=none 2>/dev/null
          bytes_written=$(( bytes_written + size_mb * 1024 * 1024 ))
          ;;
      3)  # File churn: create then delete (simulates temp/swap activity)
          local filepath="$dir/churn_${file_num}.tmp"
          local size_mb=$(( RANDOM % 64 + 8 ))
          dd if=/dev/urandom of="$filepath" bs=1M count="$size_mb" \
             conv=fsync status=none 2>/dev/null
          bytes_written=$(( bytes_written + size_mb * 1024 * 1024 ))
          rm -f "$filepath"
          ;;
    esac

    # Periodic progress report per worker
    if (( file_num % 10 == 0 )); then
      local written_gb
      written_gb=$(echo "scale=2; $bytes_written / 1073741824" | bc)
      log "  [Worker $id] files=$file_num written=${written_gb}GB"
    fi
  done

  log "  [Worker $id] DONE – wrote $(echo "scale=2; $bytes_written / 1073741824" | bc) GB"
}

# ── Launch parallel workers ───────────────────────────────────────────────────
log "Starting $THREADS worker threads..."
PIDS=()
for i in $(seq 1 "$THREADS"); do
  worker "$i" &
  PIDS+=($!)
  log "  Launched worker $i (PID $!)"
done

# ── Progress monitor ──────────────────────────────────────────────────────────
log "Monitoring disk usage every 30 seconds..."
while [[ $(date +%s) -lt $END_TIME ]]; do
  sleep 30
  [[ $(date +%s) -ge $END_TIME ]] && break
  USED=$(du -sh "$IO_BASE_DIR" 2>/dev/null | awk '{print $1}')
  REMAINING=$(( END_TIME - $(date +%s) ))
  log "  [Monitor] dir size=$USED | remaining=${REMAINING}s"
done

# ── Wait for workers ──────────────────────────────────────────────────────────
log "Time limit reached – waiting for workers to finish..."
for pid in "${PIDS[@]}"; do
  wait "$pid" 2>/dev/null || true
done

TOTAL_WRITTEN=$(du -sh "$IO_BASE_DIR" 2>/dev/null | awk '{print $1}')
log "====================================================="
log " All workers complete. Total written: $TOTAL_WRITTEN"
log "====================================================="
