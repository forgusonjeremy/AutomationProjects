# Windows Server Clean Disks — Validation & Testing Plan

> Scope: Clean-ServerDisks-ByADGroup only. Shared items (`parseScriptOutput`,
> `handlePSFailure`, OOTB *Invoke a PowerShell script*, PS host build) are referenced,
> not re-tested here.
>
> **Run every destructive test against non-production servers only.**

---

## Phase A — Environment pre-checks (before deploying vRO content)

| ID | Check | Expected / action |
|---|---|---|
| **A1** | PS host configured and registered in vRO; smoke test (`Invoke a PowerShell script` + `Write-Host`) passes | Registered and visible in Inventory → PowerShell. Full build/registration → **PS-Host guide** |
| **A2** | `PowerShellRemotePSObject.getRootObject()` available | Method exists and is callable. `parseScriptOutput` uses it exclusively |
| **A3** | Action value `clean-ServerDisk` present in the script `ValidateSet` | Confirmed in the deployed `cvs_functions.ps1` |
| **A4** | Script params `-FolderTarget`, `-FolderIncluded`, `-ForceEnable`, `-FilterOn`, `-NumberOfDays`, `-WhatIf`, `-ADGroupMember` present | Confirmed in the deployed script param block |
| **A5** | **S-14 / S-15 present on the deployed script** (the `whatIf` gate lives here) | `Select-String -Path 'C:\PSO\Scripts\cvs_functions.ps1' -SimpleMatch -Pattern 'Get-ListOfServers-Direct','[ReportOnly] WouldDelete','invalid WhatIf value'` → all match. **If absent, a report-only run will DELETE** |
| **A6** | Script path on PS host | `Test-Path 'C:\PSO\Scripts\cvs_functions.ps1'` → `True`. If `False`, update the workflow `scriptPath` default |
| **A7** | Service-account UNC **delete** access to the target | `Test-Path '\\<target>\C$\Windows\ccmcache'` → `True`, and a test file can be removed (run under the vRO service-account context). Normally requires local admin on the target |
| **A8** | RSAT ActiveDirectory tools on PS host | `Get-Module -ListAvailable ActiveDirectory` lists the module |
| **A9** | Kerberos constrained delegation (double-hop) configured on the PS host account | Delegation configured for the target servers' CIFS SPNs. If not, engage the AD team before live runs |

## Phase B — vRO content deployment checks

| ID | Check | Expected |
|---|---|---|
| **B-A** | Action `buildCleanDisksInvocation` deployed | Module `broadcom.pso.vcf.vm.guestOps.files.windows.diskcleanup`; return type **string** |
| **B-A2** | Action `parseScriptOutput` deployed (shared) | Return type Properties |
| **B-W** | Workflow `Clean-ServerDisks-ByADGroup` deployed | Folder `Production > Servers > Windows > Disk Cleanup` (lab/dev under `Workflows > Customer > <Customer Name> > …`) |
| **B-D** | Input defaults set **directly on each input** — **no Configuration Element** | `scriptPath`, `domainName`, `folderTarget`, `olderThanDays` (1), `folderIncluded` (true), `forceEnable` (false), `whatIf` (**yes**) each have a default; `groupDN` has **NO** default |
| **B-F** | **`fileFilter` is a fixed ATTRIBUTE = `*.*`, not a form input** | Attribute exists with value `*.*`; bound to the action's `fileFilter`; **absent from the custom form** |
| **B-S** | `whatIf` presented as a yes/no dropdown defaulting to **yes** | Live delete requires a deliberate change |
| **B-O** | OOTB `Invoke a PowerShell script` available and returns `PowerShellRemotePSObject` | Present in the vRO library |

## Phase C — Unit tests (`buildCleanDisksInvocation`)

| ID | Input | Expected |
|---|---|---|
| **C1** | Valid: `scriptPath='C:\PSO\Scripts\cvs_functions.ps1'`, `groupDN='CN=Security-Servers,OU=Servers,DC=vcf,DC=lab'`, `domainName='vcf.lab'`, `folderTarget='c:\Windows\ccmcache'`, `fileFilter='*.*'`, `olderThanDays=1`, `folderIncluded=true`, `forceEnable=false`, `whatIf='yes'` | Returns `& "C:\PSO\Scripts\cvs_functions.ps1" -Action 'clean-ServerDisk' -ADGroupMember '…' -DomainName 'vcf.lab' -FolderTarget 'c:\Windows\ccmcache' -FilterOn '*.*' -NumberOfDays '-1' -FolderIncluded 'yes' -ForceEnable 'no' -WhatIf 'yes' *>&1 \| Out-String -Width 4096` |
| **C2** | `olderThanDays=4` | Invocation contains `-NumberOfDays '-4'` (positive input negated) |
| **C3** | `olderThanDays=0` | Invocation contains `-NumberOfDays '0'` (not `-0`) |
| **C4** | `olderThanDays=-2` | Throws Error containing `olderThanDays must be 0 or greater` |
| **C5** | `olderThanDays='abc'` / `''` | Throws `must be a whole number` / `olderThanDays is required` |
| **C6** | `whatIf='maybe'` | Throws Error containing `whatIf must be 'yes' … or 'no'` |
| **C7** | `whatIf='no'` | Returns the string **and** logs a `System.warn` naming the folder and group (live-delete warning) |
| **C8** | `scriptPath=''` / `groupDN=''` / `domainName=''` / `folderTarget=''` / `fileFilter=''` | Throws `<name> is required` for each |
| **C9** | `folderTarget='c:\'` or `'c:\Windows'` | Returns the string **and** logs a `System.warn` dangerous-root nudge |
| **C10** | `groupDN='Security-Servers'` (no `DC=`) | Succeeds; logs a `System.warn` DN nudge |
| **C11** | `groupDN` containing an apostrophe (e.g. `OU=O'Brien`) | Single quote is doubled in the output string (not truncated) |
| **C12** | `folderIncluded=true`, `forceEnable=true` | Invocation contains `-FolderIncluded 'yes' -ForceEnable 'yes'` |

`parseScriptOutput` (shared — reference only):

| ID | Input | Expected |
|---|---|---|
| **C20** | OOTB PS workflow with `Write-Host 'test output'` → `parseScriptOutput` | Properties `{success, outputText, errorText}`; `success = true` |
| **C21** | Output containing an `Error: something failed` line | `success = false`; error line captured in `errorText` |

## Phase D — Workflow integration tests (non-production targets)

**Seed first** on each test server:
`lab\New-DiskCleanTestData.ps1 -ADGroup '<test group>' -DomainName <domain>`
(add `-GrantModifyTo '<svc account>'` if the clean runs as a non-admin domain account).

The seeder creates: aged `cache_*.tmp` files in the root + subfolders, today-dated
`_current_*.txt` files, and three should-survive artifacts —
`vmware-vmsvc-SYSTEM.log`, `_readonly_aged.txt`, `_hidden_aged.txt`.

| ID | Pre-condition / run | Expected |
|---|---|---|
| **D1** | **Report-only:** test group, `folderTarget='c:\Windows\ccmcache'`, `olderThanDays=1`, `folderIncluded=true`, `forceEnable=false`, **`whatIf='yes'`** | Log shows `ReportOnly=True` and `[ReportOnly] WouldDelete: …` for aged items. **Nothing is deleted** (re-inspect the folder to confirm). Ends *Completed Successfully* |
| **D2** | **Live delete:** same inputs, **`whatIf='no'`** | Aged files and aged subfolders are deleted; `deleted N item(s); 0 failure(s)` per server |
| **D3** | **Preservation checks** after D2 | `vmware-vmsvc-SYSTEM.log` **survives** (name exclusion); `_hidden_aged.txt` **survives** (hidden, never enumerated); `_readonly_aged.txt` **survives** (read-only, `forceEnable=false`) and logs an `Error:` line → run ends *Completed with Errors*; the target folder `ccmcache` itself **still exists** |
| **D4** | **ForceEnable:** re-seed, run live with `forceEnable=true` | `_readonly_aged.txt` is now **deleted**; `_hidden_aged.txt` still survives (confirms `forceEnable` is a read-only switch only) |
| **D5** | **Age boundary (keep today):** re-seed, run live with `olderThanDays=1` | Today-dated `_current_*.txt` files **survive**; aged files are deleted |
| **D6** | **Age boundary (include today):** re-seed, run live with `olderThanDays=0` | Today-dated `_current_*.txt` files are **deleted** |
| **D7** | **FolderIncluded=false:** re-seed, run live with `folderIncluded=false` | Aged **files** deleted (including inside subfolders); **subfolders remain** |
| **D8** | **Disabled member:** add a disabled computer object to the test group; re-run | Log shows `Info: skipping disabled computer object <name>`; that server is not contacted; enabled members still processed |
| **D9** | **Nested sub-group:** add a sub-group (containing a computer) as a member; re-run | The nested computer is **NOT** processed (non-recursive by design); `resolved to N enabled, direct computer member(s)` excludes it |
| **D10** | **Unreachable member:** include an enabled-but-powered-off member plus a healthy one; re-run | `Error:` line naming the unreachable server; loop **continues** (healthy member still cleaned); ends *Completed with Errors*, **not** a hard Failed state |
| **D11** | **Empty group:** point at a group with no enabled computer members | `Warn: … resolved to zero enabled, direct computer members. No action taken.`; ends *Completed Successfully*; nothing touched |
| **D12** | **Total failure:** non-existent `groupDN`, or a PS host without the RSAT AD module | Script terminates; routes via `handlePSFailure` to **Failed: PS Execution**; `executionSuccess=false` |
| **D13** | **Multiple folder targets:** `folderTarget='c:\Windows\ccmcache,c:\Temp\ScratchCache'` (seed both) | Both paths are cleaned; per-path log lines appear for each server |
| **D14** | **User-profile template:** seed with `-Scenario profiles`; run `folderTarget='c:\users\_LabDiskCleanTest'`, `olderThanDays=0`, `forceEnable=true`, `whatIf='no'` | Contents removed including read-only; the `_LabDiskCleanTest` folder itself remains |

## Phase E — Success criteria

- [ ] PS host configured per the PS-Host guide and registered in vRO; smoke test passes.
- [ ] All Phase A pre-checks pass — **especially A5** (S-14/S-15 on the deployed script)
      and **A7** (service-account delete rights).
- [ ] Workflow and action deploy without import errors.
- [ ] `fileFilter` is a fixed attribute `*.*` and does **not** appear on the form (B-F).
- [ ] `whatIf` defaults to **yes** on the form (B-S).
- [ ] `buildCleanDisksInvocation` converts positive `olderThanDays` → negative
      `-NumberOfDays` correctly, including `0` → `'0'` (C2, C3), and rejects negatives (C4).
- [ ] **Report-only deletes nothing** (D1) and live delete removes aged items (D2).
- [ ] All preserved categories behave as documented (D3, D4, D5, D7) — matching
      Design Document §5.
- [ ] Targeting is direct + enabled + computer-only: disabled skipped (D8), nested
      sub-group excluded (D9).
- [ ] Unreachable server is logged and non-fatal → *Completed with Errors* (D10);
      total failures route to *Failed: PS Execution* (D12).
- [ ] Executions produce a complete per-server/per-item transcript in vRO run history.

## Rollback

| Item | Approach |
|---|---|
| vRO content | All items are new. Rollback = delete the workflow and the `buildCleanDisksInvocation` action. **Do not** delete the shared `parseScriptOutput` / `handlePSFailure` — other packages use them |
| `cvs_functions.ps1` | The `clean-ServerDisk` action already existed; changes are S-14 / S-15. To revert, redeploy the previous script — **this removes the `whatIf` safety gate** and reintroduces unfiltered targeting and silent failures |
| Deleted files | **Not recoverable by this automation.** Restore from backup/VSS. This is why `whatIf` defaults to report-only and why D1 precedes D2 |
| Lab test data | Delete the seeded folders, or let a live run remove them; the seeder only writes under the target you specify |
| PS host registration / config | Remove the PS host from vRO Inventory → PowerShell; revert WinRM/Kerberos config per the PS-Host guide |
