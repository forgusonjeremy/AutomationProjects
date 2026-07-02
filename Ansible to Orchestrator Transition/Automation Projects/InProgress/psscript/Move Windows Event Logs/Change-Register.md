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
> - Deployed script under change: `psscript/files/cvs_functions.ps1`
> - Current-state playbooks (baseline): `Move Windows Event Logs/ansible code.md`
> - New Orchestrator package: `Move Windows Event Logs/code/`

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

> The Orchestrator package was designed to reuse the proven script **as-is**.
> The table below is the complete list of changes **to `cvs_functions.ps1`**. As of
> this revision there is exactly **one** functional change. (Changes to the build
> tooling and setup guides are tracked separately in section 2A.)

| # | Date | Function / Section | Change | Reason | Deployment impact |
|---|------|--------------------|--------|--------|-------------------|
| S-1 | 2026-06-28 | `Remove-OldFiles-UNCPath` + `Delete-OldFiles-UNC-Share` switch case | Replaced interactive `Read-Host` confirmation with a non-interactive `-ReportOnly` mode | The `Read-Host` prompt blocks (or silently cancels) when run non-interactively by the Orchestrator PowerShell plug-in, so `whatIf='yes'` never produced a usable "report only" preview | Requires redeploying the updated `cvs_functions.ps1` to the PS host. No change to how operators call the workflow. |

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

**Not changed / not required:** The previously-proposed "additive changes"
(`move-archived-logs-ByHostList` action + `$HostList` parameter) are **no longer
needed** — the LocalHost workflow was removed (see process change P-2). The
deployed script's other actions are untouched.

---

## 2A. Changes to build tooling & setup guides

| # | Date | File(s) | Change | Reason |
|---|------|---------|--------|--------|
| T-1 | 2026-06-30 | `code/Configure-vROPSHost.ps1`, `documentation/PS-Host-Build-Guide.txt` | PS host certificate is now exported as **Base-64 (PEM)** instead of DER | vRO's "Import a trusted certificate from a file" only accepts Base-64/PEM. The prior `Export-Certificate -Type CERT` produced DER (binary), which vRO rejected with *"Could not import the SSL certificate. Check whether the file contains a valid SSL certificate."* The guide also now notes the proxy caveat for URL-based import (vRO appliance proxy returning 503 / read-timeout). |

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

**Net result:** 7 playbooks → **2 workflows** (`Move-ArchivedLogs-ByADGroup`,
`Remove-OldFiles-UNCShare`); 5 build actions → **3**; and — apart from the S-1
report-only fix — **no changes to `cvs_functions.ps1`** are required, because
both invoked actions (`move-archived-logs-ByCN`, `Delete-OldFiles-UNC-Share`)
already exist in the deployed script.

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
