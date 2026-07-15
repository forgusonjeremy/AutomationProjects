# Remove Old Files (UNC Share) — Validation & Testing Plan

## Phase A — Environment pre-checks

| ID | Check | Method / expected |
|---|---|---|
| **A1** | PS host configured and registered in vRO | Per the shared **PS-Host guide**; visible in Inventory → PowerShell; smoke test (`Write-Host`) passes |
| **A2** | `PowerShellRemotePSObject.getRootObject()` available | Scripting API Browser → Plugin: PowerShell → type `PowerShellRemotePSObject`; `getRootObject()` exists (used by shared `parseScriptOutput`) |
| **A4** | Script parameter names match | Deployed `cvs_functions.ps1` param block includes `-UNC_SharePath` (underscore), `-OlderThanDays`, `-WhatIf` |
| **A5** | Action value present | `Delete-OldFiles-UNC-Share` present in the deployed script's `ValidateSet` |
| **A6** | Script path correct | `Test-Path 'C:\PSO\Scripts\cvs_functions.ps1'` → `True`. If different, update `defaultScriptPath` |
| **A8** | UNC write/delete access | From the PS host under the service account: create then remove a temp folder on the share, e.g. `New-Item '\\fileserver\mdcarchivelog$\Windows\test-write-check' -ItemType Directory -Force` then `Remove-Item … -Force`. Both succeed |
| **A11** | `-ReportOnly` deployed (change S-1) | `Get-Content '<scriptPath>' \| Select-String 'ReportOnly'` → matches (param declaration + switch usage). If absent, deploy the updated script first, or use `whatIf='no'` only |

---

## Phase B — vRO content deployment

| ID | Check | Expected |
|---|---|---|
| **B1** | Configuration Element | `VCF/WindowsLogManagement/WindowsLogManagement-Config` exists with `defaultScriptPath` (string) and `defaultLogRetentionDays` (number); `defaultScriptPath` matches A6. Move-only attributes are NOT present |
| **B2** | Action deployed | `buildRemoveFilesInvocation` (return type string) in module `broadcom.pso.vc.vm.guestOps.files.windows.logs`; shared `parseScriptOutput` (Properties) present |
| **B3** | Workflow deployed | `Remove-OldFiles-UNCShare` in `Production > Servers > Windows > Event Log Management` (lab/dev under `Workflows > Customer > <Customer Name> > …`) |
| **B4** | OOTB workflow available | `Library/PowerShell/Invoke a PowerShell script` present; returns `PowerShellRemotePSObject` |
| **B5** | Config Element bindings | `scriptPath ← defaultScriptPath`; `olderThanDays ← defaultLogRetentionDays`; `uncSharePath` has NO default; `whatIf` default `yes` |

---

## Phase C — Unit tests (buildRemoveFilesInvocation; parseScriptOutput shared)

| ID | Input | Expected |
|---|---|---|
| **C5** | `scriptPath='C:\PSO\Scripts\cvs_functions.ps1'`, `uncSharePath='\\fileserver\share$\Windows'`, `olderThanDays=370`, `whatIf='no'` | Returns: `& "C:\PSO\Scripts\cvs_functions.ps1" -Action 'Delete-OldFiles-UNC-Share' -UNC_SharePath '\\fileserver\share$\Windows' -OlderThanDays 370 -WhatIf 'no' *>&1 \| Out-String -Width 4096`. `-UNC_SharePath` underscore; `-OlderThanDays` unquoted numeric |
| **C6** | As C5 but `whatIf='yes'` | Same string with `-WhatIf 'yes'`; `System.log` notes report-only mode. Run-time report-only requires the updated script (A11, S-1) |
| **C7** | `olderThanDays=0` | Throws Error containing `must be an integer >= 1` |
| **C8** | `whatIf='maybe'` | Throws Error containing `must be 'yes' or 'no'` |
| **C9** | `parseScriptOutput` — benign output (**shared**, reference) | Returns `Properties{success, outputText, errorText}`; `success=true` for output with no `Error:` line. See Shared-Components.md |
| **C10** | `parseScriptOutput` — `Error:` line detection (**shared**, reference) | `success=false`; `errorText` contains the `Error:` line; `outputText` contains all lines. See Shared-Components.md |

---

## Phase D — Integration tests (non-production share)

| ID | Test | Expected |
|---|---|---|
| **D3** | **Report-only verification** — `whatIf='yes'` against a non-prod share with known aged test files (requires A11) | Completes **non-interactively** (no prompt/block); log lists `[ReportOnly] WouldDelete: <file>` for aged files; **no** files deleted; Deletion Summary reports "Total files deleted: 0" |
| **D2** | **Live delete after preview** — after a reviewed D3 preview, run `whatIf='no'` against the non-prod share | Reaches **End - Completed Successfully**; `executionSuccess=true`; files older than the threshold are deleted; Deletion Summary in the log; no files inside the threshold are deleted |

> Always perform D3 (preview) before D2 (live delete). Deletions are permanent.

---

## Phase E — Success criteria

- [ ] PS host configured/registered and cert trusted (shared); smoke test passes.
- [ ] A11: updated `cvs_functions.ps1` (`-ReportOnly`) deployed; `whatIf='yes'`
      verified report-only (D3).
- [ ] Workflow, action, and Config Element deploy without import errors.
- [ ] Config Element attributes load as defaults in the custom form; `whatIf`
      dropdown and `olderThanDays` minimum = 1 enforced.
- [ ] `buildRemoveFilesInvocation` returns the correctly formatted string using
      `-UNC_SharePath` (underscore) and unquoted `-OlderThanDays` — confirmed in logs.
- [ ] `parseScriptOutput` returns `Properties{success, outputText, errorText}` and
      detects `Error:` lines as `success=false` (shared).
- [ ] `whatIf='yes'` reports only (deletes nothing); `whatIf='no'` deletes exactly
      the aged files on the non-prod test share.
- [ ] Bad inputs route to **Failed: Bad Inputs**; PS/plugin failures route through
      `handlePSFailure` to **Failed: PS Execution**.
- [ ] Runs produce meaningful log output in vRO execution history.

---

## Rollback and recovery

| Item | Approach |
|---|---|
| **Deleted files (whatIf='no')** | **No automated recovery — deletion is permanent.** Mitigation: always run `whatIf='yes'` first and review the `WouldDelete` list before a live delete |
| **cvs_functions.ps1** | Retain the previous version; redeploy to revert (reverting S-1 restores the blocking `Read-Host` prompt under vRO) |
| **vRO content** | All items are new — delete the workflow, `buildRemoveFilesInvocation`, and the Config Element. The OOTB *Invoke a PowerShell script* workflow and shared `parseScriptOutput` are not modified |
| **Config Element** | Delete or edit attribute values to revert defaults; no impact until the workflow runs |
| **PS host registration** | Remove from Inventory → PowerShell if needed (does not change the Windows Server config; revert WinRM per the shared PS-Host guide) |
