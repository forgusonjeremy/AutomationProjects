# Workflow Variable Binding Reference
## Adaptive Snapshot Cleanup — Multi-vCenter
## VCF 9.0.2 / Embedded vRO 8.17.x

---

## Workflow architecture overview

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

---

## 1. Workflow Inputs Tab

| Name                    | Type    | Default | Mandatory | Notes |
|-------------------------|---------|---------|-----------|-------|
| maxAgeMinutes           | number  | 60      | Yes       | Use 5-60 for testing; 10080 (7d) for production |
| nameMatchString         | string  | (empty) | No        | Leave empty to target all snapshot names |
| descIgnoreString        | string  | (empty) | No        | Leave empty to apply no description filter |
| dryRun                  | boolean | true    | Yes       | MUST default to true — operators explicitly set false |
| latencyThresholdMs      | number  | 30      | Yes       | Tune to ~2x idle latency for your environment |
| vsanCongestionThresh    | number  | 50      | Yes       | vSAN only; 0-255 scale |
| vsanResyncThresholdGB   | number  | 10      | Yes       | vSAN only; resync queue ceiling |
| maxParallelPerVcenter   | number  | 3       | Yes       | Max concurrent tasks per vCenter (powered-on VMs) |
| governorPollIntervalSec | number  | 30      | Yes       | Governor re-check interval when holding a task |
| taskTimeoutSeconds      | number  | 1800    | Yes       | Per-task vCenter task timeout (30 min default) |

---

## 2. Workflow Attributes Tab

| Name                     | Type                 | Default | Description |
|--------------------------|----------------------|---------|-------------|
| runId                    | string               | ""      | Set by ST-01 — unique run identifier |
| runLog                   | string               | "[]"    | Set by ST-01 — accumulates per-snapshot log entries internally; never written externally |
| vsanResyncThresholdBytes | number               | 0       | Set by ST-01 — vsanResyncThresholdGB × 1073741824 |
| govPollMs                | number               | 30000   | Set by ST-01 — governorPollIntervalSec × 1000 |
| maxParallel              | number               | 3       | Set by ST-01 — validated alias of maxParallelPerVcenter |
| lockEl                   | ConfigurationElement | null    | Set by ST-02 — reference to RuntimeState element |
| allCandidatesJson        | string               | "[]"    | Set by ST-03 — all candidates across all vCenters |
| candidateCount           | number               | 0       | Set by ST-04 — total candidate count |
| onCandidatesJson         | string               | "[]"    | Set by ST-05 — powered-on/suspended candidates |
| offCandidatesJson        | string               | "[]"    | Set by ST-05 — powered-off candidates |
| datastoreStateJson       | string               | "{}"    | Set by ST-06, updated by ST-07 — governor calibration |
| runSummaryJson           | string               | ""      | Set by ST-09 / EH — structured run summary |
| workflowOutcome          | string               | ""      | Set by EH — outcome classification string |

---

## 3. Workflow Outputs Tab

| Name            | Type   | Source Attribute | Description |
|-----------------|--------|------------------|-------------|
| runSummaryJson  | string | runSummaryJson   | JSON run summary — visible in vRO execution details |
| workflowOutcome | string | workflowOutcome  | Final outcome: SUCCESS / DRY_RUN_COMPLETE / COMPLETED_WITH_ERRORS / COMPLETED_WITH_DEFERRALS / CLEAN_EXIT / MUTEX_ABORT / ERROR |

---

## 4. Per-Task Input/Output Bindings

### ST-01  Initialise Run

| Dir | Variable Name            | Bind To/From                         | Type    |
|-----|--------------------------|--------------------------------------|---------|
| IN  | maxAgeMinutes            | Workflow Input: maxAgeMinutes        | number  |
| IN  | nameMatchString          | Workflow Input: nameMatchString      | string  |
| IN  | descIgnoreString         | Workflow Input: descIgnoreString     | string  |
| IN  | dryRun                   | Workflow Input: dryRun               | boolean |
| IN  | latencyThresholdMs       | Workflow Input: latencyThresholdMs   | number  |
| IN  | vsanCongestionThresh     | Workflow Input: vsanCongestionThresh | number  |
| IN  | vsanResyncThresholdGB    | Workflow Input: vsanResyncThresholdGB| number  |
| IN  | maxParallelPerVcenter    | Workflow Input: maxParallelPerVcenter| number  |
| IN  | governorPollIntervalSec  | Workflow Input: governorPollIntervalSec | number |
| IN  | taskTimeoutSeconds       | Workflow Input: taskTimeoutSeconds   | number  |
| OUT | runId                    | Attribute: runId                     | string  |
| OUT | runLog                   | Attribute: runLog                    | string  |
| OUT | vsanResyncThresholdBytes | Attribute: vsanResyncThresholdBytes  | number  |
| OUT | govPollMs                | Attribute: govPollMs                 | number  |
| OUT | maxParallel              | Attribute: maxParallel               | number  |

### ST-02  Mutex Check & Acquire

| Dir | Variable Name | Bind To/From          | Type                 |
|-----|---------------|-----------------------|----------------------|
| IN  | runId         | Attribute: runId      | string               |
| OUT | lockEl        | Attribute: lockEl     | ConfigurationElement |

### ST-03  Enumerate vCenters

| Dir | Variable Name     | Bind To/From                        | Type   |
|-----|-------------------|-------------------------------------|--------|
| IN  | runId             | Attribute: runId                    | string |
| IN  | runLog            | Attribute: runLog                   | string |
| IN  | maxAgeMinutes     | Workflow Input: maxAgeMinutes       | number |
| IN  | nameMatchString   | Workflow Input: nameMatchString     | string |
| IN  | descIgnoreString  | Workflow Input: descIgnoreString    | string |
| OUT | allCandidatesJson | Attribute: allCandidatesJson        | string |
| OUT | runLog            | Attribute: runLog                   | string |

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

| Dir | Variable Name     | Bind To/From                   | Type   |
|-----|-------------------|--------------------------------|--------|
| IN  | allCandidatesJson | Attribute: allCandidatesJson   | string |
| OUT | onCandidatesJson  | Attribute: onCandidatesJson    | string |
| OUT | offCandidatesJson | Attribute: offCandidatesJson   | string |

### ST-06  Process Powered-On VMs

| Dir | Variable Name            | Bind To/From                         | Type    |
|-----|--------------------------|--------------------------------------|---------|
| IN  | onCandidatesJson         | Attribute: onCandidatesJson          | string  |
| IN  | runId                    | Attribute: runId                     | string  |
| IN  | runLog                   | Attribute: runLog                    | string  |
| IN  | dryRun                   | Workflow Input: dryRun               | boolean |
| IN  | latencyThresholdMs       | Workflow Input: latencyThresholdMs   | number  |
| IN  | vsanCongestionThresh     | Workflow Input: vsanCongestionThresh | number  |
| IN  | vsanResyncThresholdBytes | Attribute: vsanResyncThresholdBytes  | number  |
| IN  | govPollMs                | Attribute: govPollMs                 | number  |
| IN  | maxParallel              | Attribute: maxParallel               | number  |
| IN  | taskTimeoutSeconds       | Workflow Input: taskTimeoutSeconds   | number  |
| OUT | datastoreStateJson       | Attribute: datastoreStateJson        | string  |
| OUT | runLog                   | Attribute: runLog                    | string  |

### ST-07  Process Powered-Off VMs

| Dir | Variable Name            | Bind To/From                         | Type    |
|-----|--------------------------|--------------------------------------|---------|
| IN  | offCandidatesJson        | Attribute: offCandidatesJson         | string  |
| IN  | datastoreStateJson       | Attribute: datastoreStateJson        | string  |
| IN  | runId                    | Attribute: runId                     | string  |
| IN  | runLog                   | Attribute: runLog                    | string  |
| IN  | dryRun                   | Workflow Input: dryRun               | boolean |
| IN  | latencyThresholdMs       | Workflow Input: latencyThresholdMs   | number  |
| IN  | vsanCongestionThresh     | Workflow Input: vsanCongestionThresh | number  |
| IN  | vsanResyncThresholdBytes | Attribute: vsanResyncThresholdBytes  | number  |
| IN  | govPollMs                | Attribute: govPollMs                 | number  |
| IN  | taskTimeoutSeconds       | Workflow Input: taskTimeoutSeconds   | number  |
| OUT | runLog                   | Attribute: runLog                    | string  |
| OUT | datastoreStateJson       | Attribute: datastoreStateJson        | string  |

### ST-09  Release Mutex & Finalise

| Dir | Variable Name    | Bind To/From                      | Type                 |
|-----|------------------|-----------------------------------|----------------------|
| IN  | lockEl           | Attribute: lockEl                 | ConfigurationElement |
| IN  | runId            | Attribute: runId                  | string               |
| IN  | runLog           | Attribute: runLog                 | string               |
| IN  | dryRun           | Workflow Input: dryRun            | boolean              |
| IN  | maxAgeMinutes    | Workflow Input: maxAgeMinutes     | number               |
| IN  | nameMatchString  | Workflow Input: nameMatchString   | string               |
| IN  | descIgnoreString | Workflow Input: descIgnoreString  | string               |
| OUT | runSummaryJson   | Attribute: runSummaryJson         | string               |

### EH  Exception Handler

| Dir | Variable Name    | Bind To/From                      | Type                 |
|-----|------------------|-----------------------------------|----------------------|
| IN  | errorCode        | vRO built-in exception binding    | string               |
| IN  | lockEl           | Attribute: lockEl                 | ConfigurationElement |
| IN  | runId            | Attribute: runId                  | string               |
| IN  | runLog           | Attribute: runLog                 | string               |
| IN  | dryRun           | Workflow Input: dryRun            | boolean              |
| IN  | maxAgeMinutes    | Workflow Input: maxAgeMinutes     | number               |
| IN  | nameMatchString  | Workflow Input: nameMatchString   | string               |
| IN  | descIgnoreString | Workflow Input: descIgnoreString  | string               |
| OUT | workflowOutcome  | Attribute: workflowOutcome        | string               |
| OUT | runSummaryJson   | Attribute: runSummaryJson         | string               |

---

## 5. Aria Ops for Logs — Result Entry

Every run emits exactly one "Snapshot Cleanup Result" line to the vRO workflow
log. Use the following as the primary filter in Aria Ops for Logs:

  contains: `Snapshot Cleanup Result`

Example entry:
```
Snapshot Cleanup Result | runId=SCR-2026-04-10T02-00-00 | outcome=SUCCESS
  | dryRun=false | ageThreshold=10080min | nameFilter=none | descIgnore=none
  | deleted=12 | dryRun_count=0 | skipped=3 | deferred=1
  | errors=0 | enumErrors=0 | total=16
  | vcenters=vcenter.corp.local | datastores=4 | lockReleased=true
```

Suggested field extraction patterns for Aria Ops for Logs:

| Field        | Regex pattern                  |
|--------------|--------------------------------|
| runId        | `runId=([^\s\|]+)`             |
| outcome      | `outcome=([^\s\|]+)`           |
| dryRun       | `dryRun=([^\s\|]+)`            |
| deleted      | `deleted=(\d+)`                |
| dryRun_count | `dryRun_count=(\d+)`           |
| skipped      | `skipped=(\d+)`                |
| deferred     | `deferred=(\d+)`               |
| errors       | `errors=(\d+)`                 |
| total        | `total=(\d+)`                  |
| vcenters     | `vcenters=([^\s\|]+)`          |
| datastores   | `datastores=(\d+)`             |
| lockReleased | `lockReleased=(\w+)`           |
