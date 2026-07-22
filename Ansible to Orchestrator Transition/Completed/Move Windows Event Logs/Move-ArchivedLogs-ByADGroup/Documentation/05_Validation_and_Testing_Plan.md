# Move Archived Logs (By AD Group) — Validation & Testing Plan

> Scope: Move-ArchivedLogs-ByADGroup only. Shared items are referenced, not re-tested here.

---

## Phase A — Environment pre-checks (before deploying vRO content)

| ID | Check | Expected / action |
|---|---|---|
| **A1** | PS host configured and registered in vRO; smoke test (`Invoke a PowerShell script` + `Write-Host`) passes | Registered and visible in Inventory → PowerShell. Full build/registration → **PS-Host guide** |
| **A2** | `PowerShellRemotePSObject.getRootObject()` available | Method exists and is callable (Scripting API Browser → Plugin: PowerShell). `parseScriptOutput` uses it exclusively |
| **A4** | Script param `-SecurityGroup_CN` present (underscore — not `-SecurityGroupCN`) | Confirmed in the deployed `cvs_functions.ps1` param block |
| **A5** | Action value `move-archived-logs-ByCN` present in the script `ValidateSet` | Confirmed in the deployed script |
| **A6** | Script path on PS host | `Test-Path 'C:\PSO\Scripts\cvs_functions.ps1'` → `True`. If `False`, update the workflow `scriptPath` input default |
| **A7** | Service account UNC **read** access (source) | `Test-Path '\\<target>\C$\Windows\System32\winevt\Logs'` → `True` (run under the vRO service-account context) |
| **A9** | Kerberos constrained delegation (double-hop) configured on the PS host account | Delegation tab: "Trust this computer for delegation to specified services only" set; file-server CIFS SPN listed. If not, engage the AD team before live runs (Kerberos auth path) |
| **A10** | RSAT ActiveDirectory tools on PS host | `Get-Module -ListAvailable ActiveDirectory` lists the module. If not found, install RSAT AD tools before running the workflow |

## Phase B — vRO content deployment checks

| ID | Check | Expected |
|---|---|---|
| **B-A** | Action `buildMoveByADGroupInvocation` deployed | Module `broadcom.pso.vc.vm.guestOps.files.windows.logs`; return type **string** |
| **B-A2** | Action `parseScriptOutput` deployed (shared) | Return type Properties → Shared-Components.md |
| **B-W** | Workflow `Move-ArchivedLogs-ByADGroup` deployed | Folder `Production > Servers > Windows > Event Log Management` (lab/dev under `Workflows > Customer > <Customer Name> > …`) |
| **B-D** | Input defaults set **directly on each input** — **no Configuration Element** for this workflow | `scriptPath`, `domainName`, `fileShareTarget`, `fileFilter` (e.g. `Archive-*.evtx`), `fileAgeDays` (e.g. `-1`) each have a default; `groupDN` has **NO** default (per-run) |
| **B-O** | OOTB `Invoke a PowerShell script` available and returns `PowerShellRemotePSObject` | Present in the vRO library (shared) |

## Phase C — Unit tests (action, via vRO scripting console or a test workflow)

`buildMoveByADGroupInvocation`:

| ID | Input | Expected |
|---|---|---|
| **C1** | Valid: `scriptPath='C:\PSO\Scripts\cvs_functions.ps1'`, `groupDN='CN=WinLogServers,OU=Groups,DC=vcf,DC=lab'`, `domainName='vcf.lab'`, `fileShareTarget='\\fileserver\share$\Windows'`, `fileFilter='Archive-*.evtx'`, `fileAgeDays=-1` | Returns `& "C:\PSO\Scripts\cvs_functions.ps1" -Action 'move-archived-logs-ByCN' -SecurityGroup_CN 'CN=WinLogServers,OU=Groups,DC=vcf,DC=lab' -DomainName 'vcf.lab' -FileShareTarget '\\fileserver\share$\Windows' -FilterOn 'Archive-*.evtx' -NumberOfDays '-1' *>&1 \| Out-String -Width 4096`. Note `-SecurityGroup_CN` underscore |
| **C2** | `scriptPath=''` | Throws Error containing `scriptPath is required` |
| **C3** | `groupDN=''` | Throws Error containing `groupDN is required` |
| **C3b** | `fileAgeDays=''` (or `'abc'`) | Throws `fileAgeDays is required` (empty) or `fileAgeDays must be a whole number` (non-numeric) |
| **C3c** | `fileFilter=''` | Throws Error containing `fileFilter is required` |
| **C4** | `domainName=''` | Throws Error containing `domainName is required` |

- **DN nudge:** a `groupDN` without a `DC=` component still succeeds but logs a `System.warn` nudge — confirm the log line appears and the string is still returned.

`parseScriptOutput` (shared — reference only; see Shared-Components.md):

| ID | Input | Expected |
|---|---|---|
| **C9** | Run OOTB PS workflow with `Write-Host 'test output'`; pass result to `parseScriptOutput` | `getRootObject()` returns the string; Properties returned with keys `success`, `outputText`, `errorText`; `success = true` |
| **C10** | Run OOTB PS workflow emitting an `Error: something failed` line; pass to `parseScriptOutput` (`executionContext='test'`) | `success = false`; error line captured; `outputText` contains all lines |

## Phase D — Workflow integration tests (non-production targets)

| ID | Pre-condition | Expected |
|---|---|---|
| **D1** | Small non-critical AD group (1–2 test servers), ≥1 with an `Archive*.evtx` in `C$\Windows\System32\winevt\Logs`. Run with test group/domain, non-prod share, `fileFilter='Archive-*.evtx'`, `fileAgeDays=-1` | Reaches **Completed Successfully** or **Completed with Errors**; log shows per-server `Info: <server> - moving archived files` lines; files land in `<fileShareTarget>\<server-short-name>\`; log shows the invocation string with `-SecurityGroup_CN` (underscore), `-FilterOn`, `-NumberOfDays`; only **enabled** members processed (recursive expansion); no side effects outside the test group |
| **D1a** | Add a **disabled** computer object to the test group; re-run | Log shows `Info: skipping disabled computer object <name>`; disabled server not contacted/processed; enabled members still processed; run does not fail on account of the disabled one |
| **D1b** | Include an **enabled-but-unreachable** member (powered off / `C$` blocked) plus a healthy member; re-run | Log shows an `Error:` line naming the unreachable server; loop **continues** (healthy member still moved); ends at **Completed with Errors** (`success=false`), **not** a hard Failed state |
| **D1c** | Supply a `groupDN` that does not exist, OR run on a PS host without the RSAT AD module | Group-resolution / missing-module failure terminates the script; routes through `handlePSFailure` to **Failed: PS Execution**; `executionSuccess=false` with a "PS execution failed" message |

## Phase E — Success criteria (Move-scoped)

- [ ] PS host configured per the PS-Host guide and registered in vRO; smoke test passes.
- [ ] All Phase A pre-checks pass or have documented workarounds (incl. A10 RSAT AD, A9 delegation for the Kerberos path).
- [ ] Workflow and action deploy without import errors.
- [ ] Move-ArchivedLogs-ByADGroup input defaults load in the custom form (set on inputs, **no** Config Element); `groupDN` has no default.
- [ ] `buildMoveByADGroupInvocation` returns a correctly formatted invocation string using `-SecurityGroup_CN` (underscore), `-FilterOn`, `-NumberOfDays` — confirmed in logs.
- [ ] Disabled AD members are skipped and logged (D1a); enabled-but-unavailable servers are logged and non-fatal → Completed with Errors (D1b); total failures route to Failed: PS Execution (D1c).
- [ ] `parseScriptOutput` returns Properties `{success, outputText, errorText}` and flags `Error:` lines as `success=false`.
- [ ] Move processes all **enabled** group members (recursively) and moves `Archive*.evtx` files to the correct per-server destination.
- [ ] Executions produce meaningful log output in vRO execution history.

## Rollback

| Item | Approach |
|---|---|
| vRO content | All items are new. Rollback = delete the workflow and the `buildMoveByADGroupInvocation` action. Shared items (`parseScriptOutput`, `handlePSFailure`, OOTB workflow) are used by a separate deliverable — do not delete unless decommissioning both |
| `cvs_functions.ps1` | The `move-archived-logs-ByCN` action already existed; changes are S-1…S-5. To revert, redeploy the previous script (removes filter/age inputs and resilient handling) |
| Moved `.evtx` files | Files are moved, not deleted. If placed at the wrong destination, move back manually; match server short name to the per-server subfolder |
| PS host registration / config | Remove the PS host from vRO Inventory → PowerShell; revert WinRM/Kerberos config per the PS-Host guide. Does not affect the Windows Server beyond WinRM config |
