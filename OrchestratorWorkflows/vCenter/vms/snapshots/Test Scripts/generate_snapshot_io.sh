#!/bin/bash
# =============================================================================
# generate_snapshot_io.sh
# Purpose : Generate realistic block-level churn for snapshot cleanup testing.
#           Works by repeatedly OVERWRITING a fixed working set rather than
#           growing files — snapshot deltas track changed blocks, not file
#           growth, so this drives meaningful snapshot divergence without
#           filling the disk.
#
# Why snapshot deltas stay small with a small working set:
#   A snapshot delta only grows when a block is written for the FIRST TIME
#   since that snapshot was taken. Re-writing the same block does not grow
#   the delta further. So a small working set gets fully covered quickly and
#   then stops contributing to delta growth. The fix is a large working set
#   so each snapshot interval sees a fresh region of blocks being dirtied.
#
# What this does NOT do:
#   - It does not grow the disk indefinitely
#   - It does not fill free space
#
# What it DOES do:
#   - Pre-allocates a fixed working set (bounded disk usage)
#   - Sweeps sequentially through the working set so every snapshot interval
#     dirties a NEW region of blocks (maximises delta growth per interval)
#   - Also does random writes across the full working set for realism
#   - Flushes to disk so changes are real and visible to the snapshot mechanism
#
# Usage:
#   bash generate_snapshot_io.sh [options]
#
#   Copy to target VM and run as sshuser:
#     scp generate_snapshot_io.sh sshuser@<vm-ip>:~
#     ssh sshuser@<vm-ip> "bash ~/generate_snapshot_io.sh"
#
# Options:
#   --dir         Working directory        (default: ~/snapshot_io_test)
#   --working-set Size of fixed data in MB (default: 4096)
#   --duration    How long to run, seconds (default: 300)
#   --threads     Parallel churn workers   (default: 4)
# =============================================================================

set -euo pipefail

# ── Defaults ─────────────────────────────────────────────────────────────────
IO_DIR="${HOME}/snapshot_io_test"
WORKING_SET_MB=4096   # 4GB working set — large enough that a 3-min snapshot
                      # interval can't cover it all, so deltas keep growing.
                      # Reduce if disk space is tight, but stay above 1GB.
DURATION=300
THREADS=4
LOG_FILE="${HOME}/snapshot_io_test.log"

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
[[ $PER_THREAD_MB -lt 256 ]] && PER_THREAD_MB=256

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
log " Per thread    : ${PER_THREAD_MB} MB"
log " Duration      : ${DURATION}s"
log " Threads       : $THREADS"
log "====================================================="
log " Disk usage before: $(df -h "$IO_DIR" | awk 'NR==2{print $3 " used, " $4 " free"}')"
log ""

# ── Check available disk space ───────────────────────────────────────────────
AVAIL_MB=$(df -m "$IO_DIR" | awk 'NR==2{print $4}')
NEEDED_MB=$(( WORKING_SET_MB + 256 ))  # working set + headroom
if [[ $AVAIL_MB -lt $NEEDED_MB ]]; then
  log "ERROR: Need ~${NEEDED_MB}MB free but only ${AVAIL_MB}MB available."
  log "       Reduce --working-set or free up disk space."
  exit 1
fi
log " Available disk: ${AVAIL_MB}MB — OK (need ${NEEDED_MB}MB)"
log ""

# ── Worker: sequential sweep + random overwrite ──────────────────────────────
# KEY INSIGHT: Sequential sweep ensures every snapshot interval covers a fresh
# region of blocks. A random-only strategy tends to re-hit the same blocks,
# which doesn't grow the delta after the first hit.
#
# Strategy:
#   Phase 1 — Sequential sweep: write through the entire file start-to-end
#              using large blocks. This maximises new blocks dirtied per second.
#   Phase 2 — Random overwrite: scatter writes across the full address space
#              to simulate realistic mixed workload between sweeps.
#   Repeat until duration expires.
large_file_worker() {
  local id="$1"
  local dir="$IO_DIR/worker_${id}"
  mkdir -p "$dir"

  local file="$dir/workingset.dat"
  local size_mb="$PER_THREAD_MB"
  local total_bytes=$(( size_mb * 1024 * 1024 ))

  # Pre-allocate with zeros (fast, uses fallocate if available)
  log "  [Worker $id] Allocating ${size_mb}MB working file..."
  if command -v fallocate &>/dev/null; then
    fallocate -l "${size_mb}M" "$file" 2>/dev/null || \
      dd if=/dev/zero of="$file" bs=1M count="$size_mb" conv=fsync status=none 2>/dev/null
  else
    dd if=/dev/zero of="$file" bs=1M count="$size_mb" conv=fsync status=none 2>/dev/null
  fi
  log "  [Worker $id] Ready — starting sweep/churn loop"

  # Block sizes: large for sequential sweep, medium for random
  local sweep_bs=$(( 1024 * 1024 ))      # 1MB blocks for sequential sweep
  local random_bs=$(( 256 * 1024 ))      # 256k blocks for random writes
  local sweep_blocks=$(( total_bytes / sweep_bs ))
  local random_blocks=$(( total_bytes / random_bs ))

  local pass=0
  while [[ $(date +%s) -lt $END_TIME ]]; do
    pass=$(( pass + 1 ))

    # ── Phase 1: Sequential sweep through entire file ──
    # This is the primary delta-growth driver — every block in the file
    # gets dirtied once per sweep, guaranteeing maximum delta growth.
    log "  [Worker $id] Pass $pass — sequential sweep (${size_mb}MB)..."
    local block=0
    while [[ $block -lt $sweep_blocks ]] && [[ $(date +%s) -lt $END_TIME ]]; do
      # Write 64MB at a time to keep syscall overhead low
      local batch=$(( sweep_blocks - block ))
      [[ $batch -gt 64 ]] && batch=64
      dd if=/dev/urandom of="$file" bs="$sweep_bs" count="$batch" \
         seek="$block" conv=notrunc status=none 2>/dev/null
      block=$(( block + batch ))
    done
    # Flush after sweep
    sync "$file" 2>/dev/null || true

    [[ $(date +%s) -ge $END_TIME ]] && break

    # ── Phase 2: Random scatter writes across full address space ──
    # Simulates realistic mixed workload (db page writes, app I/O).
    # Duration: ~20% of a sweep pass worth of I/O.
    local random_ops=$(( random_blocks / 5 ))
    local rand_done=0
    while [[ $rand_done -lt $random_ops ]] && [[ $(date +%s) -lt $END_TIME ]]; do
      local max_seek=$(( random_blocks - 1 ))
      local seek_pos=$(( (RANDOM * RANDOM) % max_seek ))
      # Write 4 blocks at a time
      local wcnt=4
      [[ $(( seek_pos + wcnt )) -gt $random_blocks ]] && wcnt=1
      dd if=/dev/urandom of="$file" bs="$random_bs" count="$wcnt" \
         seek="$seek_pos" conv=notrunc,fsync status=none 2>/dev/null
      rand_done=$(( rand_done + wcnt ))
    done

    log "  [Worker $id] Pass $pass complete"
  done

  log "  [Worker $id] Done — $pass full passes"
}

# ── Worker: small-file metadata churn ────────────────────────────────────────
# Fixed pool of small files — bounded disk cost regardless of duration.
# Generates inode/metadata changes which contribute to snapshot delta on VMFS.
metadata_worker() {
  local dir="$IO_DIR/metadata"
  mkdir -p "$dir"

  local pool_size=64          # larger pool = more unique blocks touched
  local file_size_kb=512

  log "  [Metadata worker] Creating ${pool_size}-file pool..."
  for i in $(seq 1 "$pool_size"); do
    dd if=/dev/zero of="$dir/pool_${i}.dat" bs=1k count="$file_size_kb" \
       conv=fsync status=none 2>/dev/null
  done
  log "  [Metadata worker] Ready"

  local op=0
  while [[ $(date +%s) -lt $END_TIME ]]; do
    op=$(( op + 1 ))
    local idx=$(( (RANDOM % pool_size) + 1 ))
    local file="$dir/pool_${idx}.dat"
    local pattern=$(( op % 4 ))

    case $pattern in
      0)  echo "churn_op_${op}_$(date +%N)" >> "$file"
          truncate -s "${file_size_kb}k" "$file"
          sync "$file" 2>/dev/null || true
          ;;
      1)  local fsize=$(( file_size_kb * 1024 ))
          local offset=$(( (RANDOM % (fsize / 4096)) * 4096 ))
          dd if=/dev/urandom of="$file" bs=4096 count=1 \
             seek=$(( offset / 4096 )) conv=notrunc,fsync status=none 2>/dev/null
          ;;
      2)  local tmp="$dir/pool_${idx}.tmp"
          cp "$file" "$tmp"
          mv "$tmp" "$file"
          ;;
      3)  dd if=/dev/urandom of="$file" bs=1k count="$file_size_kb" \
             conv=notrunc,fsync status=none 2>/dev/null
          ;;
    esac
  done

  log "  [Metadata worker] Done — $op operations"
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

for i in $(seq 1 "$THREADS"); do
  large_file_worker "$i" &
  PIDS+=($!)
done

metadata_worker &
PIDS+=($!)

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