#!/bin/bash
# =============================================================================
# generate_datastore_latency.sh
# Purpose : Push datastore I/O latency to high levels to trigger the
#           adaptergovernercheck action code in your VMware/storage stack.
#           Uses fio (preferred) or falls back to dd for raw throughput stress.
# Target  : CentOS 7/8/Stream
# Usage:
#   bash generate_datastore_latency.sh [options]
#
#   Copy to target VM and run as sshuser:
#     scp generate_datastore_latency.sh sshuser@<vm-ip>:~
#     ssh sshuser@<vm-ip> "bash ~/generate_datastore_latency.sh"
#
# Options:
#   --dir        Working directory          (default: ~/latency_test)
#   --duration   <seconds>                  (default: 600)
#   --workers    <N>                        (default: 8, use 16+ for high lat.)
#   --mode       [fio|dd|mixed]             (default: auto-detect fio)
#   --iodepth    <N>                        (fio: queue depth, default: 32)
#   --aggressive                            (enable extra pressure: fsync loops)
# =============================================================================

set -u

# ── Defaults ─────────────────────────────────────────────────────────────────
IO_DIR="${HOME}/latency_test"
DURATION=600
WORKERS=8
MODE="auto"
IODEPTH=32
AGGRESSIVE=false
LOG_FILE="${HOME}/latency_test.log"
FIO_RESULTS="${HOME}/latency_fio_results.json"

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)        IO_DIR="$2";      shift 2 ;;
    --duration)   DURATION="$2";    shift 2 ;;
    --workers)    WORKERS="$2";     shift 2 ;;
    --mode)       MODE="$2";        shift 2 ;;
    --iodepth)    IODEPTH="$2";     shift 2 ;;
    --aggressive) AGGRESSIVE=true;  shift   ;;
    --help|-h)
      grep '^# Usage\|^#   --' "$0" | sed 's/^# //'
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ── Setup ─────────────────────────────────────────────────────────────────────
mkdir -p "$IO_DIR"
echo "" > "$LOG_FILE"

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

cleanup() {
  log "Caught signal – terminating all workers..."
  kill 0 2>/dev/null || true
  wait 2>/dev/null || true
  log "Removing test files from $IO_DIR ..."
  rm -rf "$IO_DIR"
  log "Cleanup complete."
}
trap cleanup INT TERM EXIT

# ── Detect fio ────────────────────────────────────────────────────────────────
FIO_BIN=""
if command -v fio &>/dev/null; then
  FIO_BIN="fio"
elif [[ "$MODE" == "fio" ]]; then
  log "ERROR: fio not found. Install with: yum install -y fio"
  exit 1
fi

if [[ "$MODE" == "auto" ]]; then
  [[ -n "$FIO_BIN" ]] && MODE="fio" || MODE="dd"
fi

log "====================================================="
log " Datastore Latency Stress Test"
log " (adaptergovernercheck trigger)"
log "====================================================="
log " Target dir    : $IO_DIR"
log " Duration      : ${DURATION}s"
log " Mode          : $MODE"
log " Workers       : $WORKERS"
log " I/O depth     : $IODEPTH (fio only)"
log " Aggressive    : $AGGRESSIVE"
log " Log           : $LOG_FILE"
log "====================================================="

# ─────────────────────────────────────────────────────────────────────────────
# MODE: fio  — Best for hitting high queue depths & realistic latency numbers
# ─────────────────────────────────────────────────────────────────────────────
run_fio() {
  log "Running fio: mixed random read/write, iodepth=$IODEPTH, ${WORKERS} jobs"

  # Pre-create a backing file (prevents thin-provision allocation skewing first run)
  local backing="$IO_DIR/fio_backing.dat"
  log "Pre-allocating 4GB backing file (fallocate)..."
  fallocate -l 4G "$backing" 2>/dev/null || \
    dd if=/dev/zero of="$backing" bs=1M count=4096 status=none

  fio \
    --name="datastore_latency_stress" \
    --filename="$backing" \
    --rw=randrw \
    --rwmixread=30 \
    --bs=4k \
    --iodepth="$IODEPTH" \
    --numjobs="$WORKERS" \
    --runtime="$DURATION" \
    --time_based \
    --group_reporting \
    --direct=1 \
    --ioengine=libaio \
    --fsync_on_close=1 \
    --randrepeat=0 \
    --norandommap \
    --output-format=json \
    --output="$FIO_RESULTS" \
    --lat_percentiles=1 \
    --clat_percentiles=1 \
    2>&1 | tee -a "$LOG_FILE" &

  FIO_PID=$!

  # Supplemental: parallel metadata thrashing (directory + rename ops)
  # This is what really drives latency on VMware datastores
  metadata_thrasher &

  wait $FIO_PID

  # Print key latency results
  if [[ -f "$FIO_RESULTS" ]]; then
    log ""
    log "── fio Results Summary ──────────────────────────────"
    python3 - <<'PYEOF' 2>/dev/null || \
    python - <<'PYEOF' 2>/dev/null || \
    log "  (Install python3 to parse fio JSON results)"
import json, sys
with open('$FIO_RESULTS') as f:
    data = json.load(f)
for job in data.get('jobs', []):
    rw = job.get('mixed', job.get('write', {}))
    rd = job.get('read', {})
    print(f"  Write IOPS   : {rw.get('iops', 0):.0f}")
    print(f"  Write lat avg: {rw.get('lat_ns', {}).get('mean', 0)/1000:.1f} µs")
    print(f"  Write lat p99: {rw.get('clat_ns', {}).get('percentile', {}).get('99.000000', 0)/1000:.1f} µs")
    print(f"  Read  IOPS   : {rd.get('iops', 0):.0f}")
    print(f"  Read  lat avg: {rd.get('lat_ns', {}).get('mean', 0)/1000:.1f} µs")
PYEOF
    log "  Full results: $FIO_RESULTS"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# MODE: dd  — Fallback; pure sequential throughput via parallel dd writers
# ─────────────────────────────────────────────────────────────────────────────
run_dd() {
  log "Running dd-based I/O stress ($WORKERS parallel writers)..."

  local END_TIME=$(( $(date +%s) + DURATION ))
  local PIDS=()

  dd_writer() {
    local id="$1"
    local f="$IO_DIR/dd_writer_${id}.dat"
    while [[ $(date +%s) -lt $END_TIME ]]; do
      # Alternate: sequential write then sync-heavy small-block writes
      dd if=/dev/urandom of="$f" bs=4k count=4096 conv=fsync status=none 2>/dev/null
      dd if=/dev/urandom of="$f" bs=512 count=2048 conv=fsync status=none 2>/dev/null
    done
  }

  for i in $(seq 1 "$WORKERS"); do
    dd_writer "$i" &
    PIDS+=($!)
  done

  metadata_thrasher &

  log "  Waiting ${DURATION}s for dd workers..."
  sleep "$DURATION"

  kill "${PIDS[@]}" 2>/dev/null || true
  for pid in "${PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done
  log "  dd workers done."
}

# ─────────────────────────────────────────────────────────────────────────────
# Metadata thrasher — drives directory ops, renames, and stat() calls
# This type of I/O is disproportionately expensive on VMFS/NFS datastores
# and is very effective at pushing latency metrics.
# ─────────────────────────────────────────────────────────────────────────────
metadata_thrasher() {
  local mdir="$IO_DIR/metadata"
  local END_TIME=$(( $(date +%s) + DURATION ))
  local i=0
  mkdir -p "$mdir"
  log "  [Metadata thrasher] started"
  while [[ $(date +%s) -lt $END_TIME ]]; do
    i=$(( i + 1 ))
    local src="$mdir/file_${i}.tmp"
    local dst="$mdir/file_${i}.dat"
    echo "metadata_payload_${i}_$(date +%N)" > "$src"
    mv "$src" "$dst"
    stat "$dst" >/dev/null 2>&1
    if (( i % 50 == 0 )); then
      find "$mdir" -name '*.dat' -delete 2>/dev/null || true
    fi
  done
  log "  [Metadata thrasher] done after $i operations"
}

# ─────────────────────────────────────────────────────────────────────────────
# Aggressive mode: adds fsync-loop writers and O_SYNC pressure
# Maximises latency visible to storage layer (vSphere perf graphs, ESXTOP)
# ─────────────────────────────────────────────────────────────────────────────
run_aggressive_fsync() {
  local END_TIME=$(( $(date +%s) + DURATION ))
  log "  [Aggressive] Starting fsync-loop writers..."
  for i in $(seq 1 4); do
    (
      local f="$IO_DIR/fsync_${i}.dat"
      while [[ $(date +%s) -lt $END_TIME ]]; do
        # Open file with O_SYNC to force every write through to the datastore
        python3 -c "
import os, time, random
f = open('$f', 'wb', buffering=0)
end = time.time() + 10
while time.time() < end:
    f.write(os.urandom(random.randint(512, 65536)))
    os.fsync(f.fileno())
f.close()
" 2>/dev/null || \
        dd if=/dev/urandom of="$f" bs=4k count=256 conv=fsync,nocreat status=none 2>/dev/null || true
      done
    ) &
  done
}

# ─────────────────────────────────────────────────────────────────────────────
# Latency monitor — polls iostat every 10s and logs device stats
# ─────────────────────────────────────────────────────────────────────────────
latency_monitor() {
  if ! command -v iostat &>/dev/null; then
    log "  [Monitor] iostat not found (yum install sysstat). Skipping device stats."
    return
  fi
  local END_TIME=$(( $(date +%s) + DURATION ))
  log "  [Monitor] Polling device latency every 10s (check $LOG_FILE for detail)"
  while [[ $(date +%s) -lt $END_TIME ]]; do
    sleep 10
    echo "--- $(date '+%H:%M:%S') iostat snapshot ---" >> "$LOG_FILE"
    iostat -xm 1 1 2>/dev/null | grep -E "Device|sd|vd|nvme|dm-" >> "$LOG_FILE" || true
  done
}

# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────
log "Tip: Watch ESXTOP (device latency GAVG/cmd) or vCenter perf charts"
log "     while this runs to confirm the adaptergovernercheck threshold."
log ""

# Start latency monitor in background
latency_monitor &
MONITOR_PID=$!

# Launch aggressive fsync writers if requested
if [[ "$AGGRESSIVE" == "true" ]]; then
  run_aggressive_fsync
fi

# Main I/O mode
case "$MODE" in
  fio)   run_fio   ;;
  dd)    run_dd    ;;
  mixed) run_fio   ;;  # fio already mixes r/w; dd fallback handled above
  *)     log "Unknown mode: $MODE"; exit 1 ;;
esac

kill "$MONITOR_PID" 2>/dev/null || true
wait "$MONITOR_PID" 2>/dev/null || true

log ""
log "====================================================="
log " Latency stress test complete."
log " Full device stats logged to: $LOG_FILE"
[[ -f "$FIO_RESULTS" ]] && log " fio JSON results  : $FIO_RESULTS"
log "====================================================="
