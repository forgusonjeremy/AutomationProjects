# Change Register — Windows Archive Log Management

**Project:** Ansible → VCF Orchestrator transition — "Move Windows Event Logs"
**Purpose of this document:** A single, customer-facing record of *how the
process works today* (the current Ansible-based approach) and *every change*
being made to it during the Orchestrator transition — what changed, and **why**.

It covers two areas:

1. **Changes to `cvs_functions.ps1`** — the shared PowerShell "toolbox" script
   that both the Ansible playbooks and the new Orchestrator workflows call.
2. **Changes to the automation process** as it stands in `ansible code.md`
   (the playbooks the customer runs today).

> **File locations (for reference)**
> - Deployed script under change: `psscript/files/cvs_functions.ps1` (reference copy: `Move Windows Event Logs/_Shared/Code/cvs_functions.ps1`)
> - Current-state playbooks (baseline): `Move Windows Event Logs/ansible code.md`
> - New Orchestrator package (split into two deliverables + shared):
>   - `Move Windows Event Logs/Move-ArchivedLogs-ByADGroup/` (Code + Documentation)
>   - `Move Windows Event Logs/Remove-OldFiles-UNCShare/` (Code + Documentation)
>   - `Move Windows Event Logs/_Shared/` (parseScriptOutput, handlePSFailure, cvs_functions; Shared-Components, this register, Ansible map)
>   - PS host build reference: `Automation Projects/_Shared References/PowerShell Host Build Guide/`
>
> **This is the shared copy** of the register, cited by both deliverables — it
> records the change history for the whole transition (both workflows).

---

## 1. Current state — how the customer does it today

**Goal of the automation (unchanged):**
- **Move** archived event logs (`Archive-*.evtx`) off Windows servers from
  `C:\Windows\System32\winevt\Logs` to a central archive share, into a
  per-server subfolder: `\\fileserver.corp.local\mdcarchivelog$\Windows\<server>`.
- **Clean up** the archive share by deleting files older than a retention
  threshold (default ~370 days).

**How it runs today (Ansible):**
- **7 playbooks** in `ansible code.md` perform essentially the same move/cleanup
  work in several variations:
  - 2 × *local execution* (the host moves its own logs) — `*LocalPath*`
  - 3 × *UNC pull* targeting an AD group (three near-duplicate AD-query forks:
    `-Recursive`, `-Credential`, `-Server`) — `*UNCPath_AD-Group*` / `*-TEST*`
  - 1 × *script-library* call (`move-win-archived-logs` → `cvs_functions.ps1`)
  - 1 × *share cleanup* (`remove-OldFiles-UNCPath` → `cvs_functions.ps1`)
- Execution is via Ansible `win_shell` / `win_command` / `win_copy` over WinRM,
  with server targeting from static inventory or AD group lookups.
- Some playbooks already call the shared `cvs_functions.ps1` toolbox after
  staging it on the host with `win_copy`.

---

## 2. Changes to `cvs_functions.ps1`

> The Orchestrator package was designed to reuse the proven script **as-is** where
> possible. The table below is the complete list of changes **to `cvs_functions.ps1`**.
> As of this revision there are **five** changes (S-1 … S-5). S-2…S-4 expose the
> file filter / age as operator inputs and make per-server failure handling
> reliable and non-fatal; S-5 removes an orphaned action. (Changes to the build
> tooling and setup guides are tracked separately in section 2A.)

| # | Date | Function / Section | Change | Reason | Deployment impact |
|---|------|--------------------|--------|--------|-------------------|
| S-1 | 2026-06-28 | `Remove-OldFiles-UNCPath` + `Delete-OldFiles-UNC-Share` switch case | Replaced interactive `Read-Host` confirmation with a non-interactive `-ReportOnly` mode | The `Read-Host` prompt blocks (or silently cancels) when run non-interactively by the Orchestrator PowerShell plug-in, so `whatIf='yes'` never produced a usable "report only" preview | Requires redeploying the updated `cvs_functions.ps1` to the PS host. No change to how operators call the workflow. |
| S-2 | 2026-07-08 | `move-archived-logs-ByCN` switch case | (a) File filter and age are no longer hardcoded — the case now uses `-FilterOn`/`-NumberOfDays` (supplied by the workflow), falling back to the proven `Archive*.evtx` / `-1` defaults; (b) added an ActiveDirectory module guard that **throws** (total failure) if the module is missing; (c) each server iteration is wrapped in its own `try/catch` and a zero-result group logs a warning and exits cleanly | The workflow requires file extension filter and file age as inputs; these could not pass through while the values were hardcoded. The guard + per-server isolation make a single unreachable server non-fatal while a genuine total failure still fails the run | Requires redeploying the updated `cvs_functions.ps1`. Operators now pass `fileFilter` / `fileAgeDays` (defaults preserve current behaviour). |
| S-3 | 2026-07-08 | `Move-files` function | (a) Fixed the malformed catch message (`"error: $_.Exception.message"` → proper `$($_.Exception.Message)` with server context); (b) added `-ErrorAction Stop` to the `New-Item`/`Get-ChildItem`/`Move-Item` pipeline so an unreachable source (server down / inaccessible `C$`) becomes a **terminating** error caught and logged to stdout instead of a silent non-terminating error on the PS error stream | Failures against an unavailable server were not being logged where the workflow could see them, and the log line that did fire was unreadable. "Any failure should be logged" | Requires redeploying the updated `cvs_functions.ps1`. Behaviour is more resilient; also benefits the `move-archived-logs` action. |
| S-4 | 2026-07-08 | `Get-ListOfServers-ByCN` function | Rewrote the single pipeline into: resolve group members with `-ErrorAction Stop` (group-not-found / domain-unreachable now terminates), then resolve each computer individually inside a `try/catch` — enabled servers are returned, **disabled** ones are explicitly skipped **and logged**, and a single unresolvable object no longer aborts the whole group | Guarantees disabled machines are not processed (with an audit log), isolates per-object failures, and makes a true group-resolution failure a proper total failure | Requires redeploying the updated `cvs_functions.ps1`. Also used by `Get-ServerRebootReportStatus-ByCN` (same return shape — compatible). |
| S-5 | 2026-07-08 | `[ValidateSet]` on `$Action`, `$HostList` param, `move-archived-logs-ByHostList` switch case | Removed the orphaned `move-archived-logs-ByHostList` action in full — the ValidateSet entry, the `$HostList` parameter, and the entire switch case | The action existed only to serve a `Move-ArchivedLogs-LocalHost` vRO workflow that was never built and will not exist (see P-2/P-3). It was never called by Ansible or vRO. Standardisation: the PS host is added to the AD group and processed by `move-archived-logs-ByCN` like any other member (source access is via its own `\\host\C$` admin share, so no local-path branch is needed) | Requires redeploying the updated `cvs_functions.ps1`. No caller impact — nothing invoked this action. |

### S-1 detail — `Remove-OldFiles-UNCPath` report-only fix

**Symptom (before):** Running the `Remove-OldFiles-UNCShare` workflow with
`whatIf='yes'` was intended to be a safe "report only, delete nothing" preview.
Instead it hit an interactive `Read-Host "Are you sure…(Y/N)"` prompt. In the
Orchestrator PowerShell plug-in (a non-interactive session) this either blocked
the job or returned empty input, cancelling with *"Operation cancelled by user"*
and reporting nothing. The safe preview mode did not work from Orchestrator.

**Root cause:** The function gated deletion on `if (-not $Force -and -not
$WhatIfPreference)`. `$WhatIfPreference` is only set by PowerShell's built-in
`-WhatIf` *switch*; the workflow passes `WhatIf` as a *string value* (`'yes'`/`'no'`),
so `$WhatIfPreference` was always `$false` → the `Read-Host` branch always ran
in preview mode.

**Change made:**

*Before*
```powershell
# in Remove-OldFiles-UNCPath param() block:
[bool]$Force=$false

# in the process block:
# Confirm deletion if not using -Force or -WhatIf
if (-not $Force -and -not $WhatIfPreference) {
    $Confirmation = Read-Host "Are you sure you want to delete these files? (Y/N)"
    if ($Confirmation -ne 'Y') {
        write-log "Info: Operation cancelled by user" $true
        return
    }
}

# in the Delete-OldFiles-UNC-Share switch case:
if($WhatIf -eq 'yes'){
    Remove-OldFiles-UNCPath -path $UNC_SharePath -OlderThanDays $OlderThanDays -Force $false
}elseif($WhatIf -eq 'no'){
    Remove-OldFiles-UNCPath -path $UNC_SharePath -OlderThanDays $OlderThanDays -Force $true
}else{

}
```

*After*
```powershell
# in Remove-OldFiles-UNCPath param() block — new parameter:
[bool]$Force=$false,

[Parameter(Mandatory=$false)]
[bool]$ReportOnly=$false

# in the process block — Read-Host gate replaced:
# Report-only mode: list the files that WOULD be deleted, then exit
# without deleting anything. (Replaces the interactive Read-Host.)
if ($ReportOnly) {
    write-log "Info: ReportOnly mode enabled - NO files will be deleted." $true
    write-log "Info: The following $($FilesToDelete.Count) file(s) would be deleted:" $true
    foreach ($File in $FilesToDelete) {
        write-log "Info: [ReportOnly] WouldDelete: $($File.FullName) (LastWriteTime: $($File.LastWriteTime))" $true
    }
    return
}

# in the Delete-OldFiles-UNC-Share switch case:
if($WhatIf -eq 'yes'){
    # Report-only: lists candidate files, deletes nothing.
    Remove-OldFiles-UNCPath -path $UNC_SharePath -OlderThanDays $OlderThanDays -ReportOnly $true
}elseif($WhatIf -eq 'no'){
    # Live deletion, no interactive prompt.
    Remove-OldFiles-UNCPath -path $UNC_SharePath -OlderThanDays $OlderThanDays -Force $true
}else{
    write-log "Error: Delete-OldFiles-UNC-Share - invalid WhatIf value '$WhatIf' (expected 'yes' or 'no'). No action taken." $true
}
```

**Behaviour change to be aware of:**
- `whatIf='yes'` now **reports only** (lists candidate files via `Write-Log`,
  deletes nothing) and runs without prompting — safe non-interactively.
- `whatIf='no'` deletes for real, **without** the former interactive prompt.
  (Orchestrator has no operator to answer a prompt; the `whatIf` input is now
  the sole safety control. It defaults to `yes`.)
- An invalid `whatIf` value now logs an `Error:` line (previously did nothing
  silently), which the workflow's `parseScriptOutput` reports as a failure.
- **Manual interactive callers** of `Remove-OldFiles-UNCPath` no longer get a
  confirmation prompt. Use `-ReportOnly $true` to preview before a live run.

**Retired (see S-5):** The previously-proposed "additive changes"
(`move-archived-logs-ByHostList` action + `$HostList` parameter) have been
**removed from the script** — the LocalHost workflow they served was removed
(see process changes P-2/P-3) and will not be built.  The PS host is instead
added to the AD group and handled by `move-archived-logs-ByCN` like any other
member.

### S-2 … S-4 detail — parameterised filter/age and resilient per-server handling

**Why these were added:** The `Move-ArchivedLogs-ByADGroup` workflow requirements
are that the operator supplies six inputs — domain, group (DN), script path,
file share target, **file extension filter**, and **file age** — and that:
disabled machines are not processed; an unavailable machine is handled, logged,
and does **not** stop the remaining moves; and only a failure that would make
**every** move fail terminates the run. The first two requirements could not be
met with the script as it stood: the `move-archived-logs-ByCN` case hardcoded
`Archive*.evtx` / `-1`, and per-server failures were either unlogged (silent
non-terminating `Get-ChildItem` errors on the PS error stream) or logged with a
malformed message.

**Failure-handling contract after S-2…S-4:**
- **Disabled server** → skipped during resolution (`Get-ListOfServers-ByCN`,
  `Enabled -eq $true`) and logged as an `Info:` skip.
- **Unavailable/failed server** → `Move-files` hits a terminating error (via
  `-ErrorAction Stop`), logs an `Error:` line to stdout, and the per-server loop
  continues. The workflow's `parseScriptOutput` sees the `Error:` line and ends
  the run in **Completed with Errors** (not a hard failure).
- **Total failure** (AD module missing, or group/domain resolution failing) →
  the script `throw`s / the AD cmdlet errors terminate; the OOTB *Invoke a
  PowerShell script* workflow routes to `handlePSFailure` → **Failed** end state.

---

## 2A. Changes to build tooling & setup guides

| # | Date | File(s) | Change | Reason |
|---|------|---------|--------|--------|
| T-1 | 2026-06-30 | `code/Configure-vROPSHost.ps1`, `documentation/PS-Host-Build-Guide.txt` | PS host certificate is now exported as **Base-64 (PEM)** instead of DER | vRO's "Import a trusted certificate from a file" only accepts Base-64/PEM. The prior `Export-Certificate -Type CERT` produced DER (binary), which vRO rejected with *"Could not import the SSL certificate. Check whether the file contains a valid SSL certificate."* The guide also now notes the proxy caveat for URL-based import (vRO appliance proxy returning 503 / read-timeout). |
| T-2 | 2026-07-09 | `code/Configure-vROPSHost.ps1` (Step 4) | Create the WinRM **HTTPS listener via the WSMan provider** (`New-Item -Path WSMan:\localhost\Listener …`) instead of `Invoke-Expression "winrm create … @{…}"`; restart WinRM and **verify the listener exists** before reporting success | The `winrm create … @{Hostname=…;CertificateThumbprint=…}` form is cmd.exe syntax. Under PowerShell (via `Invoke-Expression`) the unquoted `@{…}` was parsed as a hashtable and stringified to `System.Collections.Hashtable` before reaching `winrm.exe`, so the listener was **never created** — only HTTP/5985 ended up listening. As a native-command failure it raised no exception, so the `try/catch` printed a false `[OK]`. Symptom: `Test-NetConnection <host> -Port 5986` fails and `winrm enumerate winrm/config/listener` shows only `Transport = HTTP`. The provider cmdlet binds the cert correctly and raises a real terminating error on failure. |
| T-3 | 2026-07-10 | `documentation/Implementation-Guide.md`, `documentation/PS-Host-Build-Guide.txt` | Corrected the Kerberos setup guidance after live bring-up on VCF Orchestrator 9: (a) **fixed the `krb5.conf` `[realms]` block** from the single-line `VCF.LAB = { kdc = …; default_domain = … }` form to the required **multi-line, one-key-per-line, no-`;`** form; (b) **corrected the root cause of `salt must be at least 128 bits`** — it is the **service account sAMAccountName being too short**, not a malformed krb5.conf (the guide previously stated the wrong cause); (c) added a **new prerequisite** that `UPPERCASE_REALM + sAMAccountName ≥ 16 chars` and bumped the example account `vcf_svc` → `vcf_svc_ps`; (d) added a **Kerberos bring-up error sequence** covering `Vector cannot be cast to Hashtable`, the salt error, and `Pre-authentication information was invalid (24)`; (e) require the **UPN** username form (not `DOMAIN\user`) for Kerberos; (f) set `dns_lookup_kdc = false` since the KDC is pinned | Adding the PS host over HTTPS/Kerberos failed through three successive errors that the docs either caused (the single-line realm block threw `java.util.Vector cannot be cast to java.util.Hashtable` in Java's `sun.security.krb5.Config` parser) or mis-diagnosed (the salt error was documented as a krb5.conf problem, sending troubleshooting down the wrong path; the true cause is the 128-bit AES salt = realm + account name being under 16 chars on the hardened JDK). The `(24)` pre-auth error was undocumented. These are one-time bring-up gotchas but block the entire integration until resolved. |

**Operator note (already-exported DER files):** convert with
`certutil -encode <der>.cer <base64>.cer`, then import the Base-64 file. A
Base-64/PEM file opens as text beginning with `-----BEGIN CERTIFICATE-----`.

---

## 3. Changes to the automation process (Ansible → Orchestrator)

| # | Date | Area | Current process (Ansible) | New process (Orchestrator) | Reason |
|---|------|------|---------------------------|----------------------------|--------|
| P-1 | 2026-06-28 | Execution engine | Ansible runs PowerShell on each host via `win_shell`/`win_command`, staging the script with `win_copy` over WinRM | Orchestrator workflow calls the **pre-staged** `cvs_functions.ps1` via the OOTB *"Invoke a PowerShell script"* over the PowerShell plug-in (WinRM/HTTPS/Kerberos) from a single PS host | Replace Ansible with Orchestrator while reusing proven script logic; eliminates per-run script staging |
| P-2 | 2026-06-28 | Move workflows count | 6 move playbooks (2 local, 3 UNC-AD-group forks, 1 script-library) | **1** workflow: `Move-ArchivedLogs-ByADGroup` | Remove duplication; simplify operations. Customer preference: simplification over niche-case handling |
| P-3 | 2026-06-28 | LocalHost case | Dedicated "local execution" playbooks for the servers that ran the scripts | **Removed.** Those servers are AD-group members in the Orchestrator model and are covered by `Move-ArchivedLogs-ByADGroup` | The standalone local-host case is unnecessary once execution hosts are in the AD group |
| P-4 | 2026-06-28 | AD targeting method | Three near-duplicate AD-query variants (flat `sAMAccountName`, `-Credential`, `-Server`/CN-recursive) | One method: **recursive + Enabled-only** (`Get-ListOfServers-ByCN`) | Most comprehensive discovery — expands nested groups, skips disabled/decommissioned servers — and removes the duplicate forks |
| P-5 | 2026-06-28 | Cleanup workflow | `remove-OldFiles-UNCPath` playbook | `Remove-OldFiles-UNCShare` workflow (now with working report-only mode — see S-1) | Direct port; report-only safety mode now functional non-interactively |
| P-6 | 2026-06-28 | Server iteration | Ansible `loop` / dynamic inventory iterates servers | Script iterates internally (`foreach`); one workflow run = one script invocation | No `vRO`-side loop needed; AD resolution and iteration owned by the script |
| P-7 | 2026-06-28 | Variables / secrets | `vars` / `group_vars` / Ansible vault / `become` | Workflow inputs + a Configuration Element for defaults; credentials via the PS host plug-in service account | Standard Orchestrator patterns; no vault equivalent needed |
| P-8 | 2026-07-09 | Move workflow input model | Move-ArchivedLogs-ByADGroup defaults bound to Configuration Element attributes | **Move-ArchivedLogs-ByADGroup uses plain input parameters with defaults set directly on each input** (no Configuration Element). The move-only attributes (`defaultDomainName`, `defaultFileShareTarget`, `defaultFileFilter`, `defaultFileAgeDays`) were removed from the element; `defaultScriptPath` + `defaultLogRetentionDays` remain for Remove-OldFiles-UNCShare | Customer preference: these values are static per environment and "do not need to be updated by anything", so explicit self-contained inputs are preferred over a shared Config Element for the move workflow |

**Net result:** 7 playbooks → **2 workflows** (`Move-ArchivedLogs-ByADGroup`,
`Remove-OldFiles-UNCShare`); 5 build actions → **3**. Both invoked actions
(`move-archived-logs-ByCN`, `Delete-OldFiles-UNC-Share`) already exist in the
deployed script; the changes to `cvs_functions.ps1` are limited to S-1 (report-only)
and S-2…S-4 (parameterised file filter/age + resilient, logged per-server failure
handling for the AD-group move).

---

## 4. Current vs new — quick mapping

| Today (Ansible playbook) | New (Orchestrator workflow) |
|---|---|
| `file-move_with-LocalPath_Inventory` | `Move-ArchivedLogs-ByADGroup` (hosts now AD-group members) |
| `file-move_with-LocalPath_AD-Group` | `Move-ArchivedLogs-ByADGroup` |
| `file-move_with-UNCPath_AD-Group` | `Move-ArchivedLogs-ByADGroup` |
| `file-move_with-UNCPath_AD-Group-TEST` | `Move-ArchivedLogs-ByADGroup` |
| `file-move_with-UNCPath_AD-Group-TEST(1)` | `Move-ArchivedLogs-ByADGroup` |
| `move-win-archived-logs` | `Move-ArchivedLogs-ByADGroup` |
| `remove-OldFiles-UNCPath` | `Remove-OldFiles-UNCShare` |

---

## 5. Outstanding / deferred (Phase 2)

| Item | Status / note |
|---|---|
| Per-server status reporting in Orchestrator | Deferred — script outputs aggregate stdout; per-server breakdown needs further script work |
| Email reporting on workflow completion | Deferred — not confirmed in scope |
| Broader optimization of `cvs_functions.ps1` | Out of scope for the delivery replacement effort |

---

## Revision history

| Date | Author | Summary |
|---|---|---|
| 2026-06-28 | Automation transition | Initial register. Recorded script change S-1 (report-only fix) and process changes P-1…P-7 (consolidation to 2 workflows; LocalHost removed; single recursive+Enabled AD targeting). |
| 2026-06-30 | Automation transition | Added tooling change T-1 — PS host cert exported as Base-64/PEM (was DER, rejected by vRO file import); documented URL-import proxy caveat. |
| 2026-07-08 | Automation transition | Added script changes S-2…S-4 for `Move-ArchivedLogs-ByADGroup`: parameterised file filter/age (were hardcoded), AD-module guard, per-server `try/catch`, reliable/logged failure handling (`-ErrorAction Stop`, fixed catch message), and `Get-ListOfServers-ByCN` per-object isolation with logged disabled-server skips. Renamed the group input `adGroup` → `groupDN` (DN is the intended identifier) and added `fileFilter` / `fileAgeDays` inputs and `defaultFileFilter` / `defaultFileAgeDays` Config Element attributes. |
| 2026-07-08 | Automation transition | Added script change S-5: removed the orphaned `move-archived-logs-ByHostList` action (ValidateSet entry, `$HostList` parameter, switch case) — it served a LocalHost workflow that will not be built; the PS host joins the AD group and is handled by `move-archived-logs-ByCN`. |
| 2026-07-09 | Automation transition | Added tooling change T-2 — `Configure-vROPSHost.ps1` Step 4 now creates the WinRM HTTPS listener via the WSMan provider (was `Invoke-Expression "winrm create … @{…}"`, which PowerShell mangled so the 5986 listener was never created and a false `[OK]` was printed); restarts WinRM and verifies the listener before reporting success. |
| 2026-07-09 | Automation transition | Process change P-8: Move-ArchivedLogs-ByADGroup converted to plain input parameters with defaults set directly on each input (no Configuration Element). Removed the move-only attributes `defaultDomainName` / `defaultFileShareTarget` / `defaultFileFilter` / `defaultFileAgeDays`; the Configuration Element is retained (`defaultScriptPath`, `defaultLogRetentionDays`) for Remove-OldFiles-UNCShare only. Updated all package docs accordingly. |
| 2026-07-09 | Automation transition | Authored the customer documentation set (Executive-Summary, Design-Document, Implementation-Guide, User-Guide) under `documentation/`. |
| 2026-07-10 | Automation transition | Corrected the workflow folder path across all package docs to `Production >> Servers >> Windows >> Event Log Management` (lab/dev: under `Workflows >> Customer >> <Customer Name> >> Production >> …`). The actions' module namespace (`broadcom.pso.vc.vm.guestOps.files.windows.logs`) is unchanged. |
| 2026-07-10 | Automation transition | Tooling/docs change T-3 — corrected the Kerberos setup guidance after live bring-up: fixed the `krb5.conf` `[realms]` block to the required multi-line/no-`;` form (single-line form threw `Vector cannot be cast to Hashtable`); corrected the `salt must be at least 128 bits` root cause to service-account name length (was wrongly attributed to krb5.conf); added the `UPPERCASE_REALM + sAMAccountName ≥ 16 chars` prerequisite (example account `vcf_svc` → `vcf_svc_ps`); added a Kerberos bring-up error sequence (incl. pre-auth error 24); required UPN username form; set `dns_lookup_kdc = false`. |
