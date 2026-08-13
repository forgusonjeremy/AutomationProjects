# Implementation Guide — Datastore Capacity Reporting

**Workflow:** Get Datastore Capacity Report
**Package:** `com.broadcom.pso.vc.storage.reporting`
**Platform:** VCF Automation 9 / VCF Operations Orchestrator 9
**Date:** 2026-08-10

---

## 1. Prerequisites

| # | Requirement | Verification |
|---|---|---|
| 1 | VCF Operations Orchestrator 8.11+ | **About** in the Orchestrator client |
| 2 | **Every** vCenter in scope registered under **Administration → vCenter Server** | Count the endpoints. Today's scope is five: `vc01`, `vc02`, `vcb01`, `vcb02`, `vc` — all `.corp.local` |
| 3 | Each vCenter endpoint account holds **read-only at the root** of the inventory | vCenter → **Administration → Roles / Global Permissions**. No write permission is needed or used |
| 4 | SMTP relay reachable **from the Orchestrator appliance** on the submission port | §6, step 2 |
| 5 | A `From` address the relay will accept | Default pattern `vro_Do_Not_Reply@<domain>`, mirroring the retiring script's `<COMPUTERNAME>_Do_Not_Reply@vcf.lab` |

**Not required, and deliberately so:** no PowerShell host, no PowerCLI, no WinRM
listener, no Kerberos constrained delegation, no configuration elements, no
dependency on any other package in this programme.

> **Prerequisite 2 is the one that changes the report's scope.** The vCenter list is
> no longer a string in `vars.txt` — it is whatever is registered in Orchestrator. An
> unregistered vCenter is silently out of scope. Confirm the count before go-live.

---

## 2. Package contents

```
com.broadcom.pso.vc.storage.reporting
├── Workflow : Get Datastore Capacity Report
├── Action   : getDatastoreCapacity
└── Action   : buildDatastoreReportHtml
```

Source of record is [../Code/](../Code/). `Get-DatastoreCapacityReport_spec.js`
documents the as-built workflow — schema, inputs, attributes and outputs — and must be
updated whenever the workflow is edited on the appliance.

---

## 3. Import

### Option A — import the package (preferred)

1. Orchestrator client → **Assets → Packages → Import Package**.
2. Select `com.broadcom.pso.vc.storage.reporting.package`.
3. On the conflict screen, verify **no** existing element is being overwritten. This
   package shares no elements with any other in the programme.
4. Import, then confirm the workflow and both actions are present.

### Option B — build by hand

Use this when the package file is unavailable or when reviewing element by element.

1. **Create the module.** Design → **Actions** → New Module →
   `com.broadcom.pso.vc.storage.reporting`.

2. **Create action `getDatastoreCapacity`.**

   | Input | Type |
   |---|---|
   | `vcenterSdkConnection` | `VC:SdkConnection` |
   | `minPercentUsed` | `number` |
   | `includeInaccessible` | `boolean` |

   Return type `string`. Paste [../Code/getDatastoreCapacity.js](../Code/getDatastoreCapacity.js).

3. **Create action `buildDatastoreReportHtml`.**

   | Input | Type |
   |---|---|
   | `bandedJson` | `string` |
   | `failuresJson` | `string` |
   | `skippedJson` | `string` |
   | `scanSummaryJson` | `string` |

   Return type `string`. Paste [../Code/buildDatastoreReportHtml.js](../Code/buildDatastoreReportHtml.js).

4. **Create the workflow** `Get Datastore Capacity Report` in
   *Production → VMware → vCenter → Storage → Reporting*.

5. **Add inputs** — §4.

6. **Add attributes** — §5.

7. **Build the schema** — §6.

8. **Add the exception handler** — §7.

---

## 4. Workflow inputs

| Name | Type | Default | Notes |
|---|---|---|---|
| `vCenterConnections` | `Array/VC:SdkConnection` | *(empty)* | Empty = every registered vCenter. Populate only to narrow a run. |
| `thresholdHighPct` | `number` | `90` | Floor of the Critical band |
| `bandWidthPct` | `number` | `10` | Width of each band below it |
| `includeInaccessible` | `boolean` | `false` | Report datastores vCenter currently reports as inaccessible |
| `sendEmail` | `boolean` | `true` | `false` = build and return the report, send nothing |
| `smtpHost` | `string` | `mailrelay.corp.local` | Required when `sendEmail` |
| `smtpPort` | `number` | `25` | |
| `smtpUseSsl` | `boolean` | `false` | |
| `smtpUsername` | `string` | *(empty)* | Empty = anonymous submission, matching the current relay |
| `smtpPassword` | `SecureString` | *(empty)* | |
| `mailFrom` | `string` | `vro_Do_Not_Reply@vcf.lab` | |
| `mailTo` | `Array/string` | `On-PremEngineering@corp.local` | At least one valid address required when `sendEmail` |
| `mailCc` | `Array/string` | `Monitoring@corp.local` | Optional. Blank entries are stripped, not rejected |
| `mailSubjectPrefix` | `string` | `VCF-Orchestrator-Report: Datastore Report` | |

**Mapping from `vars.txt`:**

| `vars.txt` | Workflow input |
|---|---|
| `var_vCenterList` | *(retired — read from registered endpoints)* |
| `var_eMailReport: 'yes'` | `sendEmail: true` |
| `var_SMTPServer` | `smtpHost` |
| `var_MailToString` | `mailTo` *(array, not a comma-string)* |
| `var_MailCcString` | `mailCc` *(array)* |
| `var_MailSubjectstring` | `mailSubjectPrefix` |
| `var_ps_folder`, `var_ps_script_file`, `var_parameter_action`, `var_cleanup_temporary_folder` | *(retired — no script is staged)* |

Defaults are set on the **Inputs** tab so the scheduled task carries no parameters of
its own.

---

## 5. Workflow attributes

| Name | Type | Initial value |
|---|---|---|
| `runId` | `string` | *(empty)* |
| `startedAtIso` | `string` | *(empty)* |
| `targetConnections` | `Array/VC:SdkConnection` | *(empty)* |
| `collectedJson` | `string` | `[]` |
| `failuresJson` | `string` | `[]` |
| `skippedJson` | `string` | `[]` |
| `scanSummaryJson` | `string` | *(empty)* |
| `bandedJson` | `string` | *(empty)* |
| `mailSubject` | `string` | *(empty)* |
| `mailSent` | `boolean` | `false` |

**Outputs:** `reportHtml` (string), `outcome` (string), `criticalCount`,
`warningCount`, `advisoryCount` (number).

---

## 6. Schema

```
[Start]
  ▼
ST-01 Initialise Run           ← root element
  ▼
ST-02 Collect Datastores
  ▼
ST-03 Band and Sort
  ▼
ST-04 Build Report
  ▼
[Decision]  return (sendEmail == true)
  ├─ true  → ST-05 Send Report ─┐
  └─ false ─────────────────────┤
                                ▼
                        ST-06 Finalise
                                ▼
                             [End]
```

Create six scriptable tasks and one decision element. For each task, paste the
matching file from [../Code/](../Code/) and bind the IN/OUT parameters listed in that
file's header comment.

| Element | Source |
|---|---|
| ST-01 Initialise Run | [ST-01_InitialiseRun.js](../Code/ST-01_InitialiseRun.js) |
| ST-02 Collect Datastores | [ST-02_CollectDatastores.js](../Code/ST-02_CollectDatastores.js) |
| ST-03 Band and Sort | [ST-03_BandAndSort.js](../Code/ST-03_BandAndSort.js) |
| ST-04 Build Report | [ST-04_BuildReport.js](../Code/ST-04_BuildReport.js) |
| ST-05 Send Report | [ST-05_SendReport.js](../Code/ST-05_SendReport.js) |
| ST-06 Finalise | [ST-06_Finalise.js](../Code/ST-06_Finalise.js) |

**Binding notes**

- Every task both reads and writes attributes. A task that writes an attribute must
  have it bound as an **OUT** parameter, not IN only — this is the most common
  hand-build error and it fails silently, leaving the attribute empty downstream.
- ST-05 also checks `sendEmail` internally. The decision element exists so the branch
  is visible in the schema; the internal check means the task is also safe to run
  directly during testing.
- The decision element's condition is `return (sendEmail == true);`.

---

## 7. Exception handler

1. Add a scriptable task **outside** the main flow; paste
   [EH_ExceptionHandler.js](../Code/EH_ExceptionHandler.js).
2. Bind IN: `errorCode` (the workflow's error binding), `runId`, `reportHtml`,
   `collectedJson`, `failuresJson`. Bind OUT: `outcome`.
3. Set it as the workflow's exception handler and connect it to a **failure** end
   element.

The handler writes any already-built report into the transcript, so a failure at the
delivery step does not discard the entire estate sweep.

---

## 8. Validation before go-live

Run in this order. Full detail and expected output in
[05_Validation_and_Testing_Plan.md](05_Validation_and_Testing_Plan.md).

1. **Offline suite** — `node lab/Run-AllTests.js`. Expect `PASSED: 112  FAILED: 0`.
   Proves the logic; does not touch the appliance.
2. **Dry run, no mail** — run the workflow with `sendEmail = false`. Check
   `reportHtml` in the run's **Variables** tab and the log for
   `[DATASTORE-REPORT] [FINALISE] [RESULT]`.
3. **Endpoint coverage** — confirm the report header reads *vCenters scanned: n of n*
   with `n` equal to the number of vCenters in scope. Any shortfall means an
   unregistered or unreachable endpoint.
4. **Mail path** — set `mailTo` to your own address, `sendEmail = true`. Confirm
   delivery, subject format and rendering in the recipients' actual mail client.
5. **Narrowed run** — populate `vCenterConnections` with one vCenter and confirm the
   report scopes to it.
6. **Gap handling** — temporarily disable one vCenter endpoint's credentials, re-run,
   and confirm the report is still delivered, carries the incomplete-scan banner
   naming that vCenter, and the run ends `COMPLETE_WITH_GAPS`.
7. **Parallel run** against the Ansible report — see §9.

---

## 9. Cutover

| # | Step |
|---|---|
| 1 | **Brief the recipients.** The report will get longer. Use the wording in Change Register §6. **Do not skip this** — it is the primary go-live risk. |
| 2 | Schedule the workflow under **Orchestrator → Scheduler**, matching the Ansible job template's cadence. |
| 3 | Run both in parallel for at least two scheduled cycles. |
| 4 | Compare **membership**, not counts. The new report must be a **strict superset** of the Ansible one. Anything present in the old and absent from the new is a regression and blocks cutover. |
| 5 | Resolve the two configuration questions in Change Register §1B — the 90-vs-95 threshold and the 70-vs-75 floor. |
| 6 | Disable the Ansible job template. |
| 7 | Retire the WinRM/PowerCLI prerequisites on the Windows host **only if** no other job template still needs them. Several do — check first. |

---

## 10. Version-specific considerations

| Item | Note |
|---|---|
| vCenter plug-in methods | `VcPlugin.allSdkConnections`, `VcSdkConnection.getAllDatastores()` and `rootFolder` traversal are used identically by the delivered Snapshot Cleanup package on this platform. |
| `DatastoreSummary.uncommitted` | **Optional** in the vSphere API. Handled as possibly absent; renders `unknown` rather than a misleading `No`. |
| MoRef id prefixes | Placement resolution branches on `datastore-`, `group-p`, `group-s`. Stable across supported releases, and wrapped so a failure degrades to blank columns. |
| `EmailMessage` | Standard Mail plug-in class. Properties used: `smtpHost`, `smtpPort`, `useSsl`, `username`, `password`, `fromAddress`, `fromName`, `toAddress`, `ccAddress`, `subject`, `addMimePart`, `sendMessage`. |
| JavaScript engine | Written to ES5 with explicit `for` loops and no engine-specific syntax, so it runs unchanged on both the legacy Rhino runtime and later JavaScript runtimes. |

---

## 11. Rollback

Rollback is trivial because nothing outside Orchestrator is modified.

| Scenario | Action |
|---|---|
| Report is wrong or unwanted | Disable the scheduled task. The Ansible job template is untouched and resumes on its own schedule. |
| Package causes a problem | Delete the package and its two actions. No other package depends on it. |
| Mid-parallel-run abort | Disable the Orchestrator schedule only. No cleanup is required — the workflow is read-only, holds no lock and leaves no state anywhere. |
| Shared PowerShell script | **Nothing to roll back.** `cvs_functions.ps1` is not modified by this deliverable. |
