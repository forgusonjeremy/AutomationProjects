# Implementation & Deployment Guide
## Adaptive Snapshot Cleanup — Multi-vCenter
## VCF 9.0.2 / Embedded vRO 8.17.x

---

## Overview

This guide covers the complete implementation sequence for the Adaptive Snapshot
Cleanup workflow. Follow the phases in order — later phases depend on earlier ones.

All audit logging is via the vRO workflow log, ingested by VMware Aria Operations
for Logs. No network share, NFS mount, SMB mount, or file share credentials are
required.

---

## Phase 1 — Environment Preparation

### Step 1: Verify vCenter SDK Connection

1. Log into vRO at `https://<sddc-manager-fqdn>/orchestration-ui`
2. Navigate to Administration > Inventory
3. Expand vSphere vCenter Plugin
4. Confirm `vcenter.corp.local` appears and the inventory tree is browseable
5. Browse to a known VM to confirm read access
6. Repeat for each additional vCenter that should be in scope

### Step 2: Create vRO Service Account

Create a dedicated least-privilege account for this automation.

1. In vCenter, create: `svc-vro-snapclean@vsphere.local` (or a domain account)
2. Create a custom vCenter role with these privileges:

| Privilege | Purpose |
|-----------|---------|
| VirtualMachine.Snapshot.RemoveSnapshot | Delete snapshots |
| VirtualMachine.Snapshot.Manage | Enumerate snapshot trees |
| Global.Diagnostics | Read PerformanceManager data for I/O governor |
| Datastore.Browse | Enumerate datastore inventory |
| System.Read | Read host and cluster runtime state for safety checks |

3. Assign the role at vCenter root level with **Propagate to children** enabled
4. Update the vRO vCenter connection to authenticate as this account

### Step 3: Enable vCenter Performance Statistics

The adaptive I/O governor requires real-time performance data.

1. In vCenter: Administration > vCenter Server Settings > Statistics
2. Set Statistics Level to **1 or higher** for the 20-second real-time interval
3. For vSAN environments: Cluster > Configure > vSAN > Services > Performance Service
   — confirm Performance Service is **Enabled** on each vSAN cluster

---

## Phase 2 — vRO Object Creation

### Step 4: Create the Action Module

1. In vRO: Design > Actions
2. Create module: `com.company.snapshotcleanup`
3. Create four actions, one per delivered `.js` file in the `actions/` folder:

| Action Name             | Return Type | Source File |
|-------------------------|-------------|-------------|
| getSnapshotCandidates   | string      | getSnapshotCandidates.js |
| getDatastoreMetrics     | string      | getDatastoreMetrics.js |
| adaptiveGovernorCheck   | string      | adaptiveGovernorCheck.js |
| deleteSnapshot          | string      | deleteSnapshot.js |

4. For each action: paste the script body, configure input parameters as
   documented in the file header, set return type to `string`
5. Save and confirm no syntax errors

### Step 5: Create Configuration Elements

1. Navigate to: Design > Configuration
2. Create category: `SnapshotCleanup`
3. Create **two** configuration elements inside it:

**SnapshotCleanup/RuntimeState**

| Attribute Name      | Type   | Initial Value | Notes |
|---------------------|--------|---------------|-------|
| runLock             | string | (empty)       | CRITICAL: must be empty string, never null |
| lastRunId           | string | (empty)       | Informational — updated automatically |
| lastRunCompletedAt  | string | (empty)       | Informational — updated automatically |
| lastRunOutcome      | string | (empty)       | Informational — updated automatically |

**SnapshotCleanup/Thresholds**

| Attribute Name          | Type    | Recommended Initial Value |
|-------------------------|---------|---------------------------|
| maxAgeMinutes           | number  | 10080 (7 days)            |
| nameMatchString         | string  | (empty)                   |
| descIgnoreString        | string  | (empty)                   |
| dryRunDefault           | boolean | false                     |
| latencyThresholdMs      | number  | 30                        |
| vsanCongestionThresh    | number  | 50                        |
| vsanResyncThresholdGB   | number  | 10                        |
| maxParallelPerVcenter   | number  | 3                         |
| governorPollIntervalSec | number  | 30                        |
| taskTimeoutSeconds      | number  | 1800                      |

Refer to `configurationElements.xml` for full attribute descriptions and tuning guidance.

### Step 6: Create the Workflow

1. Navigate to Design > Workflows
2. Create: **"Adaptive Snapshot Cleanup — Multi-vCenter"**
3. On the **Inputs** tab, add all 10 input parameters (see VARIABLE_BINDING_REFERENCE.md)
4. Set `dryRun` default to `true`
5. On the **Attributes** tab, add all 13 attributes
6. Build the canvas with 8 scriptable task elements (ST-01 through ST-09,
   skipping ST-08 which does not exist in this solution)
7. Add one Exception Handler element connected from all task error outputs
8. Paste each script file's content into the corresponding task body
9. Configure all input/output bindings per the VARIABLE_BINDING_REFERENCE.md
   binding tables
10. Save and validate

---

## Phase 3 — Validation

### Step 7: Dry-Run Validation (MANDATORY before any live run)

```
maxAgeMinutes    = 5
dryRun           = true
nameMatchString  = (empty)
descIgnoreString = (empty)
```

Expected results:
- vRO execution log shows `[DRY-RUN] Would delete:` entries for eligible snapshots
- Final `Snapshot Cleanup Result` log entry appears with `outcome=DRY_RUN_COMPLETE`
- `deleted=0` in the result entry
- Mutex released (check RuntimeState/runLock = empty after run)

### Step 8: Name Filter Validation

Create a test snapshot named `TEST-CLEANUP-VALIDATE` on any non-critical VM.

```
maxAgeMinutes   = 1
dryRun          = true
nameMatchString = TEST-CLEANUP-VALIDATE
```

Expected: only the test snapshot appears in `[DRY-RUN]` log entries.

### Step 9: Description Filter Validation

Create a test snapshot with description containing `protected`.

```
maxAgeMinutes    = 1
dryRun           = true
descIgnoreString = protected
```

Expected: that snapshot appears as `SKIP (desc match)` in the workflow log.

### Step 10: First Live Deletion (Controlled)

Create a disposable test snapshot named `TEST-SAFE-TO-DELETE` on a
non-critical powered-off VM.

```
maxAgeMinutes   = 5
dryRun          = false
nameMatchString = TEST-SAFE-TO-DELETE
```

Expected:
- Snapshot deleted in vCenter
- `Snapshot Cleanup Result | ... | deleted=1 | outcome=SUCCESS` in vRO log
- Consolidation task visible in vCenter Task History

---

## Phase 4 — Production Enablement

### Step 11: Configure Production Schedule

1. Open the workflow > Schedule > Add Schedule
2. Set recurrence: **daily, off-peak hours** (e.g. 02:00 in appliance timezone)
3. Set input defaults:
   - `dryRun = false`
   - `maxAgeMinutes = 10080` (or per retention policy)
   - All governor thresholds from Thresholds config element values
4. Confirm next run time is as expected

### Step 12: Aria Ops for Logs Integration

The vRO workflow log is automatically ingested by Aria Ops for Logs when the
vRO integration is configured. To surface snapshot cleanup results:

1. In Aria Ops for Logs, create a saved filter:
   - Source: vRO workflow logs
   - Filter: `text contains "Snapshot Cleanup Result"`
2. Create field extractions for: `outcome`, `deleted`, `errors`, `deferred`
   using the regex patterns in VARIABLE_BINDING_REFERENCE.md Section 5
3. Create an alert on: `errors > 0` OR `outcome = COMPLETED_WITH_ERRORS`
4. Create a dashboard widget showing `deleted` count trend over time

### Step 13: Governor Baseline Calibration

After the first 3-5 live runs, review the vRO execution logs for governor
HOLD entries. If the governor is holding tasks frequently:

1. Check vCenter performance charts for affected datastores (last 7 days)
2. Identify average idle latency during the cleanup window
3. Raise `latencyThresholdMs` in the Thresholds config element to ~2x that value
4. For vSAN: review the vSAN Performance dashboard for historical congestion scores

---

## Operational Runbook

### Clearing a Stuck Mutex Lock

If the vRO appliance restarts during a run, the mutex may persist and
block all subsequent runs. All scheduled runs will show `MUTEX_ABORT`.

**Resolution:**
1. Confirm no run is currently executing (check vRO Runs tab)
2. Design > Configuration > SnapshotCleanup > RuntimeState
3. Set `runLock` attribute value to empty string
4. Save — next run proceeds normally

**Prevention:** The Exception Handler releases the lock on all abnormal exits.
The only scenario where it cannot is an OOM kill or appliance crash mid-run.

### Investigating a Run

1. Open the workflow > Runs tab > select the run by start time
2. Review execution log for detailed per-snapshot entries
3. Search Aria Ops for Logs for `runId=SCR-YYYY-MM-DDTHH-MM-SS`
4. The `Snapshot Cleanup Result` line contains the complete run summary
5. Filter by `outcome=ERROR` or `outcome=COMPLETED_WITH_ERRORS` for failures
6. `action=deferred` entries were skipped by governor max wait — they will
   be retried on the next scheduled run

### Adding a New vCenter

1. Register the vCenter as an SDK connection in vRO
   (Administration > vCenter Server)
2. No workflow changes required
3. `VcPlugin.allSdkConnections` discovers all registered connections at runtime
4. Confirm the new vCenter appears in the next dry-run log output

### Governor Is Always Blocking

If HOLD entries appear frequently and waits are long:
1. Confirm idle storage latency is below `latencyThresholdMs` using vCenter charts
2. If idle latency > threshold: raise the threshold in Thresholds config element
3. If governor is calibrating a very large delta (deep chain consolidation):
   consider running cleanup during a lower-activity window
4. Reduce `maxParallelPerVcenter` to 1 to reduce concurrent I/O load

### Disabling the Automation Temporarily

- **Disable schedule:** workflow > Schedule > disable or delete the schedule
- **Block all runs:** set `runLock` in RuntimeState to any non-empty value
  such as `MAINTENANCE` — all run attempts abort at the mutex check with
  `MUTEX_ABORT` and emit no result log entry

---

## Files in This Package

```
actions/
  getSnapshotCandidates.js    vRO action — VM and snapshot enumeration
  getDatastoreMetrics.js      vRO action — I/O metric sampling (vSAN + VMFS/NFS)
  adaptiveGovernorCheck.js    vRO action — I/O governor decision engine
  deleteSnapshot.js           vRO action — snapshot deletion with safety checks

workflow/
  ST-01_InitialiseRun.js             Scriptable task 1
  ST-02_MutexCheckAndAcquire.js      Scriptable task 2
  ST-03_EnumeratevCenters.js         Scriptable task 3
  ST-04_CandidatesCheck.js           Scriptable task 4
  ST-05_SortAndSplitLanes.js         Scriptable task 5
  ST-06_ProcessPoweredOnVMs.js       Scriptable task 6
  ST-07_ProcessPoweredOffVMs.js      Scriptable task 7
  ST-09_ReleaseMutexAndFinalise.js   Scriptable task 9 (ST-08 does not exist)
  EH_ExceptionHandler.js             Exception handler element

config/
  configurationElements.xml     Reference for RuntimeState and Thresholds elements

docs/
  DEPLOYMENT_GUIDE.md           This file
  VARIABLE_BINDING_REFERENCE.md Workflow inputs, attributes, and per-task bindings
```
