# Remove Old Files (UNC Share) — Implementation Guide

**Deliverable:** Remove-OldFiles-UNCShare
**Project:** Ansible → VCF Orchestrator transition — "Move Windows Event Logs"
**Platform:** VCF Automation 9 / VCF Operations Orchestrator 9
**Status:** Phase 1
**This set:** 01 Executive Summary · 02 Design Document · 03 Implementation Guide · 04 User Guide · 05 Validation & Testing Plan · WindowsLogManagement-Config_definition
**Shared references:** ../../_Shared/Documentation/Shared-Components.md · ../../_Shared/Documentation/Change-Register.md · ../../_Shared/Documentation/Ansible-to-vRO-MappingTable.md · "How to Build a PowerShell Host" (Automation Projects/_Shared References/PowerShell Host Build Guide/)

> Follow the phases in order. Later phases depend on earlier ones.

---

## Prerequisites

- **PowerShell (PS) host** built and registered in Orchestrator — full procedure
  (WinRM HTTPS listener 5986, certificate, authentication, Kerberos/`krb5.conf`,
  host registration) is in the shared **"How to Build a PowerShell Host"** guide.
- **Updated `cvs_functions.ps1`** deployed on the PS host, including the S-1
  `-ReportOnly` change (see shared Change-Register).
- **UNC archive share** reachable from the PS host with **write/delete** access for
  the service account.
- **VCF Orchestrator 9** with the PowerShell plug-in and administrative access.
- Network: Orchestrator → PS host **TCP 5986**; PS host → the UNC share (SMB 445).

---

## Phase 1 — PS host build, script deploy, cert trust, auth, register

These are **shared** setup steps common to this deliverable and a separate one.
Perform them per the shared **PS-Host guide**; summary only here.

| Step | What | Reference |
|---|---|---|
| Build PS host | RSAT (not required by this workflow), WinRM HTTPS listener 5986, certificate, firewall, service account | PS-Host guide |
| Deploy script | Copy the updated `cvs_functions.ps1` to e.g. `C:\PSO\Scripts\cvs_functions.ps1` | PS-Host guide, Change-Register |
| Confirm S-1 | Verify `-ReportOnly` present: `Get-Content '<path>' \| Select-String 'ReportOnly'` → matches | Validation A11 |
| Cert trust | Import the PS host cert (Base-64/PEM) to the Orchestrator SSL Trust Manager | PS-Host guide |
| Authentication | Basic-over-HTTPS (lab) or Kerberos + constrained delegation (prod) | PS-Host guide |
| Register host | *Library > PowerShell > Configuration > Add a PowerShell host* (HTTPS, 5986, UPN username) | PS-Host guide |

> The second hop for this workflow is **PS host → `\\fileshare`** only (no source
> servers). The host authentication must carry the credential for that hop, and
> the service account needs **write/delete** on the share.

---

## Phase 2 — Create the Configuration Element

Create `VCF/WindowsLogManagement/WindowsLogManagement-Config` (see
`WindowsLogManagement-Config_definition.md`). This element is used **only** by this
workflow.

1. *vRO → Configuration tab →* navigate to / create folder `VCF / WindowsLogManagement`.
2. *New Configuration Element →* Name: `WindowsLogManagement-Config`.
3. Add the two attributes:

   | Attribute | Type | Example |
   |---|---|---|
   | `defaultScriptPath` | string | `C:\PSO\Scripts\cvs_functions.ps1` |
   | `defaultLogRetentionDays` | number | `370` |

4. Set `defaultScriptPath` to the actual deployed path (must match exactly). Save.

---

## Phase 3 — Import the action

Import into module `broadcom.pso.vc.vm.guestOps.files.windows.logs`:

- **`buildRemoveFilesInvocation`** — return type **string**. Copy the
  `Code/buildRemoveFilesInvocation.js` body.
- **`parseScriptOutput`** — return type **Properties** — **shared**; import once if
  not already present (see Shared-Components.md). Returns
  `Properties{success, outputText, errorText}`.

---

## Phase 4 — Build the workflow schema

Build **Remove-OldFiles-UNCShare** per `Remove-OldFiles-UNCShare_spec.js` in folder
`Production > Servers > Windows > Event Log Management` (lab/dev under
`Workflows > Customer > <Customer Name> > …`).

**Inputs**

| Name | Type | Default | Form |
|---|---|---|---|
| `psHost` | `PowerShell:PowerShellHost` | (none) | Mandatory |
| `scriptPath` | string | `defaultScriptPath` (Config Element) | Mandatory |
| `uncSharePath` | string | (none) | Mandatory |
| `olderThanDays` | number | `defaultLogRetentionDays` (Config Element) | Mandatory, min value = 1 |
| `whatIf` | string | `yes` | Mandatory, dropdown yes / no |

**Attributes:** `invocationString` (string), `psRawOutput`
(`PowerShell:PowerShellRemotePSObject`), `parsedResult` (Properties).

**Outputs:** `executionSuccess` (boolean), `executionOutput` (string).

**Wiring** (from the spec):

```
Start
  → buildRemoveFilesInvocation
        IN  scriptPath, uncSharePath, olderThanDays, whatIf
        OUT invocationString
        [Exception] → End - Failed: Bad Inputs
  → Invoke a PowerShell script (OOTB)
        IN  host ← psHost, script ← invocationString
        OUT output → psRawOutput
        [Exception] → handlePSFailure → End - Failed: PS Execution
  → parseScriptOutput
        IN  psOutput ← psRawOutput, executionContext ← uncSharePath
        OUT parsedResult
  → Decision: parsedResult.get("success") === true
        true  → End - Completed Successfully
        false → End - Completed with Errors
```

End-state scriptable tasks — copy from `Remove-OldFiles-UNCShare_spec.js`:
- Completed Successfully: `executionSuccess = true; executionOutput = parsedResult.get("outputText")`.
- Completed with Errors: `executionSuccess = false; executionOutput = "Script completed with errors… Error: " + parsedResult.get("errorText")`.

---

## Phase 5 — Custom form

- Mark all inputs **mandatory**.
- Bind `scriptPath` default → `defaultScriptPath`; `olderThanDays` default →
  `defaultLogRetentionDays` (Config Element bindings).
- `whatIf` dropdown (default `yes`):
  - `Yes - Report only (no deletions)` → value `yes`
  - `No  - Delete files for real` → value `no`
- `olderThanDays` **minimum value = 1**; add a description e.g. "Files older than
  this many days will be removed (or reported if whatIf=yes). Default 370 (~13 months)."

---

## Phase 6 — Validation gate

Run the plan in `05_Validation_and_Testing_Plan.md`. Minimum gate:

- **`-ReportOnly` deployed** (A11) confirmed on the PS host.
- **UNC write/delete** access from the PS host under the service account (A8).
- **Report-only run** (D3): `whatIf='yes'` completes non-interactively, lists
  `[ReportOnly] WouldDelete:` lines, deletes nothing, Deletion Summary = 0.
- **Live delete** (D2): only after a reviewed preview, `whatIf='no'` against a
  non-production share deletes exactly the aged test files.

---

## Rollback considerations

- **Workflow / action / Config Element:** all items are new — disable or delete the
  imported Orchestrator objects; no existing vRO content is modified. The OOTB
  *Invoke a PowerShell script* workflow is not modified.
- **PS host script:** retain the previous `cvs_functions.ps1`; redeploy to revert
  (note: reverting S-1 restores the blocking `Read-Host` prompt under vRO).
- **Data — deletions are permanent.** There is **no automated recovery** for files
  deleted with `whatIf='no'`. Mitigation: always run report-only and review the
  `WouldDelete` list before any live delete. Ansible remains available as a fallback
  until cutover is confirmed.
