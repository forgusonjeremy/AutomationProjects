# Remove Old Files (UNC Share) — Design Document

**Deliverable:** Remove-OldFiles-UNCShare
**Project:** Ansible → VCF Orchestrator transition — "Move Windows Event Logs"
**Platform:** VCF Automation 9 / VCF Operations Orchestrator 9
**Status:** Phase 1
**This set:** 01 Executive Summary · 02 Design Document · 03 Implementation Guide · 04 User Guide · 05 Validation & Testing Plan · WindowsLogManagement-Config_definition
**Shared references:** ../../_Shared/Documentation/Shared-Components.md · ../../_Shared/Documentation/Change-Register.md · ../../_Shared/Documentation/Ansible-to-vRO-MappingTable.md · "How to Build a PowerShell Host" (Automation Projects/_Shared References/PowerShell Host Build Guide/)

---

## 1. Architecture overview

The workflow builds a single PowerShell invocation string, executes it on a
pre-staged PS host via the OOTB *Invoke a PowerShell script* workflow, and parses
the result. All file selection and deletion happen **inside `cvs_functions.ps1`**
against a **single UNC target** — there is no AD resolution and no per-server loop.

```
Operator (custom form)
      │
      ▼
vRO Workflow ── buildRemoveFilesInvocation (Action) ── invocation string
      │                                                     │
      │            OOTB "Invoke a PowerShell script" (WinRM/HTTPS 5986)
      │                                                     ▼
      │                                          PowerShell Host ── cvs_functions.ps1
      │                                                     │  Delete-OldFiles-UNC-Share
      │                                                     ▼
      │                                          \\fileshare (the UNC share cleaned)
      ▼
 parseScriptOutput (Action) ── success/error ── End state
```

- **One invocation = one workflow run.** No Orchestrator-side loop.
- **No source-server or AD access** — the only remote target is the UNC share.

---

## 2. Components

| Component | Role | Shared? |
|---|---|---|
| **Workflow: Remove-OldFiles-UNCShare** | Deletes files on a UNC share older than a threshold; report-only default | This deliverable |
| **Action: buildRemoveFilesInvocation** | Builds the `Delete-OldFiles-UNC-Share` invocation string; validates inputs; returns `string` | This deliverable |
| **Action: parseScriptOutput** | Parses the PS output object → `Properties{success, outputText, errorText}` | Shared — see Shared-Components.md |
| **Scriptable task: handlePSFailure** | Exception path for terminating PS/plugin failures | Shared — see Shared-Components.md |
| **OOTB: Invoke a PowerShell script** | Executes the invocation string on the PS host | Shared — see Shared-Components.md |
| **Configuration Element: WindowsLogManagement-Config** | Supplies `defaultScriptPath` → `scriptPath` and `defaultLogRetentionDays` → `olderThanDays`. Used **only** by this workflow | This deliverable |
| **PowerShell host** | Windows Server running `cvs_functions.ps1`; reaches the UNC share | Shared — see PS-Host guide |
| **cvs_functions.ps1** | Shared PowerShell toolbox; changes S-1…S-5 | Shared — see Change-Register |

**Module namespace (action):** `broadcom.pso.vc.vm.guestOps.files.windows.logs`
**Workflow folder:** `Production > Servers > Windows > Event Log Management`
(lab/dev: `Workflows > Customer > <Customer Name> > Production > Servers > Windows > Event Log Management`)

---

## 3. Data flow

Per the workflow spec (`Remove-OldFiles-UNCShare_spec.js`):

1. **`buildRemoveFilesInvocation`** validates inputs and returns:
   ```
   & "<scriptPath>" -Action 'Delete-OldFiles-UNC-Share' -UNC_SharePath '<path>' -OlderThanDays <n> -WhatIf '<yes|no>' *>&1 | Out-String -Width 4096
   ```
   - `-UNC_SharePath` has an **underscore**.
   - `-OlderThanDays` is an **unquoted numeric** value.
   - `-WhatIf` is `'yes'` or `'no'` — any other value throws (bad input).
   - The `*>&1 | Out-String -Width 4096` stream-capture suffix is required so the
     PS plug-in returns the log text for parsing (see Shared-Components.md).
   - Exception → **End - Failed: Bad Inputs**.
2. **OOTB *Invoke a PowerShell script*** runs the string on `psHost`
   (`output → psRawOutput`). Exception → `handlePSFailure` → **End - Failed: PS Execution**.
3. **`parseScriptOutput`** (`psOutput ← psRawOutput`, `executionContext ← uncSharePath`)
   returns `parsedResult` (`Properties{success, outputText, errorText}`).
4. **Decision** `parsedResult.get("success") === true`:
   - `true` → **End - Completed Successfully** (`executionSuccess = true`,
     `executionOutput = parsedResult.get("outputText")`).
   - `false` → **End - Completed with Errors** (`executionSuccess = false`,
     `executionOutput` = "Script completed with errors…" + `errorText`).

### whatIf → script behaviour mapping (S-1)

| `whatIf` input | `Delete-OldFiles-UNC-Share` switch calls | Effect |
|---|---|---|
| `yes` (default) | `Remove-OldFiles-UNCPath … -ReportOnly $true` | Lists `[ReportOnly] WouldDelete: <file>` lines, **deletes nothing**, runs non-interactively (no `Read-Host`) |
| `no` | `Remove-OldFiles-UNCPath … -Force $true` | **Live delete**, no prompt |
| any other value | (none) | Logs an `Error:` line → parsed as `success=false` |

---

## 4. Failure-handling contract

| Condition | Behaviour | End state |
|---|---|---|
| Input validation fails (empty path, `olderThanDays < 1`, invalid `whatIf`) | `buildRemoveFilesInvocation` throws | **Failed: Bad Inputs** |
| PS host unreachable / plug-in / terminating PS error | Exception → `handlePSFailure` | **Failed: PS Execution** |
| Invalid `whatIf` value reaches the script | Script logs `Error:` line | **Completed with Errors** |
| Deletion/report completes, no `Error:` lines | `success=true` | **Completed Successfully** |
| Script runs but emits `Error:` lines (e.g. access issue on the share) | `success=false` | **Completed with Errors** |

---

## 5. Dependencies

- **PowerShell host** (Windows Server) with the updated `cvs_functions.ps1`
  deployed, and network reach to the UNC archive share (shared — PS-Host guide,
  Change-Register).
- **`-ReportOnly` present** in the deployed `cvs_functions.ps1` (change S-1) —
  required before relying on `whatIf='yes'`.
- **UNC archive share** with **write/delete** access for the PS host service account.
- **VCF Orchestrator 9** with the PowerShell plug-in and a registered PS host.
- **Certificate trust** between Orchestrator and the PS host.

---

## 6. Assumptions

- The PS host service account has write/delete permission on the target share.
- The updated `cvs_functions.ps1` (S-1…S-5) is the deployed version.
- `Delete-OldFiles-UNC-Share` already exists in the deployed script (confirmed).
- Single-node Orchestrator in the lab; clustered deployments replicate host-side
  config on each node.

---

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| **Accidental deletion** — permanent, no auto-recovery | `whatIf` defaults to `yes`; always preview and review `WouldDelete` before setting `no` |
| **Un-patched script** — `whatIf='yes'` blocks on `Read-Host` | Verify `-ReportOnly` present before use (Validation A11) |
| **Second-hop auth** — PS host → `\\fileshare` fails without carried credential | Kerberos + constrained delegation (prod) or Basic-over-HTTPS (lab); validate write/delete access (shared PS-Host guide) |
| **Certificate trust / expiry** | Import cert to trust store; track expiry (shared PS-Host guide) |

---

## 8. Security considerations

- **Transport:** WinRM over **HTTPS (5986)** only; `AllowUnencrypted` stays `false`.
- **Authentication:** Kerberos (preferred, needs constrained delegation for the
  hop to the share) or Basic-over-HTTPS (lab; credential presented to host, carries
  the hop). Detail in the shared PS-Host guide.
- **Credentials:** managed by the Orchestrator PS host configuration; no secrets in
  the workflow or script.
- **Least privilege:** service account scoped to the write/delete it needs on the
  archive share.
- **Destructive action:** `whatIf` is the sole safety control; there is no
  interactive prompt under Orchestrator.

---

## 9. Operational considerations

- **Execution model:** on-demand via custom form, or scheduled. If scheduled with
  `whatIf='no'`, only do so after a verified report-only run for that scope.
- **Idempotency:** re-running is safe — already-deleted files are simply absent on
  the next pass; the report-only default prevents accidental deletion.
- **Observability:** the run log carries the `[ReportOnly] WouldDelete:` /
  Deletion Summary lines; `executionSuccess` / `executionOutput` summarise the result.
- **Maintenance:** monitor certificate expiry; keep the `defaultScriptPath` /
  `defaultLogRetentionDays` Config Element values current.
- **Change control:** `cvs_functions.ps1` changes are tracked in the shared
  Change-Register (S-#).
