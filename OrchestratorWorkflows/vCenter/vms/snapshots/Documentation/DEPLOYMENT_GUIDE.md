# Implementation & Deployment Guide
## Adaptive Snapshot Cleanup — Multi-vCenter
## VCF 9.0.2 / Embedded vRO 8.17.x

---

## Overview

This guide covers the complete implementation sequence for the Adaptive Snapshot
Cleanup workflow. Follow the phases in order — later phases depend on earlier ones.

**Configuration design:**
All threshold and policy values (age limit, I/O governor thresholds, concurrency
limits, etc.) are defined as workflow input parameters with default values set
directly on the workflow Inputs tab. When scheduling the workflow, these defaults
are set on the schedule definition. One configuration element is required:
`SnapshotCleanup/RuntimeState`, which holds only the distributed mutex lock.

All audit logging is via the vRO workflow log, ingested by VMware Aria Operations
for Logs. No network share, NFS mount, or SMB credentials are required.

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

### Step 5: Create the RuntimeState Configuration Element

This is the only configuration element required by this solution.

1. Navigate to: Design > Configuration
2. Create category: `SnapshotCleanup`
3. Create one configuration element: **RuntimeState**

| Attribute Name     | Type   | Initial Value | Notes |
|--------------------|--------|---------------|-------|
| runLock            | string | (empty)       | CRITICAL: must be empty string, never null |
| lastRunId          | string | (empty)       | Informational — updated automatically |
| lastRunCompletedAt | string | (empty)       | Informational — updated automatically |
| lastRunOutcome     | string | (empty)       | Informational — updated automatically |

Refer to `configurationElements.xml` for full attribute descriptions.

> **Note:** No Thresholds configuration element is required. All threshold and
> policy values are set as workflow input defaults in Step 6 below.

### Step 6: Create the Workflow

1. Navigate to Design > Workflows
2. Create: **"Adaptive Snapshot Cleanup — Multi-vCenter"**
3. On the **Inputs** tab, add all 10 input parameters with the default values
   shown in the table below:

| Parameter Name          | Type    | Default Value | Notes |
|-------------------------|---------|---------------|-------|
| maxAgeMinutes           | number  | 10080         | 7 days production; use 5-60 for testing |
| nameMatchString         | string  | (empty)       | Leave empty to target all snapshot names |
| descIgnoreString        | string  | (empty)       | Leave empty to apply no description filter |
| dryRun                  | boolean | true          | MUST default to true |
| latencyThresholdMs      | number  | 30            | VMFS/NFS: tune to ~2x observed idle latency |
| vsanCongestionThresh    | number  | 50            | vSAN: 0-255 scale; >128 = serious congestion |
| vsanResyncThresholdGB   | number  | 10            | vSAN: resync queue ceiling in GB |
| maxParallelPerVcenter   | number  | 3             | Max concurrent tasks per vCenter |
| governorPollIntervalSec | number  | 30            | Governor re-check interval when holding |
| taskTimeoutSeconds      | number  | 1800          | Per-task vCenter task timeout (30 min) |

4. Set `dryRun` default to `true` — operators must explicitly set `false` to perform live deletion
5. On the **Attributes** tab, add all 13 workflow attributes (see VARIABLE_BINDING_REFERENCE.md)
6. Build the canvas with 8 scriptable task elements: ST-01 through ST-09 (no ST-08)
7. Add one Exception Handler element connected from all task error outputs
8. Paste each script file's content into the corresponding task body
9. Configure all input/output bindings per VARIABLE_BINDING_REFERENCE.md
10. Save and validate

---

## Phase 3 — Validation

### Step 7: Dry-Run Validation (MANDATORY before any live run)

Run with:
```
maxAgeMinutes = 5
dryRun        = true
```

Expected results:
- vRO execution log shows `[DRY-RUN] Would delete:` entries for eligible snapshots
- Final `Snapshot Cleanup Result | outcome=DRY_RUN_COMPLETE` appears in log
- `deleted=0` in the result entry
- Mutex released — confirm `runLock` is empty after run

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
- `Snapshot Cleanup Result | deleted=1 | outcome=SUCCESS` in vRO log
- Consolidation task visible in vCenter Task History

---

## Phase 4 — Production Enablement

### Step 11: Configure Production Schedule

1. Open the workflow > Schedule > Add Schedule
2. Set recurrence: **daily, off-peak hours** (e.g. 02:00 in appliance timezone)
3. On the schedule's input defaults, set:
   - `dryRun = false`
   - `maxAgeMinutes = 10080` (or per your snapshot retention policy)
   - Governor thresholds at their default values initially; tune after first few runs
4. Confirm next run time is as expected

### Step 12: Configure Aria Ops for Logs

1. Confirm vRO workflow log is a configured source in Aria Ops for Logs
2. Create a saved filter: `text contains "Snapshot Cleanup Result"`
3. Set up field extractions for `outcome`, `deleted`, `errors`, `deferred`
   using the regex patterns in VARIABLE_BINDING_REFERENCE.md Section 5
4. Create an alert on `outcome=ERROR` or `errors>0`

### Step 13: Governor Baseline Calibration

After the first 3-5 live runs, review the vRO execution logs for governor
HOLD entries. If the governor holds tasks frequently:

1. Check vCenter performance charts for affected datastores (last 7 days)
2. Identify average idle latency during the cleanup window
3. Update `latencyThresholdMs` on the **workflow Inputs tab default value**
   (not a config element — right-click workflow > Edit > Inputs tab)
4. For vSAN: review the vSAN Performance dashboard for historical congestion
   scores and update `vsanCongestionThresh` the same way
5. The updated default will apply to all future scheduled runs automatically

---

## Operational Runbook

### Clearing a Stuck Mutex Lock

If the vRO appliance restarts during a run, the mutex may persist and block
all subsequent runs. All scheduled runs will log `MUTEX_ABORT`.

**Resolution:**
1. Confirm no run is currently executing (vRO Runs tab)
2. Design > Configuration > SnapshotCleanup > RuntimeState
3. Set `runLock` to empty string and save
4. Next run proceeds normally

**Prevention:** The Exception Handler releases the lock on all abnormal exits.
The only scenario where it cannot is an OOM kill or appliance crash mid-run.

### Investigating a Run

1. Open the workflow > Runs tab > select the run by start time
2. Review execution log for per-snapshot `[DRY-RUN]`, `Deleting`, `SKIP`, and
   governor HOLD entries
3. Search Aria Ops for Logs for `runId=SCR-YYYY-MM-DDTHH-MM-SS`
4. The `Snapshot Cleanup Result` line contains the complete run summary
5. `action=deferred` entries were held by the governor and will be retried
   on the next scheduled run

### Tuning Threshold Values

All threshold values are workflow input defaults. To update them permanently:

1. In vRO: Design > Workflows > right-click the workflow > Edit
2. Click the **Inputs** tab
3. Click the input to edit (e.g. `latencyThresholdMs`)
4. Update the Default Value field
5. Save and close

The updated default applies to all future scheduled runs. On-demand runs can
still override any value at runtime via the input form.

### Adding a New vCenter

1. Register the vCenter as an SDK connection in vRO
   (Administration > vCenter Server)
2. No workflow changes required
3. `VcPlugin.allSdkConnections` discovers all registered connections at runtime
4. Confirm the new vCenter appears in the next dry-run output

### Disabling the Automation

- **Disable schedule:** Workflow > Schedule > disable or delete the schedule
- **Block all runs:** Set `runLock` in RuntimeState to any non-empty value
  such as `MAINTENANCE` — all run attempts abort with MUTEX_ABORT

---

## Files in This Package

```
actions/
  getSnapshotCandidates.js    vRO action — VM and snapshot enumeration with filters
  getDatastoreMetrics.js      vRO action — I/O metric sampling (vSAN + VMFS/NFS)
  adaptiveGovernorCheck.js    vRO action — adaptive I/O governor decision engine
  deleteSnapshot.js           vRO action — snapshot deletion with safety checks

workflow/
  ST-01_InitialiseRun.js             Scriptable task 1 — run ID, unit conversions, log init
  ST-02_MutexCheckAndAcquire.js      Scriptable task 2 — mutex lock check and acquire
  ST-03_EnumeratevCenters.js         Scriptable task 3 — candidate collection across all vCenters
  ST-04_CandidatesCheck.js           Scriptable task 4 — early exit gate if no candidates
  ST-05_SortAndSplitLanes.js         Scriptable task 5 — chain-order sort and lane assignment
  ST-06_ProcessPoweredOnVMs.js       Scriptable task 6 — throttled lane with governor
  ST-07_ProcessPoweredOffVMs.js      Scriptable task 7 — fast lane with governor
  ST-09_ReleaseMutexAndFinalise.js   Scriptable task 9 — lock release and result log entry
  EH_ExceptionHandler.js             Exception handler — classification, lock release, error logging

config/
  configurationElements.xml    RuntimeState element only (one element, four attributes)

docs/
  DEPLOYMENT_GUIDE.md           This file
  VARIABLE_BINDING_REFERENCE.md Workflow inputs, attributes, and per-task bindings
  Adaptive_Snapshot_Cleanup_Technical_Design_v1.2.docx  Customer-facing design document
```
