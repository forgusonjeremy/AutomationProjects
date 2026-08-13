# Design Document — Datastore Capacity Reporting

**Workflow:** Get Datastore Capacity Report
**Package:** `com.broadcom.pso.vc.storage.reporting`
**Platform:** VCF Automation 9 / VCF Operations Orchestrator 9 (validated against the embedded Orchestrator)
**Date:** 2026-08-10

---

## 1. Architecture overview

A single scheduled workflow reads datastore capacity from every registered vCenter
through the Orchestrator vCenter plug-in, bands the results by percent used, renders
an HTML report and emails it through the Mail plug-in.

```
  ┌──────────────────────────── VCF Operations Orchestrator ────────────────────────────┐
  │                                                                                     │
  │   Scheduler ──► Workflow: Get Datastore Capacity Report                             │
  │                    │                                                                │
  │                    ├─ ST-01 Initialise ─── validate inputs, stamp runId,            │
  │                    │                       resolve target vCenters                  │
  │                    │                                                                │
  │                    ├─ ST-02 Collect ────── per vCenter, inside try/catch:           │
  │                    │        └─ action getDatastoreCapacity ──┐                      │
  │                    │                                         │                      │
  │                    ├─ ST-03 Band & sort ── single source of truth for banding       │
  │                    │                                         │                      │
  │                    ├─ ST-04 Build report ─ action buildDatastoreReportHtml          │
  │                    │                                         │                      │
  │                    ├─ ST-05 Send ───────── Mail plug-in ─────┼──► SMTP relay :25    │
  │                    │                                         │                      │
  │                    └─ ST-06 Finalise ───── classify outcome  │                      │
  │                                                              │                      │
  │   [EH] Exception handler ─ writes any built report to the transcript                │
  └──────────────────────────────────────────────────────────────┼──────────────────────┘
                                                                 │
                              vCenter plug-in SDK connections ───┼──► vc01, vc02,
                                (read-only, registered endpoints)     vcb01, vcb02, vc
```

**No PowerShell host. No PowerCLI. No WinRM. No configuration elements.**

---

## 2. Components

| Component | Type | Responsibility |
|---|---|---|
| **Get Datastore Capacity Report** | Workflow | Orchestration, input validation, banding, outcome classification |
| **getDatastoreCapacity** | Action | Inventory **one** vCenter. Returns datastores at or above a floor, plus a skip list. Never throws for a per-datastore problem. |
| **buildDatastoreReportHtml** | Action | Pure renderer. Draws exactly what it is given — no bucketing, sorting or filtering of its own. |
| vCenter plug-in | Platform | `VcPlugin.allSdkConnections`, `VcSdkConnection.getAllDatastores()`, `rootFolder` traversal |
| Mail plug-in | Platform | `EmailMessage` |

### 2.1 Why banding lives in ST-03 and not in the renderer

The mail **subject** carries the band counts and the mail **body** carries the band
tables. If both derived their own bands, a future edit to either could put a subject
reading "3 critical" on a body showing four. ST-03 is the only place a datastore is
assigned to a band; ST-04 renders the result and ST-03 writes the subject from the
same arrays.

### 2.2 Why collection is per-vCenter rather than estate-wide

`getDatastoreCapacity` takes exactly one connection. That is what makes the
per-vCenter `try`/`catch` in ST-02 possible, which is the fix for the most damaging
defect in the retiring implementation — a single unreachable vCenter producing no
report at all.

---

## 3. Data flow

| Stage | Produces | Shape |
|---|---|---|
| ST-01 | `runId`, `targetConnections` | `DSR-YYYY-MM-DDTHH-MM-SS`; array of SDK connections |
| ST-02 | `collectedJson` | Flat array of datastore records, merged across vCenters |
| ST-02 | `failuresJson` | `[{ vcenterName, error }]` — vCenters that could not be scanned |
| ST-02 | `skippedJson` | `[{ vcenterName, name, moRef, reason }]` — datastores that could not be read |
| ST-02 | `scanSummaryJson` | Run-level counters for the report header |
| ST-03 | `bandedJson` | `{ critical[], warning[], advisory[], meta{} }`, each sorted worst-first |
| ST-03 | `mailSubject`, `criticalCount`, `warningCount`, `advisoryCount`, `outcome` | |
| ST-04 | `reportHtml` | Complete HTML document |
| ST-05 | `mailSent` | boolean |

**Datastore record** (one row):

```
name, moRef, vcenterName, datacenter, datastoreCluster, type,
accessible, maintenanceMode, capacityGB, usedGB, freeSpaceGB,
uncommittedGB, uncommittedKnown, percentUsed, percentFree, overcommitted
```

### 3.1 Banding

Bands are **derived**, not independently entered:

```
criticalFloor = thresholdHighPct                  (default 90)
warningFloor  = thresholdHighPct -     bandWidth  (default 80)
advisoryFloor = thresholdHighPct - 2 × bandWidth  (default 70)  ← reporting floor
```

Intervals are **half-open** — `[floor, ceiling)` — so every value from the reporting
floor to 100% lands in exactly one band and a boundary value lands in the more severe
one. Because both edges are derived from two inputs, the bands cannot be made to
overlap or invert by operator error; ST-01 rejects a combination whose floor would
reach zero.

`percentUsed` is computed as `round((used / capacity) × 10000) / 100` — the same
two-decimal rounding the retiring PowerShell used, so band membership is directly
comparable during the parallel run.

### 3.2 Row identity

**vCenter name + MoRef.** Never the display name. This is what allows identically
named datastores on different vCenters to coexist on one report.

### 3.3 Placement resolution (Datacenter / Datastore Cluster)

Built top-down from `rootFolder → Datacenter → datastoreFolder`, recursing through
nested folders and StoragePods. Branching is on the MoRef id prefix
(`datastore-`, `group-p`, `group-s`) rather than a type name, which is stable across
releases.

**Placement is presentation detail only.** The traversal is wrapped so that a failure
leaves the map incomplete and the affected columns blank, and warns — it can never
cost the capacity data. Verified as test T-11.

---

## 4. Dependencies

| Dependency | Requirement |
|---|---|
| VCF Operations Orchestrator | 8.11+; validated against the VCF 9 embedded Orchestrator |
| vCenter plug-in | Every vCenter to be reported registered under **Administration → vCenter Server** |
| vCenter permissions | **Read-only at the root** of each inventory. No write permission is needed or used. |
| Mail plug-in | Reachable SMTP relay, only when `sendEmail` is true |
| Other packages in this programme | **None.** This package is standalone. It shares only the log-marker convention with Snapshot Cleanup. |
| `cvs_functions.ps1` | **None.** Not called, not modified. |

---

## 5. Assumptions

1. Every vCenter in scope is registered in Orchestrator. An unregistered vCenter is
   invisible to the report and will not be flagged as missing — the run has no
   external list to compare against. This is the trade for eliminating the hardcoded
   hostname string.
2. `DatastoreSummary.capacity`, `.freeSpace`, `.accessible` and `.type` are published
   for every datastore. `.uncommitted` is **optional** in the vSphere API and is
   handled as possibly absent.
3. A datastore reporting `capacity = 0` is not meaningfully evaluable and is skipped
   with a reason rather than reported as 0% or 100%.
4. Recipients read the email, not the Orchestrator log. Anything that affects how the
   report should be interpreted is rendered into the report itself.
5. The SMTP relay accepts anonymous submission, as it does today from the Windows
   host. Authentication is supported but unset by default.

---

## 6. Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| 1 | **Report volume rises sharply**, reading as estate deterioration | Recipient briefing before first send; Change Register §6 |
| 2 | An **unregistered vCenter** is silently out of scope (assumption 1) | Report header states *vCenters scanned: n of m*; endpoint registration is a documented deployment check |
| 3 | **Inventory sweep duration** grows with estate size; the run is synchronous | Read-only and lock-free, so overlapping runs are harmless. Schedule outside change windows for tidiness only. |
| 4 | **SMTP source change** — relay may not accept the appliance | Deployment-time verification step; `sendEmail=false` allows a full dry run first |
| 5 | A **vCenter plug-in session expiring mid-sweep** fails that vCenter | Isolated by the per-vCenter `try`/`catch`; the vCenter is named in the report and the run classifies `COMPLETE_WITH_GAPS` |
| 6 | **Very large estates** produce a large HTML email | Rows are bounded by the reporting floor, not by the estate size. Raise `thresholdHighPct` or narrow `bandWidthPct` to shorten the report. |

---

## 7. Security considerations

- **Read-only by construction.** The workflow issues no write of any kind against
  vCenter. There is no `whatIf` gate because there is nothing to gate.
- **Credential surface reduced.** The retiring implementation required vCenter
  credentials available to PowerCLI on a Windows host, reached over WinRM, with
  Kerberos delegation for the second hop. All of that is removed; the workflow uses
  the vCenter endpoint credential already held by Orchestrator.
- **No code is staged anywhere.** `win_copy` of the shared script onto a temp
  directory on a Windows host is gone, along with the cleanup step it required.
- **Output escaping.** Datastore names are operator-supplied free text arriving from
  vCenter and are HTML-escaped before being concatenated into the report. Verified as
  test T-12.
- **SMTP credentials**, where used, are a `SecureString` input. Unset by default.
- **Log content.** The run log records datastore names, capacities and vCenter names —
  the same content as the email. No credentials are logged. The exception handler
  writes the full report body into the transcript on a late failure; treat run logs
  with the same sensitivity as the report itself.

---

## 8. Operational considerations

### Outcome classification

Deliberately more granular than success/failure, because *"completed but could not
reach one of five vCenters"* is not the same as a clean run and must not be reported
as one.

| Outcome | Meaning | Action |
|---|---|---|
| `COMPLETE` | All vCenters scanned, findings reported | None |
| `CLEAN_NO_FINDINGS` | All vCenters scanned, nothing at or above the floor | None |
| `COMPLETE_WITH_GAPS` | At least one vCenter could not be scanned | **Investigate** — counts are a floor, not a total |
| `ERROR` | Run failed, including delivery failure | Investigate; report may be recoverable from the transcript |

### Logging

Every line is `[DATASTORE-REPORT] [PHASE] [STATUS] message`. Phases: `STARTUP`,
`INVENTORY`, `ANALYSIS`, `REPORT`, `NOTIFY`, `FINALISE`, `ERROR`. A single filter on
`[DATASTORE-REPORT]` in VCF Operations for Logs returns the whole run. The convention
matches the Snapshot Cleanup package, so one dashboard can carry both storage
workflows.

### Failure handling

- **Per-vCenter:** caught, recorded, run continues.
- **Per-datastore:** caught, recorded with a reason, sweep continues.
- **Delivery:** raises. A report nobody received is not a success. The exception
  handler writes the already-built report into the transcript so a late failure does
  not discard the estate sweep.

### Concurrency

No lock and no mutex. The workflow is read-only, so a run overrun by the next
schedule costs duplicate emails and nothing else. This is the deliberate difference
from Snapshot Cleanup, which must serialise.

### Scheduling

Set defaults on the workflow **Inputs** tab, then create the recurring task under the
Orchestrator Scheduler. This replaces the Ansible job template schedule.
