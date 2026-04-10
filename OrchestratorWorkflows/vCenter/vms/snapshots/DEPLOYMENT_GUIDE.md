# Adaptive Snapshot Cleanup — Deployment & Operations Guide
## VCF 9.0.2 / Embedded vRO 8.17.x

---

## Package contents

| File | Purpose |
|---|---|
| `actions/getSnapshotCandidates.js` | Enumerates VMs and filters snapshot candidates for one vCenter |
| `actions/getDatastoreMetrics.js` | Samples I/O metrics — auto-detects vSAN vs VMFS/NFS |
| `actions/adaptiveGovernorCheck.js` | I/O governor decision engine — projects impact before allowing next task |
| `actions/deleteSnapshot.js` | Executes a single snapshot deletion with pre/post metric capture |
| `actions/writeLogFile.js` | Writes JSON or CSV log to NFS or SMB share |
| `workflow/mainOrchestration.js` | Primary workflow scriptable task — orchestration engine |
| `config/configurationElements.xml` | Reference for all required configuration element attributes |

---

## Prerequisites

### vRO service account permissions
The account used by vRO's vCenter connection requires these vSphere privileges:

| Privilege | Reason |
|---|---|
| `VirtualMachine.Snapshot.RemoveSnapshot` | Delete snapshots |
| `VirtualMachine.Snapshot.Manage` | Enumerate snapshot trees |
| `VirtualMachine.Interact.Pause` | Not required but recommended for HA-aware skipping |
| `Global.Diagnostics` | Read performance manager data |
| `Performance.ModifyIntervals` | May be needed for custom perf intervals |
| `Datastore.Browse` | Enumerate datastore inventory |

Assign at the **vCenter root** level with propagation enabled so all clusters, datastores, and VMs are covered.

### vRO appliance — network share mounts
The workflow writes logs via the vRO appliance filesystem. The share must be mounted at the OS level **before** the workflow runs.

**NFS mount (persistent — add to /etc/fstab on vRO appliance):**
```bash
# SSH to vRO appliance as root
mkdir -p /mnt/vro-logs/snapshot-cleanup
echo "nfsserver.corp.local:/exports/vro-logs  /mnt/vro-logs  nfs  defaults,_netdev  0 0" >> /etc/fstab
mount -a
# Verify
ls /mnt/vro-logs/snapshot-cleanup
```

**SMB/CIFS mount (persistent):**
```bash
mkdir -p /mnt/smb-logs/snapshot-cleanup
# Install cifs-utils if not present (VCF 9 vRO appliance is SLES-based)
zypper install cifs-utils
echo "//fileserver.corp.local/share  /mnt/smb-logs  cifs  credentials=/etc/vro-smb-creds,_netdev  0 0" >> /etc/fstab
# Create credentials file (chmod 600)
cat > /etc/vro-smb-creds << EOF
username=svc-vro-logs
password=YOUR_PASSWORD
domain=CORP
EOF
chmod 600 /etc/vro-smb-creds
mount -a
```

---

## Step 1 — Create the vRO Action module

In vRO client (or via API):

1. Navigate to **Design > Actions**
2. Create module: `com.company.snapshotcleanup`
3. Create one Action per `.js` file in the `actions/` folder
4. Action names must match exactly:
   - `getSnapshotCandidates`
   - `getDatastoreMetrics`
   - `adaptiveGovernorCheck`
   - `deleteSnapshot`
   - `writeLogFile`
5. Paste the corresponding `.js` file content into each action's script body
6. Set input parameters for each action as documented in the file headers
7. Set return type to `string` for all actions (they return JSON strings)

---

## Step 2 — Create Configuration Elements

1. Navigate to **Design > Configuration**
2. Create category: `SnapshotCleanup`
3. Create three configuration elements inside it:
   - `RuntimeState` — add attribute `runLock` (string, default empty), `lastRunId` (string), `lastRunCompletedAt` (string)
   - `FileLogging` — add all attributes per `configurationElements.xml`
   - `Thresholds` — add all attributes per `configurationElements.xml`
4. Set your actual values (share paths, passwords, thresholds)

**Critical:** The `runLock` attribute in `RuntimeState` must start as an empty string. If a workflow run aborts abnormally without releasing the lock, clear it manually here.

---

## Step 3 — Create the Workflow

Create a new workflow: **"Adaptive Snapshot Cleanup — Multi-vCenter"**

### Input form (Workflow > Inputs tab)

| Name | Type | Default | Label |
|---|---|---|---|
| `maxAgeMinutes` | number | `60` | Max snapshot age (minutes) |
| `nameMatchString` | string | `` | Snapshot name must contain (leave blank = all) |
| `descIgnoreString` | string | `` | Skip if description contains |
| `dryRun` | boolean | `true` | Dry-run only (no deletions) |
| `latencyThresholdMs` | number | `30` | VMFS/NFS latency ceiling (ms) |
| `vsanCongestionThresh` | number | `50` | vSAN congestion ceiling (0-255) |
| `vsanResyncThresholdGB` | number | `10` | vSAN resync queue ceiling (GB) |
| `maxParallelPerVcenter` | number | `3` | Max parallel tasks per vCenter |
| `governorPollIntervalSec` | number | `30` | Governor poll interval (seconds) |
| `taskTimeoutSeconds` | number | `1800` | Per-task timeout (seconds) |

**Important:** `dryRun` defaults to `true`. The operator must explicitly set it to `false` to perform real deletions. This is intentional.

### Workflow canvas

1. Add a single **Scriptable Task** element
2. Bind all workflow inputs to the scriptable task inputs with the same names
3. Paste the entire content of `workflow/mainOrchestration.js` as the script body
4. Add an **Exception Handler** on the scriptable task — bind to an error output attribute
5. The exception handler should also attempt lock release:
   ```javascript
   // Exception handler scriptable task
   try {
       var cat = Server.getConfigurationElementCategoryWithPath("SnapshotCleanup");
       var els = cat.configurationElements;
       for each (var el in els) {
           if (el.name === "RuntimeState") {
               el.setAttributeWithKey("runLock", "");
               System.warn("Lock force-released by exception handler");
               break;
           }
       }
   } catch(e) { System.error("Exception handler lock release failed: " + e.message); }
   ```

---

## Step 4 — Configure Scheduling

1. Navigate to the workflow, click **Schedule**
2. Click **Add Schedule**
3. Configure recurrence (e.g. daily at 02:00)
4. Set default input values for the scheduled run:
   - `dryRun = false` (after you've validated with dry-run)
   - `maxAgeMinutes = 10080` (7 days) or your chosen production value
   - `nameMatchString = ` (empty unless you want to target specific snapshots)
5. The scheduled run will abort automatically if a previous run is still active (mutex)

---

## Test Plan

### Test 1 — Dry-run validation (run this first, always)
**Inputs:** `dryRun=true`, `maxAgeMinutes=5`, `nameMatchString=`, `descIgnoreString=`
**Expected:** Workflow log shows `[DRY-RUN]` entries for all snapshots older than 5 min. Log file written to share. No snapshots deleted. Lock released cleanly.

### Test 2 — Name filter
**Inputs:** `dryRun=true`, `maxAgeMinutes=1`, `nameMatchString=test`, `descIgnoreString=`
**Expected:** Only snapshots whose name contains "test" (case-insensitive) appear in log.

### Test 3 — Description ignore
**Create** a test snapshot with description containing "protected"
**Inputs:** `dryRun=true`, `maxAgeMinutes=1`, `descIgnoreString=protected`
**Expected:** That snapshot appears in log with `action=skipped` or is absent entirely.

### Test 4 — Real deletion (single VM, test environment)
**Inputs:** `dryRun=false`, `maxAgeMinutes=5`, `nameMatchString=TEST-SAFE-TO-DELETE`
**Expected:** Snapshot deleted, consolidation task appears in vCenter Tasks, post-deletion log entry shows `action=deleted`.

### Test 5 — Mutex lock (concurrent run protection)
**Trigger** two runs within seconds of each other (use Run + Schedule or two browser tabs)
**Expected:** First run acquires lock. Second run logs "ABORT: Another run is active" and exits cleanly without deleting anything.

### Test 6 — Governor under load (if test environment allows)
**Saturate a datastore** with a synthetic I/O load (IOMeter, vdbench)
**Trigger** cleanup on VMs on that datastore
**Expected:** Governor HOLD entries in log. Cleanup waits for I/O to subside, then proceeds.

---

## Threshold tuning guide

| Environment | VMFS/NFS latency threshold | vSAN congestion | Notes |
|---|---|---|---|
| Very sensitive production | 15ms | 30 | Conservative — will hold more often |
| Standard production | 30ms | 50 | Default — suitable for most environments |
| Less sensitive / dev | 60ms | 80 | More aggressive, faster cleanup |
| All-flash VMFS | 10ms | n/a | Flash latency baseline is very low |

Monitor your baseline datastore latency in vCenter Performance charts **before your first real run** to calibrate appropriate thresholds. If your idle latency is already 20ms, a 30ms threshold will almost immediately block.

---

## Operational runbook

### Clearing a stuck lock
If the workflow exits abnormally (vRO restart, out-of-memory, network loss to vCenter):
1. In vRO client: Design > Configuration > SnapshotCleanup > RuntimeState
2. Set `runLock` attribute value to empty string
3. Save

### Investigating a run
1. Check vRO workflow execution log (Runs tab on the workflow)
2. Open the log file on the share — filename format: `snapshot-cleanup_SCR-YYYY-MM-DDTHH-MM-SS_[DRYRUN].json`
3. Filter by `"action": "error"` in the JSON to find failures
4. Filter by `"action": "deferred"` to see snapshots the governor could not clear this run

### Adding a new vCenter
1. Add the vCenter SDK connection in vRO (Administration > vCenter Server)
2. No workflow changes required — `VcPlugin.allSdkConnections` discovers all registered connections automatically

### Governor is always blocking — tuning steps
1. Check baseline latency in vCenter for the affected datastore (last 24h average)
2. If baseline > threshold, raise `latencyThresholdMs` in the Thresholds config element
3. Consider running cleanup during off-peak hours via the scheduler
4. Reduce `maxParallelPerVcenter` to 1 to reduce simultaneous I/O load

---

## Known limitations and future enhancements

| Item | Status |
|---|---|
| True parallel vCenter threads | Current implementation is sequential per-vCenter. Full parallelism requires vRO Parallel workflow element calling a sub-workflow per vCenter — enhancement for next iteration |
| vCenter task queue depth check | Not implemented — VPXD queue saturation is rare at maxParallel=3 but add explicit task queue depth check if running at higher concurrency |
| Email summary notification | Not in current scope — add a `sendEmail` action at the end of writeAndRelease() using vRO's built-in SMTP support |
| Chain-depth limit | Deep snapshot chains (10+) generate proportionally more consolidation I/O than the governor's single-delta model predicts — consider adding chain-depth as an additional governor input |
