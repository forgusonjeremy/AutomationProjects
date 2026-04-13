# Workflow Variable Binding Reference
## Adaptive Snapshot Cleanup — Multi-vCenter
## VCF 9.0.2 / Embedded vRO 8.17.x

---

## Architecture overview

```
[START]
   |
[ST-01  Initialise run]             ──error──> [EH Exception Handler]
   |
[ST-02  Mutex check & acquire]      ──error──> [EH Exception Handler]
   |
[ST-03  Enumerate vCenters]         ──error──> [EH Exception Handler]
   |
[ST-04  Candidates check]           ──error──> [EH Exception Handler]
   |  (exits cleanly via EH if no candidates)
[ST-05  Sort & split lanes]         ──error──> [EH Exception Handler]
   |
[ST-06  Process powered-on VMs]     ──error──> [EH Exception Handler]
   |
[ST-07  Process powered-off VMs]    ──error──> [EH Exception Handler]
   |
[ST-09  Release mutex & finalise]   ──error──> [EH Exception Handler]
   |
[END]

[EH Exception Handler]
   | CLEAN_EXIT / MUTEX_ABORT  ──> [END — success state]
   | ERROR                     ──> re-throws ──> [END — error state]
```

NOTE: ST-08 (Write Audit Log) does not exist in this solution.
All audit output is written to the vRO workflow log via System.log().
VMware Aria Operations for Logs ingests the workflow log automatically.

Configuration elements required: ONE — SnapshotCleanup/RuntimeState (mutex only).
All threshold and policy values are workflow input parameters.

---

## 1. Workflow Inputs Tab

Set these on the workflow Inputs tab. Default values apply to all scheduled runs
unless overridden on the schedule definition. Operators can override any value
at runtime via the on-demand input form.

To update a default permanently: Edit workflow > Inputs tab > click the input >
update Default Value > Save.

| Name                    | Type    | Default | Notes |
|-------------------------|---------|---------|-------|
| maxAgeMinutes           | number  | 10080   | 7 days. Use 5-60 for testing. |
| nameMatchString         | string  | (empty) | Whitelist: only delete snaps whose name contains this. Empty = all names. |
| descIgnoreString        | string  | (empty) | Skip snaps whose description contains this. Empty = no filter. |
| dryRun                  | boolean | true    | Default MUST be true. Operators set false explicitly for live runs. |
| latencyThresholdMs      | number  | 30      | VMFS/NFS governor ceiling in ms. Tune to ~2x observed idle latency. |
| vsanCongestionThresh    | number  | 50      | vSAN governor ceiling (0-255). Values >128 = serious congestion. |
| vsanResyncThresholdGB   | number  | 10      | vSAN resync queue ceiling in GB. |
| maxParallelPerVcenter   | number  | 3       | Max concurrent consolidation tasks per vCenter (powered-on VMs). |
| governorPollIntervalSec | number  | 30      | How often governor re-checks metrics when holding a task (seconds). |
| taskTimeoutSeconds      | number  | 1800    | Max seconds to wait for a vCenter task to complete (30 min). |

---

## 2. Workflow Attributes Tab

Internal state shared between scriptable tasks. These are not visible on the
input form and are not configurable by operators.

| Name                     | Type                 | Default | Set by | Description |
|--------------------------|----------------------|---------|--------|-------------|
| runId                    | string               | ""      | ST-01  | Unique run identifier (SCR-YYYY-MM-DDTHH-MM-SS) |
| runLog                   | string               | "[]"    | ST-01  | JSON array accumulating per-snapshot log entries. Internal only — never written externally. |
| vsanResyncThresholdBytes | number               | 0       | ST-01  | vsanResyncThresholdGB converted to bytes |
| govPollMs                | number               | 30000   | ST-01  | governorPollIntervalSec converted to milliseconds |
| maxParallel              | number               | 3       | ST-01  | Validated alias of maxParallelPerVcenter (min 1) |
| lockEl                   | ConfigurationElement | null    | ST-02  | Reference to RuntimeState element — passed to ST-09 and EH |
| allCandidatesJson        | string               | "[]"    | ST-03  | All candidates across all vCenters |
| candidateCount           | number               | 0       | ST-04  | Total candidate count |
| onCandidatesJson         | string               | "[]"    | ST-05  | Powered-on and suspended candidates |
| offCandidatesJson        | string               | "[]"    | ST-05  | Powered-off candidates |
| datastoreStateJson       | string               | "{}"    | ST-06  | Governor calibration state; updated by ST-07 |
| runSummaryJson           | string               | ""      | ST-09  | Structured run summary |
| workflowOutcome          | string               | ""      | EH     | Final outcome classification string |

---

## 3. Workflow Outputs Tab

| Name            | Type   | Source Attribute | Description |
|-----------------|--------|------------------|-------------|
| runSummaryJson  | string | runSummaryJson   | JSON run summary — visible in vRO execution details and accessible to calling workflows |
| workflowOutcome | string | workflowOutcome  | SUCCESS / DRY_RUN_COMPLETE / COMPLETED_WITH_ERRORS / COMPLETED_WITH_DEFERRALS / CLEAN_EXIT / MUTEX_ABORT / ERROR |

---

## 4. Per-Task Input/Output Bindings

For each task: IN bindings read from the named workflow input or attribute;
OUT bindings write back to the named workflow attribute.

### ST-01  Initialise Run

| Dir | Variable Name            | Bind To/From                          | Type    |
|-----|--------------------------|---------------------------------------|---------|
| IN  | maxAgeMinutes            | Workflow Input: maxAgeMinutes         | number  |
| IN  | nameMatchString          | Workflow Input: nameMatchString       | string  |
| IN  | descIgnoreString         | Workflow Input: descIgnoreString      | string  |
| IN  | dryRun                   | Workflow Input: dryRun                | boolean |
| IN  | latencyThresholdMs       | Workflow Input: latencyThresholdMs    | number  |
| IN  | vsanCongestionThresh     | Workflow Input: vsanCongestionThresh  | number  |
| IN  | vsanResyncThresholdGB    | Workflow Input: vsanResyncThresholdGB | number  |
| IN  | maxParallelPerVcenter    | Workflow Input: maxParallelPerVcenter | number  |
| IN  | governorPollIntervalSec  | Workflow Input: governorPollIntervalSec | number |
| IN  | taskTimeoutSeconds       | Workflow Input: taskTimeoutSeconds    | number  |
| OUT | runId                    | Attribute: runId                      | string  |
| OUT | runLog                   | Attribute: runLog                     | string  |
| OUT | vsanResyncThresholdBytes | Attribute: vsanResyncThresholdBytes   | number  |
| OUT | govPollMs                | Attribute: govPollMs                  | number  |
| OUT | maxParallel              | Attribute: maxParallel                | number  |

### ST-02  Mutex Check & Acquire

| Dir | Variable Name | Bind To/From          | Type                 |
|-----|---------------|-----------------------|----------------------|
| IN  | runId         | Attribute: runId      | string               |
| OUT | lockEl        | Attribute: lockEl     | ConfigurationElement |

### ST-03  Enumerate vCenters

| Dir | Variable Name     | Bind To/From                         | Type   |
|-----|-------------------|--------------------------------------|--------|
| IN  | runId             | Attribute: runId                     | string |
| IN  | runLog            | Attribute: runLog                    | string |
| IN  | maxAgeMinutes     | Workflow Input: maxAgeMinutes        | number |
| IN  | nameMatchString   | Workflow Input: nameMatchString      | string |
| IN  | descIgnoreString  | Workflow Input: descIgnoreString     | string |
| OUT | allCandidatesJson | Attribute: allCandidatesJson         | string |
| OUT | runLog            | Attribute: runLog                    | string |

### ST-04  Candidates Check

| Dir | Variable Name     | Bind To/From                        | Type                 |
|-----|-------------------|-------------------------------------|----------------------|
| IN  | allCandidatesJson | Attribute: allCandidatesJson        | string               |
| IN  | runLog            | Attribute: runLog                   | string               |
| IN  | runId             | Attribute: runId                    | string               |
| IN  | lockEl            | Attribute: lockEl                   | ConfigurationElement |
| IN  | dryRun            | Workflow Input: dryRun              | boolean              |
| IN  | maxAgeMinutes     | Workflow Input: maxAgeMinutes       | number               |
| IN  | nameMatchString   | Workflow Input: nameMatchString     | string               |
| IN  | descIgnoreString  | Workflow Input: descIgnoreString    | string               |
| OUT | candidateCount    | Attribute: candidateCount           | number               |

### ST-05  Sort & Split Lanes

| Dir | Variable Name     | Bind To/From                  | Type   |
|-----|-------------------|-------------------------------|--------|
| IN  | allCandidatesJson | Attribute: allCandidatesJson  | string |
| OUT | onCandidatesJson  | Attribute: onCandidatesJson   | string |
| OUT | offCandidatesJson | Attribute: offCandidatesJson  | string |

### ST-06  Process Powered-On VMs

| Dir | Variable Name            | Bind To/From                          | Type    |
|-----|--------------------------|---------------------------------------|---------|
| IN  | onCandidatesJson         | Attribute: onCandidatesJson           | string  |
| IN  | runId                    | Attribute: runId                      | string  |
| IN  | runLog                   | Attribute: runLog                     | string  |
| IN  | dryRun                   | Workflow Input: dryRun                | boolean |
| IN  | latencyThresholdMs       | Workflow Input: latencyThresholdMs    | number  |
| IN  | vsanCongestionThresh     | Workflow Input: vsanCongestionThresh  | number  |
| IN  | vsanResyncThresholdBytes | Attribute: vsanResyncThresholdBytes   | number  |
| IN  | govPollMs                | Attribute: govPollMs                  | number  |
| IN  | maxParallel              | Attribute: maxParallel                | number  |
| IN  | taskTimeoutSeconds       | Workflow Input: taskTimeoutSeconds    | number  |
| OUT | datastoreStateJson       | Attribute: datastoreStateJson         | string  |
| OUT | runLog                   | Attribute: runLog                     | string  |

### ST-07  Process Powered-Off VMs

| Dir | Variable Name            | Bind To/From                          | Type    |
|-----|--------------------------|---------------------------------------|---------|
| IN  | offCandidatesJson        | Attribute: offCandidatesJson          | string  |
| IN  | datastoreStateJson       | Attribute: datastoreStateJson         | string  |
| IN  | runId                    | Attribute: runId                      | string  |
| IN  | runLog                   | Attribute: runLog                     | string  |
| IN  | dryRun                   | Workflow Input: dryRun                | boolean |
| IN  | latencyThresholdMs       | Workflow Input: latencyThresholdMs    | number  |
| IN  | vsanCongestionThresh     | Workflow Input: vsanCongestionThresh  | number  |
| IN  | vsanResyncThresholdBytes | Attribute: vsanResyncThresholdBytes   | number  |
| IN  | govPollMs                | Attribute: govPollMs                  | number  |
| IN  | taskTimeoutSeconds       | Workflow Input: taskTimeoutSeconds    | number  |
| OUT | runLog                   | Attribute: runLog                     | string  |
| OUT | datastoreStateJson       | Attribute: datastoreStateJson         | string  |

### ST-09  Release Mutex & Finalise

| Dir | Variable Name    | Bind To/From                     | Type                 |
|-----|------------------|----------------------------------|----------------------|
| IN  | lockEl           | Attribute: lockEl                | ConfigurationElement |
| IN  | runId            | Attribute: runId                 | string               |
| IN  | runLog           | Attribute: runLog                | string               |
| IN  | dryRun           | Workflow Input: dryRun           | boolean              |
| IN  | maxAgeMinutes    | Workflow Input: maxAgeMinutes    | number               |
| IN  | nameMatchString  | Workflow Input: nameMatchString  | string               |
| IN  | descIgnoreString | Workflow Input: descIgnoreString | string               |
| OUT | runSummaryJson   | Attribute: runSummaryJson        | string               |

### EH  Exception Handler

| Dir | Variable Name    | Bind To/From                     | Type                 |
|-----|------------------|----------------------------------|----------------------|
| IN  | errorCode        | vRO built-in exception binding   | string               |
| IN  | lockEl           | Attribute: lockEl                | ConfigurationElement |
| IN  | runId            | Attribute: runId                 | string               |
| IN  | runLog           | Attribute: runLog                | string               |
| IN  | dryRun           | Workflow Input: dryRun           | boolean              |
| IN  | maxAgeMinutes    | Workflow Input: maxAgeMinutes    | number               |
| IN  | nameMatchString  | Workflow Input: nameMatchString  | string               |
| IN  | descIgnoreString | Workflow Input: descIgnoreString | string               |
| OUT | workflowOutcome  | Attribute: workflowOutcome       | string               |
| OUT | runSummaryJson   | Attribute: runSummaryJson        | string               |

---

## 5. Aria Ops for Logs — Result Entry

Every run emits exactly one structured line. Use this as the primary filter:

  `text contains "Snapshot Cleanup Result"`

Example:
```
Snapshot Cleanup Result | runId=SCR-2026-04-10T02-00-00 | outcome=SUCCESS
  | dryRun=false | ageThreshold=10080min | nameFilter=none | descIgnore=none
  | deleted=12 | dryRun_count=0 | skipped=3 | deferred=1
  | errors=0 | enumErrors=0 | total=16
  | vcenters=vcenter.corp.local | datastores=4 | lockReleased=true
```

Field extraction patterns:

| Field        | Regex                    |
|--------------|--------------------------|
| runId        | `runId=([^\s\|]+)`       |
| outcome      | `outcome=([^\s\|]+)`     |
| dryRun       | `dryRun=([^\s\|]+)`      |
| deleted      | `deleted=(\d+)`          |
| dryRun_count | `dryRun_count=(\d+)`     |
| skipped      | `skipped=(\d+)`          |
| deferred     | `deferred=(\d+)`         |
| errors       | `errors=(\d+)`           |
| total        | `total=(\d+)`            |
| vcenters     | `vcenters=([^\s\|]+)`    |
| datastores   | `datastores=(\d+)`       |
| lockReleased | `lockReleased=(\w+)`     |

---

## 6. Threshold Tuning Reference

All threshold values live on the workflow Inputs tab. Update them there — not
in a configuration element. Changes take effect on the next scheduled run.

| Parameter | Conservative | Default | Permissive | Notes |
|-----------|-------------|---------|------------|-------|
| latencyThresholdMs | 15 ms | 30 ms | 60 ms | All-flash: 8-15 ms. Spinning disk: 25-40 ms. |
| vsanCongestionThresh | 30 | 50 | 80 | Values >128 indicate serious congestion. |
| vsanResyncThresholdGB | 5 | 10 | 20 | Raise on clusters with frequent resync activity. |
| maxParallelPerVcenter | 1-2 | 3 | 5-8 | Do not exceed 10 without vCenter task queue analysis. |
| governorPollIntervalSec | 15 | 30 | 60 | Lower = more responsive; higher = fewer perf manager queries. |
| taskTimeoutSeconds | 1800 | 1800 | 3600 | Raise for very deep snapshot chains or slow storage. |
