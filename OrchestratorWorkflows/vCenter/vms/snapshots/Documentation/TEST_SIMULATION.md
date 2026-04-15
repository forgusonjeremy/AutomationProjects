# Simulated Test Run Results
## Adaptive Snapshot Cleanup — vRO Desk-Check (Pre-Import Validation)
## Generated against: VCF 9.0.2 / vRO 8.17.x / vcenter.corp.local

---

## Test environment assumptions
- 2 vCenter connections registered: vcenter.corp.local, vcenter2.corp.local (hypothetical)
- 4 VMs with snapshots in scope:
  - vm-prod-01 (poweredOn)  — 3 snapshots: "Daily-Backup" (age 2min), "TEST-SAFE-TO-DELETE" (age 10min), "Weekly" (age 5min, desc="protected baseline")
  - vm-prod-02 (poweredOn)  — 1 snapshot: "test-snapshot" (age 45min)
  - vm-dev-01  (poweredOff) — 2 snapshots: "Before-Upgrade" (age 120min), "Post-config" (age 8min, desc="do not delete: PROD migration pending")
  - vm-db-01   (poweredOn)  — 1 snapshot: "Pre-patch" (age 3min) — VM datastore at 28ms latency baseline

---

## TEST 1 — Dry-run validation
**Inputs:** dryRun=true, maxAgeMinutes=5, nameMatchString="", descIgnoreString=""

### Execution trace

```
[LOCK CHECK]
  runLock = "" → CLEAR → acquired "SCR-2025-01-15T02-00-00"

[ENUMERATE]
  vcenter.corp.local → 4 VMs scanned
  vcenter2.corp.local → 0 VMs with snapshots

[FILTER — maxAgeMinutes=5, no name/desc filters]
  vm-prod-01 / "Daily-Backup"         age=2min  → EXCLUDE (too new, 2 < 5)
  vm-prod-01 / "TEST-SAFE-TO-DELETE"  age=10min → INCLUDE ✓
  vm-prod-01 / "Weekly"               age=5min  → INCLUDE ✓  (desc="protected baseline" — descIgnoreString="" so NOT checked)
  vm-prod-02 / "test-snapshot"        age=45min → INCLUDE ✓
  vm-dev-01  / "Before-Upgrade"       age=120min→ INCLUDE ✓
  vm-dev-01  / "Post-config"          age=8min  → INCLUDE ✓
  vm-db-01   / "Pre-patch"            age=3min  → EXCLUDE (too new, 3 < 5)

[CHAIN ORDER SORT]
  "Weekly" is parent of "TEST-SAFE-TO-DELETE" — child sorted first
  Result order: TEST-SAFE-TO-DELETE, Weekly, test-snapshot, Post-config, Before-Upgrade

[LANE SPLIT]
  Powered-on  lane: TEST-SAFE-TO-DELETE, Weekly, test-snapshot (3 items)
  Powered-off lane: Post-config, Before-Upgrade              (2 items)

[DRY-RUN EXECUTION — no governor checks in dry-run mode]
  → [DRY-RUN] vm=vm-prod-01 snap=TEST-SAFE-TO-DELETE age=10min
  → [DRY-RUN] vm=vm-prod-01 snap=Weekly age=5min
  → [DRY-RUN] vm=vm-prod-02 snap=test-snapshot age=45min
  → [DRY-RUN] vm=vm-dev-01  snap=Post-config age=8min
  → [DRY-RUN] vm=vm-dev-01  snap=Before-Upgrade age=120min

[LOG FILE WRITTEN]
  /mnt/vro-logs/snapshot-cleanup/snapshot-cleanup_SCR-2025-01-15T02-00-00_DRYRUN.json
  entries=5 action=dry_run

[LOCK RELEASED]
  runLock = ""
```

**Result: PASS ✓** All 5 eligible snapshots reported. No deletions. Lock released.

---

## TEST 2 — Name filter (whitelist)
**Inputs:** dryRun=true, maxAgeMinutes=1, nameMatchString="test", descIgnoreString=""

### Execution trace

```
[FILTER — maxAgeMinutes=1, nameMatchString="test"]
  vm-prod-01 / "Daily-Backup"         age=2min  → EXCLUDE (name "daily-backup" does not contain "test")
  vm-prod-01 / "TEST-SAFE-TO-DELETE"  age=10min → INCLUDE ✓ ("test-safe-to-delete".indexOf("test") = 0)
  vm-prod-01 / "Weekly"               age=5min  → EXCLUDE (name does not contain "test")
  vm-prod-02 / "test-snapshot"        age=45min → INCLUDE ✓ ("test-snapshot".indexOf("test") = 0)
  vm-dev-01  / "Before-Upgrade"       age=120min→ EXCLUDE
  vm-dev-01  / "Post-config"          age=8min  → EXCLUDE
  vm-db-01   / "Pre-patch"            age=3min  → EXCLUDE
```

**Result: PASS ✓** Only 2 "test"-named snapshots appear. No false positives.

---

## TEST 3 — Description ignore filter
**Inputs:** dryRun=true, maxAgeMinutes=1, nameMatchString="", descIgnoreString="protected"

### Execution trace

```
[FILTER — descIgnoreString="protected"]
  vm-prod-01 / "Weekly"  desc="protected baseline"
    → "protected baseline".indexOf("protected") = 0 → SKIP THIS SNAPSHOT ONLY
    → Continue to children of "Weekly" (none exist)
    → Continue to other snapshots on vm-prod-01

  vm-dev-01 / "Post-config"  desc="do not delete: PROD migration pending"
    → "do not delete: prod migration pending".indexOf("protected") = -1 → NOT matched → included
    NOTE: descIgnoreString="protected" does NOT match "do not delete" — correctly included

[LOG]
  vm-prod-01 / "Weekly" → action=skipped, skipReason="description contains ignore string"
```

**Result: PASS ✓** "Weekly" snapshot correctly skipped. vm continues to be processed (other snapshots not affected). "Post-config" correctly NOT skipped (description does not contain "protected").

---

## TEST 4 — Real deletion (single targeted snapshot)
**Inputs:** dryRun=false, maxAgeMinutes=5, nameMatchString="TEST-SAFE-TO-DELETE", descIgnoreString=""

### Execution trace

```
[FILTER] → 1 candidate: vm-prod-01 / "TEST-SAFE-TO-DELETE" age=10min

[GOVERNOR — first task, no calibration data]
  → "First task — no calibration data yet, proceeding"
  → approved=true

[SAFETY CHECKS on vm-prod-01]
  → config.template = false ✓
  → activeTasks = [] (none running) ✓
  → host connection state = "connected" ✓
  → snapshot still exists in tree ✓

[PRE-METRICS SAMPLE]
  → datastore: datastore-001 (VMFS)
  → readLatencyMs=8.2, writeLatencyMs=11.4, iopsRead=142, iopsWrite=89

[DELETE TASK SUBMITTED]
  → vm-prod-01.snapshot.removeSnapshot_Task("TEST-SAFE-TO-DELETE", removeChildren=false)
  → task state: running
  → wait 5s... task state: running
  → wait 5s... task state: success ✓

[SETTLE WAIT: 10s]

[POST-METRICS SAMPLE]
  → readLatencyMs=14.7, writeLatencyMs=19.2, iopsRead=198, iopsWrite=156
  → delta: readLat +6.5ms, writeLat +7.8ms

[GOVERNOR CALIBRATION UPDATE]
  datastoreState["datastore-001"].lastPre  = { readLatencyMs: 8.2, writeLatencyMs: 11.4 }
  datastoreState["datastore-001"].lastPost = { readLatencyMs: 14.7, writeLatencyMs: 19.2 }

[LOG ENTRY]
  action=deleted, success=true, durationMs=17842
```

**Result: PASS ✓** Snapshot deleted. Governor calibrated with +6.5/+7.8ms delta for next task.

---

## TEST 5 — Mutex lock (concurrent run protection)
**Scenario:** Run A starts, Run B triggered 3 seconds later

### Execution trace

```
[RUN A - T+0s]
  runLock = "" → CLEAR → acquired "SCR-2025-01-15T02-00-00"
  ... processing ...

[RUN B - T+3s]
  runLock = "SCR-2025-01-15T02-00-00" → HELD
  → ABORT: "Another run is active (lock held by: SCR-2025-01-15T02-00-00). Aborting new run SCR-2025-01-15T02-00-03"
  → Workflow exits with error (expected behaviour)
  → No deletions performed by Run B ✓

[RUN A - continues]
  ... completes normally ...
  runLock = "" (released)
```

**Result: PASS ✓** Run B correctly aborted. No double-processing of snapshots.

---

## TEST 6 — Governor under synthetic load
**Scenario:** vm-db-01 datastore at 28ms baseline. threshold=30ms. Previous consolidation delta was +8ms read, +9ms write.

### Governor check calculation

```
[CURRENT METRICS — datastore-db-001 (VMFS)]
  readLatencyMs  = 28.0
  writeLatencyMs = 25.0

[CALIBRATION DELTA from previous task on this datastore]
  readDelta  = postRead(36.5)  - preRead(14.2)  = +22.3ms
  writeDelta = postWrite(33.1) - preWrite(12.4) = +20.7ms
  (These are clamped to max(0, delta) — only positive impacts counted)

[PROJECTION]
  projectedRead  = 28.0 + 22.3 = 50.3ms  → EXCEEDS threshold 30ms
  projectedWrite = 25.0 + 20.7 = 45.7ms  → EXCEEDS threshold 30ms

[DECISION]
  approved = false
  reason = "Projected latency (R:50ms W:46ms) exceeds threshold 30ms on datastore-db-001"

[GOVERNOR HOLD — poll every 30s]
  Attempt 1: current=28ms/25ms → projected 50/46ms → HOLD
  Attempt 2: current=22ms/19ms → projected 44/40ms → HOLD
  Attempt 3: current=14ms/11ms → projected 36/32ms → HOLD
  Attempt 4: current=7ms/6ms   → projected 29/27ms → APPROVE ✓

[PROCEED]
  vm-db-01 / "Pre-patch" — governor approved after 90s wait
```

**Result: PASS ✓** Governor correctly held consolidation during elevated I/O. Proceeded only when projected latency would stay within threshold. Predicted wait: ~90 seconds (3 poll cycles).

---

## Edge case validation

### EC-1: Snapshot no longer exists when task starts
**Scenario:** Snapshot deleted by another process between inventory scan and deletion task
```
findSnapshotByMoRef() returns null
→ result.skipped = true
→ skipReason = "Snapshot no longer exists (already deleted or consolidated)"
→ logged, no error thrown, workflow continues
```
**Result: PASS ✓**

### EC-2: vMotion active on VM
**Scenario:** VM is being live-migrated when cleanup attempts deletion
```
activeTasks scan finds task with descriptionId containing "migrate"
→ taskState = "running"
→ result.skipped = true
→ skipReason = "Conflicting task active on VM (vim.event.TaskEvent.drsMigrateTask)"
→ logged, workflow continues to next candidate
```
**Result: PASS ✓**

### EC-3: vCenter connection lost mid-run
**Scenario:** vcenter.corp.local becomes unreachable after inventory scan
```
deleteSnapshot() call throws VcConnection exception
→ caught by try/catch in deleteSnapshot action
→ result.error = "Connection to vcenter.corp.local lost: ..."
→ logEntry action=error
→ runLog entry written
→ Workflow continues to remaining candidates on other vCenters
→ Lock released in writeAndRelease()
```
**Result: PASS ✓** — Single vCenter failure does not abort entire run.

### EC-4: Child snapshot protected by description filter, parent eligible
**Scenario:** "Weekly" (parent, age=30min) is eligible. Child "Daily" (age=5min) has desc="protected".
```
walkSnapshots processing order:
  "Daily" — desc match → SKIP (this snapshot only), walk children of Daily (none)
  "Weekly" — no desc match → INCLUDE

Chain sort: "Daily" would normally come before "Weekly" (child-first)
  BUT "Daily" was excluded at filter stage
  So only "Weekly" is in candidates list

deleteSnapshot("Weekly") with removeChildren=false
  → Only removes "Weekly" snapshot record
  → vCenter consolidates "Weekly" delta back into base disk
  → "Daily" snapshot (child) is now orphaned — vCenter handles this by
     reparenting "Daily" to the base disk
  NOTE: This is correct vSphere behaviour — removing a parent with removeChildren=false
        causes vCenter to re-parent the child to the grandparent (base disk in this case)
```
**Result: PASS ✓** — Protected child survives. Parent removed. vCenter handles reparenting.

### EC-5: Workflow abnormal exit — lock stuck
**Scenario:** vRO appliance OOM-killed during run. runLock = "SCR-2025-01-15T02-00-00" persists.
```
Next scheduled run:
  runLock = "SCR-2025-01-15T02-00-00" → HELD → ABORT

Operator action required:
  vRO client > Configuration > SnapshotCleanup > RuntimeState
  Set runLock = ""
  Save
  Next run will proceed normally
```
**Result: DOCUMENTED** — Covered in operational runbook. No automated resolution (intentional — lock exists to protect production).
