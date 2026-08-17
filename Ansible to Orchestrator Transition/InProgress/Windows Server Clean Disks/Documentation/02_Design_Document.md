# Windows Server Clean Disks — Design Document

## 1. Architecture overview

The workflow builds one PowerShell invocation string, executes it on a pre-staged PS
host via the OOTB *Invoke a PowerShell script* workflow, and parses the result.
**All AD resolution, per-server iteration, folder-list parsing, filtering and
deletion happen inside `cvs_functions.ps1`** (action `clean-ServerDisk`), not in
Orchestrator. **One workflow run = one script invocation; there is no
Orchestrator-side loop.**

```
Operator (custom form)
      │
      ▼
Clean-ServerDisks-ByADGroup workflow
      │
      ├─ buildCleanDisksInvocation (Action) ── invocation string
      │                                            │
      │        OOTB "Invoke a PowerShell script" (WinRM/HTTPS 5986)
      │                                            ▼
      │                                   PowerShell Host ── cvs_functions.ps1
      │                                            │   (Action: clean-ServerDisk)
      │                                            │   Get-ListOfServers-Direct (non-recursive, Enabled-only)
      │                     ┌──────────────────────┼───────────────────────┐
      │                     ▼                       ▼                       ▼
      │            AD (Get-ADGroupMember     \\server\C$\<folderTarget>   Remove-files
      │             / Get-ADComputer)         (admin share)              (age + filter + whatIf gate)
      ▼
 parseScriptOutput (Action) ── success/outputText/errorText ── End state
```

- **Server targeting** is by AD group, resolved to **direct (non-recursive), enabled
  computer objects only**; disabled and non-computer objects are skipped **and
  logged**; each object is resolved in its own `try/catch`.
- Each target path `c:\<path>` is rewritten to `\\<server>\c$\<path>` and cleaned via
  `Remove-files`.
- **Deleting files is destructive**, so targeting is deliberately non-recursive (nested
  sub-groups are never expanded) and the workflow defaults to report-only.

## 2. Components

| Component | Role | Shared? |
|---|---|---|
| **Workflow: Clean-ServerDisks-ByADGroup** | Clean target folders on enabled AD-group members | No — this deliverable |
| **Action: buildCleanDisksInvocation** | Build the `clean-ServerDisk` invocation string; validate inputs; convert `olderThanDays` → `-NumberOfDays` (return type: string) | No — this deliverable |
| **Action: parseScriptOutput** | Parse the OOTB PSObject output → Properties `{success, outputText, errorText}` | Yes → shared (logs module) |
| **Scriptable task: handlePSFailure** | Shared exception path for terminating PS/plugin failures | Yes → shared (logs module) |
| **OOTB: Invoke a PowerShell script** | Executes the invocation string on the PS host | Yes → OOTB library |
| **cvs_functions.ps1** | Shared PowerShell toolbox (AD resolution, clean); changes S-14, S-15 | Yes → Change-Register.md |
| **PowerShell host** | Windows Server running `cvs_functions.ps1`; reaches targets via UNC | Yes → PS-Host guide |

- **Module namespace (build action):** `broadcom.pso.vcf.vm.guestOps.files.windows.diskcleanup`
- **Workflow folder:** `Production > Servers > Windows > Disk Cleanup` (lab/dev:
  `Workflows > Customer > <Customer Name> > Production > Servers > Windows > Disk Cleanup`)
- **No Configuration Element:** operator inputs use plain workflow inputs with defaults
  set directly on each input. `fileFilter` is a fixed workflow **attribute** (`*.*`).

## 3. Data flow

1. `buildCleanDisksInvocation` validates inputs and returns:
   `& "<scriptPath>" -Action 'clean-ServerDisk' -ADGroupMember '<groupDN>' -DomainName '<domain>' -FolderTarget '<folders>' -FilterOn '*.*' -NumberOfDays '<-olderThanDays>' -FolderIncluded '<yes|no>' -ForceEnable '<yes|no>' -WhatIf '<yes|no>' *>&1 | Out-String -Width 4096`
   - `olderThanDays` (positive) is converted to the script's negative convention:
     `-NumberOfDays = -olderThanDays`. Operators never type a negative number.
   - `fileFilter` is fixed at `*.*` (matches all files **and** folders).
   - `whatIf = no` logs a loud `System.warn`; `whatIf = yes` is report-only.
   - The `*>&1 | Out-String -Width 4096` stream-capture is a shared requirement; without
     it the plugin returns a null object.
2. OOTB *Invoke a PowerShell script* runs the string on `psHost`; output → attribute
   `psRawOutput`.
3. In the script, `Get-ListOfServers-Direct` resolves the group (direct, enabled-only)
   to computers; for each server × each folder target, `Remove-files` selects items
   older than the cutoff and either lists them (`whatIf = yes`) or deletes them.
4. `parseScriptOutput` receives `psOutput = psRawOutput` and
   `executionContext = groupDN + " @ " + domainName + " (whatIf=" + whatIf + ")"` (a
   **log label only**), returning Properties `{success, outputText, errorText}`.
5. Decision `parsedResult.get("success") === true` → **End - Completed Successfully**;
   false → **End - Completed with Errors**.

**Outputs:** `executionSuccess` (boolean), `executionOutput` (string).

## 4. Inputs and the fixed filter

| Input | Type | Default | Maps to |
|---|---|---|---|
| `psHost` | PowerShell:PowerShellHost | (none) | execution target |
| `scriptPath` | string | `C:\PSO\Scripts\cvs_functions.ps1` | `& "<scriptPath>"` |
| `groupDN` | string | (none) | `-ADGroupMember` |
| `domainName` | string | `vcf.lab` | `-DomainName` |
| `folderTarget` | string | `c:\Windows\ccmcache` | `-FolderTarget` |
| `olderThanDays` | number | `1` | `-NumberOfDays` (`= -olderThanDays`) |
| `folderIncluded` | boolean | `true` | `-FolderIncluded` (`yes`/`no`) |
| `forceEnable` | boolean | `false` | `-ForceEnable` (`yes`/`no`) |
| `whatIf` | string (yes/no) | `yes` | `-WhatIf` |
| **`fileFilter`** | **fixed attribute** | **`*.*`** | `-FilterOn` |

- `folderTarget` accepts one or more comma-separated local paths; each `c:\path` is
  rewritten to `\\server\c$\path`.
- `olderThanDays` = "delete items older than N days": `4` = 4 days old or older, `1` =
  older than a day (default), `0` = delete everything up to now.
- **`fileFilter` is not an operator input.** It is pinned to `*.*` because `-FilterOn`
  is applied to **directory names too**; a restrictive filter (e.g. `*.txt`) matches no
  folders, so `folderIncluded = yes` would silently fail to delete folders. `*.*`
  matches all files and folders.

## 5. Items intentionally NOT deleted

The clean does **not** delete everything under a target. These categories are
preserved by design (inherited from the original Ansible script except where noted).
This is the customer-facing list; see Change-Register §2A for the mechanism.

| Preserved item | Why | Configurable? |
|---|---|---|
| **`vmware-vmsvc-SYSTEM.log`** | Hardcoded name exclusion (`$FileExclude`). **Case-sensitive** — only that exact casing is protected. | No |
| **Items newer than the cutoff** | Deletes only `LastWriteTime < (today − olderThanDays)`. | Yes (`olderThanDays`) |
| **Loose hidden / system files** | Enumeration runs without `-Force`, so hidden files directly in a target are never listed — regardless of `forceEnable`. A hidden file *inside a deleted folder* still goes. | No (matches original) |
| **The target root folder itself** | Only the folder's **contents** are cleaned; the target directory is never removed. | No |
| **Read-only files when `forceEnable = no`** | `Remove-Item` without `-Force` cannot delete read-only items. `forceEnable = yes` deletes them. `forceEnable` has **no** effect on hidden files. | Yes (`forceEnable`) |
| **All folders when `folderIncluded = no`** | Enumeration adds `-File`; directories are not candidates. | Yes (`folderIncluded`) |
| **Everything when `whatIf = yes`** | Report-only; lists candidates, deletes nothing. | Yes (`whatIf`) |

## 6. Failure-handling contract

| Condition | Behavior | End state |
|---|---|---|
| Disabled / non-computer member | Skipped during resolution; logged `Info: skipping disabled computer …` | Not fatal |
| Enabled-but-unreachable member | `Remove-files` `Get-ChildItem` terminating error (`-ErrorAction Stop`), logged `Error:`; per-server loop **continues** | Completed with Errors |
| Individual undeletable item (e.g. read-only under `forceEnable=no`) | Logged `Error:`; remaining items still delete | Completed with Errors |
| Zero enabled members, or empty folder list | Logged `Warn:`/`Error:`; clean exit, no action | Completed Successfully |
| Invalid `whatIf` value | Logged `Error:`, no action (fails safe); the build action also rejects non-`yes`/`no` up front | Completed with Errors / Failed: Bad Inputs |
| Bad inputs (validation) | `buildCleanDisksInvocation` throws | Failed: Bad Inputs |
| Total failure (AD module missing, group/domain unresolvable) | Script `throw`s; routes via `handlePSFailure` | Failed: PS Execution |

## 7. Dependencies

- **PS host** (domain-joined Windows Server) with the **RSAT ActiveDirectory module**
  (`Get-ADGroupMember` / `Get-ADComputer`), a WinRM HTTPS listener (5986), and network
  reach to each target's `C$` admin share.
- **Updated `cvs_functions.ps1`** deployed (changes S-14, S-15 — Change-Register).
- **AD group(s)** whose direct computer members are the servers to clean (identified by
  DN).
- **VCF Orchestrator 9** with the PowerShell plug-in and a registered PS host.
- **Shared actions** `parseScriptOutput` / `handlePSFailure` (reused from the Windows
  guest-ops logs module, as in the Move and Reboot packages).
- **Certificate trust** between Orchestrator and the PS host.

## 8. Assumptions

- The PS host service account has delete rights on the target folders — normally by
  being **local admin** on target servers (which is also what grants `\\server\C$`
  access). A non-admin service account gets only read on `c:\Windows\ccmcache` and
  cannot delete (see the Implementation Guide / lab `-GrantModifyTo`).
- Servers requiring cleanup are **direct** members of the AD group.
- `folderTarget`, `olderThanDays`, `folderIncluded`, and `forceEnable` match the
  intended template (cache vs user-profile) per run.
- Single-node Orchestrator in the lab; clustered deployments replicate host-side config
  on each node.

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Destructive live run against the wrong target | `whatIf` defaults to report-only; live runs log a loud warn; the build action nudges on drive-root/critical-dir targets |
| Restrictive filter silently skips folders | `fileFilter` is fixed to `*.*` and kept off the form |
| Enabled AD object for an offline host is still targeted | Disable the account or remove from the group; "enabled" means intent-to-process, not reachability |
| Service account lacks delete rights | Ensure it is local admin on targets (or grant Modify); a non-admin sees read-only failures |
| RSAT AD module absent | Verify `Get-Module -ListAvailable ActiveDirectory` before go-live |
| Script drift | Verify S-14 / S-15 present on the deployed script before use |
| Second-hop auth fails without delegation | Kerberos + constrained delegation (prod) or Basic-over-HTTPS (lab); validate the hop explicitly |

## 10. Security considerations

- **Transport:** WinRM over **HTTPS (5986)** only; `AllowUnencrypted` stays `false`.
- **Authentication:** Kerberos (preferred, production) enables the second hop **only
  with constrained delegation**; Basic-over-HTTPS (lab) generally works without
  delegation. Never use Basic over HTTP.
- **Credentials:** managed by the Orchestrator PS host configuration (service account);
  no secrets in the workflow or script.
- **Least privilege vs capability:** deleting under `\\server\C$` requires local-admin
  rights on targets. Scope the service account accordingly; it should not have rights
  beyond what cleanup requires.
- **`forceEnable`** deletes read-only files; it does not delete hidden/system files.
  The `vmware-vmsvc-SYSTEM.log` exclusion is retained.

## 11. Operational considerations

- **Execution model:** on-demand via custom form, or scheduled in Orchestrator. Default
  to report-only; schedule a live run (`whatIf = no`) only after validating the target
  and age on a report-only pass.
- **Idempotency:** re-running is safe — already-deleted items are simply absent next
  pass.
- **Observability:** per-server and per-item progress/failures are in the workflow run
  log; `executionSuccess`/`executionOutput` summarize the result.
- **Maintenance:** keep AD group membership current (add/remove servers there, not in
  code); monitor certificate expiry; re-verify Kerberos config after major Orchestrator
  upgrades.
- **Change control:** all `cvs_functions.ps1` and workflow-design changes are tracked in
  the Change-Register (S-# and P-#).
