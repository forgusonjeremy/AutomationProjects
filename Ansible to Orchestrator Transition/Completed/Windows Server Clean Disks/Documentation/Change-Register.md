# Change Register — Windows Server Clean Disks

**Project:** Ansible → VCF Orchestrator transition — "Windows Server Clean Disks"
**Platform:** VCF Automation 9 / VCF Operations Orchestrator 9
**Purpose of this document:** A single, customer-facing record of *how the disk
cleanup process works today* and *every change* made to it during the Orchestrator
transition — what changed, and **why**.

> **Continues the shared `S-` numbering.** `cvs_functions.ps1` is a shared toolbox.
> Changes **S-1 … S-5** were made by the **Move Windows Event Logs** project and
> **S-6 … S-13** by the **Server Reboots** project (each recorded in its own
> register). This deliverable adds **S-14 … S-15** and process changes **P-14 … P-17**.
>
> **Script under change (working copy):** `InProgress/psscript/files/cvs_functions.ps1`
> **Promoted to (on completion):** `Completed/_Shared References/psscript/files/cvs_functions.ps1`
> **Current-state baseline:** `InProgress/Windows Server Clean Disks/servers_diskclean.yml` + `vars.txt`
>
> Only **two** working copies of the shared PowerShell exist: the In-Progress copy
> (edited while a project is in flight) and the Completed copy (what is migrated to
> the customer environment). The pre-transition originals under
> `Ansible Playbooks and Files - Sanitized/psscript/files/` are an **as-received
> source archive**, not a working copy, and are exempt from that rule.

---

## 1. Current state — how the customer does it today

**Goal of the automation (unchanged):** free disk space on the Windows servers in a
security group (`CVS-DPT-AllServers`) by deleting aged files from one or more
folders — by default `c:\Windows\ccmcache` (the SCCM download cache), everything
(`*.*`) older than yesterday (`-1` day).

**How it runs today (Ansible):**
- `servers_diskclean.yml` creates a temp dir on a Windows host over WinRM (5986),
  `win_copy`s the script folder, runs
  `cvs_functions.ps1 -Action clean-ServerDisk …`, then deletes the temp dir.
- The playbook is only a **delivery shell**. All real work happens in the script,
  on that one host, reaching every target over its `\\server\C$` admin share.
- The script (`clean-ServerDisk` case, as received):
  1. `Get-ListOfServers` → `Get-ADGroupMember` (**non-recursive, unfiltered** —
     returns users and disabled computer objects as well as enabled computers).
  2. `Convert-YAMLList` normalises the `FolderTarget` list.
  3. For each server × each folder: rewrites `c:\path` → `\\server\c$\path` and
     calls `Remove-files`, which deletes items older than `(today + NumberOfDays)`
     matching `FilterOn`, honouring `FolderIncluded` / `ForceEnable`, always
     excluding `vmware-vmsvc-SYSTEM.log`.

**Behaviours the transition preserves deliberately:**
- The same age / filter / folder-inclusion / force semantics of `Remove-files`.
- The `\\server\c$\…` admin-share addressing (one PS host reaches every target).
- Group membership is **non-recursive** — only direct members are targets
  (deliberately *not* changed to recursive; deleting files is destructive — see P-15).

**Pre-existing weaknesses found during the transition (fixed here):**
- **Silent failures.** `Remove-files`' `Get-ChildItem` had no `-ErrorAction Stop`,
  so an unreachable server / inaccessible admin share raised a **non-terminating**
  error on the PS error stream that the workflow never sees — the run looked clean.
  Its single catch line (`"Error: $_.Exception.message"`) never expanded the
  exception and was mislabelled. (Same defect S-3 fixed for `Move-files`.)
- **Unfiltered targeting.** The legacy `Get-ListOfServers` returned disabled and
  non-computer objects, which then errored one by one during the clean.
- **No dry-run.** The action always deleted; there was no way to preview.

---

## 2. Changes to `cvs_functions.ps1`

> The package reuses the proven script as-is where possible. S-14 brings the
> `clean-ServerDisk` action up to the standard already set by
> `move-archived-logs-ByCN` (S-2…S-4) and `Invoke-ServerReboot` (S-6…S-11); S-15 is
> the `Remove-files` defect fix plus the new report-only capability.

| # | Date | Function / Section | Change | Reason | Deployment impact |
|---|------|--------------------|--------|--------|-------------------|
| S-14 | 2026-07-22 | `clean-ServerDisk` switch case | Rewrote the case to match the other AD-group actions: (a) added an **ActiveDirectory module guard** that **throws** (total failure) if the module is missing; (b) switched targeting from the legacy flat `Get-ListOfServers` to **`Get-ListOfServers-Direct`** (non-recursive, Enabled-only, per-object isolation, disabled skips logged); (c) added a **`-WhatIf` safety gate** — `'yes'` = report-only, `'no'` = live delete, anything else = `Error:` + no action (fails safe); (d) added a **zero-result guard** (empty group or empty folder list logs a warning and exits cleanly) and **per-server `try/catch` isolation**; (e) restored the per-server progress log line (previously commented out). | The action had none of the resilience the other AD-group actions gained during this transition. Disk cleaning is destructive and must offer a preview; a missing module or empty group must not be silently mistaken for success; one unreachable server must not abort the rest. | Requires redeploying the updated `cvs_functions.ps1` to the PS host. Operators now pass `whatIf` (defaults to report-only). Targeting is now **direct enabled computers only** — a machine reached before only because it was a nested-group member or a still-enabled-but-decommissioned object is no longer cleaned (add it directly / re-enable to restore). |
| S-15 | 2026-07-22 | `Remove-files` function | (a) Added `-ErrorAction Stop` to the `Get-ChildItem` enumeration so an unreachable target becomes a **terminating** error caught and logged to stdout instead of a silent non-terminating error on the PS error stream; (b) **fixed the malformed catch message** (`"Error: $_.Exception.message"` → `"$($_.Exception.Message)"` with server/path context); (c) collapsed the four near-identical `Get-ChildItem \| Remove-Item` branches into **one** candidate-selection pipeline shared by report and delete, then **delete per item in a `try/catch`** so one failure is logged and the rest proceed (a child already removed by a parent's `-Recurse` is not counted as a failure); (d) added a **`-ReportOnly`** switch (lists `WouldDelete` items, deletes nothing) and an optional **`-ServerName`** for log context. | "Any failure should be logged" where the workflow can see it; the report-only mode is what the `clean-ServerDisk` `whatIf='yes'` path calls. The `-Force` (ForceEnable) and folder-inclusion semantics are preserved exactly. | Requires redeploying the updated `cvs_functions.ps1`. `Remove-files` is only called by `clean-ServerDisk`, so no other action is affected. Manual callers gain `-ReportOnly` / `-ServerName` (both optional, default off/empty). |

### S-14 detail — `clean-ServerDisk` hardening & the resolver choice

**Why `Get-ListOfServers-Direct` (not `-ByCN`).** Two hardened resolvers already
exist in the script:
- `Get-ListOfServers-ByCN` — **recursive**, Enabled-only. Used by the archive-log
  **move** (a non-destructive relocation) to reach the broadest set of machines.
- `Get-ListOfServers-Direct` — **non-recursive**, Enabled-only. Introduced by the
  **reboot** project (S-7) precisely because a **destructive** action must target
  only what the operator placed *directly* in the group; a nested sub-group is
  never silently expanded into scope.

Deleting files is destructive, so `clean-ServerDisk` follows the **reboot**
precedent and uses `Get-ListOfServers-Direct`. This also preserves the *original*
Ansible behaviour, which was already non-recursive (`Get-ListOfServers` without
`-Recursive`) — the only change is that disabled and non-computer objects are now
filtered out (and the skip is logged) instead of being handed to the clean loop.

**whatIf gate (behaviour to be aware of):**
- `whatIf='yes'` → **report only**: `Remove-files -ReportOnly` lists every item that
  *would* be deleted (`[ReportOnly] WouldDelete: …`) and deletes nothing.
- `whatIf='no'` → live delete. The build action logs a loud `System.warn` so a live
  run is unmistakable in the workflow log.
- Any other value → an `Error:` line and **no action** (the script fails safe). The
  build action additionally rejects anything that is not `yes`/`no` up front.

### S-15 detail — `Remove-files` before / after

*Before* (representative branch — one of four):
```powershell
[string] $NumberOfDays = 0
...
Get-ChildItem -recurse -Filter $FilterOn -Path $Path |
    Where-Object { $_.LastWriteTime -lt $dateTime -and $_.Name -cne $FileExclude } |
    Remove-Item -Force -recurse -Confirm:$false
...
}Catch{ Write-Log "Error: $_.Exception.message" $true}
```

*After* (single selection + report-only + per-item delete):
```powershell
[string] $NumberOfDays = 0,
[bool]   $ReportOnly   = $false,   # NEW — report-only preview
[string] $ServerName   = ''        # NEW — log context
...
$gciParams = @{ Path = $Path; Recurse = $true; Filter = $FilterOn; ErrorAction = 'Stop' }
if ($FolderIncluded -ne 'yes') { $gciParams['File'] = $true }
$candidates = @(Get-ChildItem @gciParams |
    Where-Object { $_.LastWriteTime -lt $dateTime -and $_.Name -cne $FileExclude })

if ($ReportOnly) {
    foreach ($c in $candidates) {
        Write-Log "Info: $($ctx)[ReportOnly] WouldDelete: $($c.FullName) (LastWriteTime: $($c.LastWriteTime))" $true
    }
    return
}
$useForce = ($ForceEnable -eq 'yes')
foreach ($c in $candidates) {
    Try {
        if ($useForce) { Remove-Item -LiteralPath $c.FullName -Force -Recurse -Confirm:$false -ErrorAction Stop }
        else           { Remove-Item -LiteralPath $c.FullName -Recurse -Confirm:$false -ErrorAction Stop }
        $deleted++
    } Catch {
        if (Test-Path -LiteralPath $c.FullName) { Write-Log "Error: $($ctx)failed to delete '$($c.FullName)': $($_.Exception.Message)" $true }
    }
}
...
}Catch{ Write-Log "Error: $($ctx)failed cleaning '$FilterOn' under '$Path': $($_.Exception.Message)" $true }
```

**Failure-handling contract after S-14…S-15:**
- **Disabled / non-computer member** → skipped during resolution
  (`Get-ListOfServers-Direct`, `Enabled -eq $true`) and logged as an `Info:` skip.
- **Unavailable/failed server** → `Remove-files` `Get-ChildItem` hits a terminating
  error (`-ErrorAction Stop`), logs an `Error:` line, and the per-server loop
  continues. The workflow's `parseScriptOutput` sees the `Error:` line and ends the
  run in **Completed with Errors** (not a hard failure).
- **Individual undeletable item** → logged `Error:`; the remaining items still
  delete.
- **Total failure** (AD module missing, or group/domain resolution failing) → the
  script `throw`s / the AD cmdlet errors terminate; the OOTB *Invoke a PowerShell
  script* workflow routes to `handlePSFailure` → **Failed** end state.

---

## 2A. Items the clean intentionally PRESERVES (never deletes)

> **This is a required, customer-facing list.** The `clean-ServerDisk` action does
> **not** delete everything under a target — several categories are preserved by
> design. This behaviour is inherited from the original Ansible script (except where
> noted) and must be reproduced verbatim in the user-facing docs
> (`02_Design_Document`, `04_User_Guide`) so operators are never surprised.

| # | Preserved item | Why / mechanism | Configurable? |
|---|----------------|-----------------|---------------|
| 1 | **`vmware-vmsvc-SYSTEM.log`** | Hardcoded name exclusion in `Remove-files`: `$FileExclude = "vmware-vmsvc-SYSTEM.log"`, tested with `$_.Name -cne $FileExclude`. Protects the live VMware guest-info log. Inherited from the original script. | No — hardcoded. **Case-sensitive** (`-cne`): only the exact casing `vmware-vmsvc-SYSTEM.log` is protected; a differently-cased copy would be deleted. |
| 2 | **Anything newer than the age cutoff** | `Remove-files` deletes only items where `LastWriteTime -lt (today + NumberOfDays)`. Files/folders at or after the cutoff are kept. | Yes — via `fileAgeDays` (`-NumberOfDays`). `0` = older than now; `-1` = older than yesterday. |
| 3 | **Loose hidden / system files** | `Get-ChildItem` runs **without `-Force`**, so hidden/system files directly in a target are never enumerated and never deleted — regardless of `ForceEnable`. (A hidden file *nested inside a folder that is itself deleted* still goes, via the parent's `-Recurse -Force`.) Matches the original script. | No (matches original). Would require adding `-Force` to the enumeration — a deliberate behaviour change, not currently made. |
| 4 | **The target root folder itself** | `Remove-files` cleans the **contents** of the target (`Get-ChildItem -Path <target> -Recurse` lists children only); the target directory is never a candidate. So `c:\Windows\ccmcache` / `c:\users` are emptied but not removed. Correct and intended (you never want `c:\users` deleted). | No — by design. |
| 5 | **Read-only files** when `ForceEnable=no` | Without `-Force`, `Remove-Item` cannot delete a read-only item, so it is left (and logged as an `Error:`). `ForceEnable=yes` deletes them. `ForceEnable` is **only** a read-only switch — it has no effect on hidden files (see #3). | Yes — via `forceEnable`. |
| 6 | **All folders** when `FolderIncluded=no` | With `FolderIncluded=no` the enumeration adds `-File`, so only files are candidates; directories are left in place. `FolderIncluded=yes` allows folder deletion. | Yes — via `folderIncluded`. |
| 7 | **Everything** when `whatIf=yes` | Report-only mode (`-ReportOnly`) lists `[ReportOnly] WouldDelete: …` and deletes nothing. This is the default. | Yes — via `whatIf` (`yes`/`no`). |

**Lab validation:** the seeder `lab/New-DiskCleanTestData.ps1` creates one negative-test
artifact per preserved category (`vmware-vmsvc-SYSTEM.log`, `_KEEP_newer_than_threshold.txt`
[future-dated], `_readonly_aged.txt`, `_hidden_aged.txt`) so each rule above can be
observed surviving a run.

---

## 3. Changes to the automation process (Ansible → Orchestrator)

| # | Date | Area | Current process (Ansible) | New process (Orchestrator) | Reason |
|---|------|------|---------------------------|----------------------------|--------|
| P-14 | 2026-07-22 | Execution engine | Ansible runs PowerShell on a host via `win_shell`/`win_command`, staging the script with `win_copy` over WinRM | Orchestrator workflow calls the **pre-staged** `cvs_functions.ps1` via the OOTB *"Invoke a PowerShell script"* over the PowerShell plug-in (WinRM/HTTPS/Kerberos) from a single PS host | Replace Ansible with Orchestrator while reusing proven script logic; eliminates per-run script staging |
| P-15 | 2026-07-22 | AD targeting method | Flat, **unfiltered** `Get-ListOfServers` (non-recursive; returns users + disabled objects too) | **`Get-ListOfServers-Direct`** — non-recursive, **Enabled-only**, per-object isolation, disabled skips logged | Deleting files is destructive → membership must be explicit (no nested-group expansion), matching the reboot precedent (S-7); disabled/decommissioned and non-computer objects are excluded and logged |
| P-16 | 2026-07-22 | Safety / preview | None — the action always deleted | **`whatIf` gate**, default `yes` (report-only). `yes` lists would-delete items and deletes nothing; `no` deletes for real | Destructive automation needs a preview; mirrors the report-only safety mode added to `Remove-OldFiles-UNCShare` (S-1). `whatIf` is the sole safety control (there is no interactive prompt in a non-interactive vRO session) |
| P-17 | 2026-07-22 | Variables / secrets | `vars` / `group_vars` / `become` | Workflow inputs with defaults set directly on each input (no Configuration Element); credentials via the PS host plug-in service account | Standard Orchestrator patterns; these values are static per environment, so self-contained inputs are preferred over a shared Config Element (same decision as Move-ArchivedLogs-ByADGroup, P-8) |
| P-18 | 2026-07-23 | Age-threshold input | `var_NumberOfDays` is a **negative** value (`-1`, `-4`) fed straight to the script's `(Get-Date).AddDays(N)` | Operator-facing workflow input is a **positive** `olderThanDays` — "delete items older than N days" (`4` = 4 days old or older, `1` = older than a day, `0` = everything up to now). The **build action converts** it to the script's negative convention (`-NumberOfDays = -olderThanDays`); negatives are rejected on the form. **No `cvs_functions.ps1` change** — the script still receives the negative value | The negative form is a footgun on a user form (a bigger negative is *less* aggressive, and there is "no such thing as -4 days old"). A positive "older than N days" reads naturally and matches the sibling `Remove-OldFiles-UNCShare` `olderThanDays` input. Kept entirely in the vRO layer so the shared script and its other callers are unaffected |
| P-19 | 2026-07-23 | File filter | `var_FilterOn` (`*.*`) supplied as a variable | `fileFilter` is a **fixed workflow attribute `*.*`**, NOT an operator input | `-FilterOn` in `Remove-files` is applied to **directory names too**, not just files. `*.*` matches every file **and** folder, so `FolderIncluded='yes'` actually deletes folders; a restrictive filter such as `*.txt` matches no folders (they aren't named `*.txt`), so folders would silently NOT be deleted. Pinning the filter to `*.*` and keeping it off the form removes that footgun. All eight production templates already use `*.*`. **No `cvs_functions.ps1` or build-action change** — the action passes the attribute value through unchanged |

**Net result:** 1 playbook → **1** workflow (`Clean-ServerDisks-ByADGroup`); the
invoked action (`clean-ServerDisk`) already exists in the deployed script; the
changes to `cvs_functions.ps1` are limited to **S-14** (case hardening: AD guard,
Direct resolver, whatIf gate, per-server isolation, zero-result guard) and **S-15**
(`Remove-files`: `-ErrorAction Stop`, fixed catch message, report-only, per-item
delete). The shared `parseScriptOutput` / `handlePSFailure` / OOTB *Invoke a
PowerShell script* contract is reused unchanged.

---

## 4. Current vs new — quick mapping

| Today (Ansible playbook) | New (Orchestrator workflow) |
|---|---|
| `servers_diskclean.yml` (`-Action clean-ServerDisk`) | `Clean-ServerDisks-ByADGroup` |

**Variable mapping:**

| Ansible var (`vars.txt`) | vRO workflow input | Script parameter |
|---|---|---|
| `var_ADGroupMember` (`CVS-DPT-AllServers`) | `groupDN` | `-ADGroupMember` |
| `var_DomainName` (`dom4.invalid`) | `domainName` | `-DomainName` |
| `var_FolderTarget` (`c:\Windows\ccmcache`) | `folderTarget` | `-FolderTarget` |
| `var_FilterOn` (`*.*`) | `fileFilter` — **fixed workflow attribute `*.*`** (not an operator input) | `-FilterOn` |
| `var_NumberOfDays` (`-1`) | `olderThanDays` (positive; `1`) | `-NumberOfDays` (build action sends `-olderThanDays`) |
| `var_FolderIncluded` (`yes`) | `folderIncluded` (boolean) | `-FolderIncluded` |
| `var_ForceEnable` (`no`) | `forceEnable` (boolean) | `-ForceEnable` |
| (none — new) | `whatIf` (yes/no, default yes) | `-WhatIf` |
| `var_ps_folder` / `var_ps_script_file` | folded into `scriptPath` | `& "<scriptPath>"` |
| `var_parameter_action` (`clean-ServerDisk`) | fixed in the build action | `-Action 'clean-ServerDisk'` |

---

## 5. Outstanding / deferred

| Item | Status / note |
|---|---|
| Customer documentation set (01_Executive_Summary … 05_Validation_and_Testing_Plan) | **Complete (2026-07-23).** The section 2A "Items intentionally preserved" list is reproduced in `02_Design_Document` §5 and `04_User_Guide` §3 (including the `vmware-vmsvc-SYSTEM.log` name exclusion and the read-only-vs-hidden distinction). |
| `.package` export (`com.broadcom.pso…diskcleanup`) | Built from the action + workflow once the workflow is assembled in vRO |
| Per-server structured reporting / email on completion | Deferred — script outputs aggregate stdout; `clean-ServerDisk` does not currently email a report |
| Freed-space (bytes deleted) summary in the transcript | Candidate enhancement — `Remove-files` currently reports item counts, not sizes |

---

## Revision history

| Date | Author | Summary |
|---|---|---|
| 2026-07-22 | Automation transition | Initial register. Script changes **S-14** (`clean-ServerDisk`: AD-module guard, `Get-ListOfServers-Direct` resolver, `whatIf` report-only gate, per-server isolation, zero-result guard) and **S-15** (`Remove-files`: `-ErrorAction Stop`, fixed catch message, single-pipeline selection, per-item delete, `-ReportOnly` / `-ServerName`). Process changes **P-14 … P-17** (Ansible→Orchestrator; direct Enabled-only targeting; whatIf safety gate; inputs with direct defaults, no Config Element). Code: `buildCleanDisksInvocation` action + `Clean-ServerDisks-ByADGroup` workflow spec. |
| 2026-07-23 | Automation transition | Authored the customer documentation set (`01_Executive_Summary`, `02_Design_Document`, `03_Implementation_Guide`, `04_User_Guide`, `05_Validation_and_Testing_Plan`). Aligned the action module namespace to `broadcom.pso.vcf.vm.guestOps.files.windows.diskcleanup` across the workflow spec and docs. |
| 2026-07-23 | Automation transition | Process change **P-19**: pinned `fileFilter` to a **fixed workflow attribute `*.*`** (removed it from the operator form). `-FilterOn` applies to directory names too, so a restrictive filter (e.g. `*.txt`) silently prevents folder deletion under `FolderIncluded='yes'`; `*.*` matches all files and folders. No code change. Updated the workflow spec and variable-mapping table. |
| 2026-07-23 | Automation transition | Process change **P-18**: replaced the negative `fileAgeDays` workflow input with a positive, intuitive **`olderThanDays`** ("delete items older than N days"); the `buildCleanDisksInvocation` action converts it to the script's negative `-NumberOfDays` (`-olderThanDays`) and rejects negatives. Default `1` (== the former `-1`). No `cvs_functions.ps1` change. Updated the build action, workflow spec, and variable-mapping table. |
| 2026-07-23 | Automation transition | Added **section 2A "Items the clean intentionally preserves"** — the full, customer-facing list of what is *not* deleted (the `vmware-vmsvc-SYSTEM.log` case-sensitive name exclusion, newer-than-cutoff items, loose hidden/system files, the target root folder, read-only files under `ForceEnable=no`, folders under `FolderIncluded=no`, and report-only `whatIf=yes`). Flagged it as a required section for the pending `02_Design_Document` / `04_User_Guide`. No code change. Prompted by the `vmware-vmsvc-SYSTEM.log` exclusion not being obvious from the workflow inputs. |
