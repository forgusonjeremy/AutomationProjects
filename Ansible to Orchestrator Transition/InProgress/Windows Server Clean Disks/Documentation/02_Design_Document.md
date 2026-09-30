# Design Document — Windows Server Disk Cleans

Workflow **Windows Server Disk Cleans**, VCF Operations Orchestrator 9. Replaces the
Ansible playbook `servers_diskclean.yml` (which ran `cvs_functions.ps1 -Action
clean-ServerDisk`). The authoritative definition of the workflow is its export,
`Code/serverDiskCleansWorkflow.yml`. Every change and its reason is in
`Change-Register.md`.

---

## 1. Architecture

```
 Orchestrator                                       PowerShell host              Targets
 ───────────────────────────────────────────        ────────────────────         ─────────
 AD plug-in ── group DN → direct, enabled computers
 selectPowerShellHost ── least-busy host ─────────► (WinRM/HTTPS 5986, Kerberos)
 stageScriptOnHost ── copy script only if missing ─► C:\PSO\Scripts\
                      or different (SHA-256)          Invoke-ServerDiskClean.ps1
 invokeStagedScript ── run it with parameters ─────► script ── SMB 445 ─────────────► \\server\c$\<folder>
 Parse Results ◄────── PSO_RESULT (JSON) ◄──────────
 Mail plug-in ── HTML report ─────────────────────────────────────────────────────► SMTP relay
```

- **Active Directory** is read by the Orchestrator AD plug-in. No PowerShell and no
  ActiveDirectory module are involved in resolving the group.
- **All file work happens in one place:** the script on the PowerShell host, reaching
  each target through its admin share. Nothing is installed or run on the targets.
  Physical and virtual servers are treated identically.
- **Mail leaves from Orchestrator**, not from the PowerShell host.

### Second hop (delegation)

The script runs in a WinRM *network* logon on the PowerShell host and then opens
`\\server\c$` on each target. That second hop only works if the host's session can pass
on its credential: Kerberos constrained delegation, as for the other transitioned
workflows. The fact that an account can browse the share when logged on interactively
proves nothing about the remote session. When access is refused, the script's error says
so explicitly and names delegation as the likely cause.

---

## 2. Components

| Component | Type | Module / location | Role |
|---|---|---|---|
| **Windows Server Disk Cleans** | Workflow | — | Orchestrates the run |
| `findAdHostForDn` | Action (shared) | `com.broadcom.pso.vcf.activedirectory` | Picks the AD endpoint from the DN's `DC=` parts |
| `resolveAdGroup` | Action (shared) | `com.broadcom.pso.vcf.activedirectory` | Looks the group up **on that endpoint** |
| `getADComputersGroupDirectMembers` | Action (shared) | `com.broadcom.pso.vcf.activedirectory` | Direct, enabled computer members; nested groups named, not expanded |
| `selectPowerShellHost` | Action (shared) | `com.broadcom.pso.powershell` | Least-busy host from the `psHosts` list |
| `stageScriptOnHost` | Action (shared) | `com.broadcom.pso.powershell` | Copies the script to the host only if missing or different; returns its verified path |
| `invokeStagedScript` | Action (shared) | `com.broadcom.pso.powershell` | Runs the staged script and parses its result |
| `Invoke-ServerDiskClean.ps1` | Resource Element | bound to attribute `scriptElement` | The cleaning script, fully commented |
| *Send notification (TLSv1.2)* | Workflow (OOTB) | Library > Mail | Sends the HTML report |

Shared actions have one copy in the repository (`InProgress/_Shared/Code/`) and one copy in
Orchestrator, used by every workflow that needs them.

---

## 3. Workflow schema

| # | Element | Type | Key bindings |
|---|---|---|---|
| 1 | findAdHostForDn | Action | `distinguishedName` → `adHost` |
| 2 | resolveAdGroup | Action | `distinguishedName`, `adHost` → `adGroup` |
| 3 | Get Computers in AD Group - Direct Members | Action | `adGroup` → `computerNames` |
| 4 | selectPowerShellHost | Action | `psHosts` → `resolvedHost` |
| 5 | Create Script Parameters | Scriptable task | form inputs → `scriptParameters`, `mailToString` |
| 6 | stageScriptOnHost | Action | `resolvedHost`, `scriptElement`, `targetPath` → `stagedScript` (full path) |
| 7 | invokeStagedScript | Action | `resolvedHost`, `stagedScript`, `scriptParameters` → `scriptRunResult` |
| 8 | Parse Results | Scriptable task | `scriptRunResult` → outputs, `reportSubject`, `reportHtml` |
| 9 | Email Report? | Decision | `emailReport` — true → 10, false → 11 |
| 10 | Send notification (TLSv1.2) | Workflow (synchronous) | `mailToString`, `reportSubject`, `reportHtml`, SMTP attributes. **Exception → `emailError` → 11** |
| 11 | Closing Summary | Scriptable task | folds the email outcome into `executionSuccess`; writes the closing log line |

Nothing is deleted before element 7. Any failure up to and including element 6 means
nothing was touched on any server.

### Attributes

| Attribute | Type | Set | Purpose |
|---|---|---|---|
| `psHosts` | Array/PowerShell:PowerShellHost | at build | The PowerShell hosts this workflow may run on |
| `scriptElement` | ResourceElement | at build | The `Invoke-ServerDiskClean.ps1` Resource Element |
| `maxItemsListed` | number | at build (`25`) | Items named per folder per server in the log |
| `smtpHost`, `smtpPort` | string, number | at build | Relay and port (blank / `0` = Mail plug-in default) |
| `useStartTls` | boolean | at build | STARTTLS on/off, to match the relay |
| `username`, `password` | string, SecureString | at build | Only if the relay requires SMTP authentication |
| `fromName`, `fromAddress` | string | at build | Sender |
| `adHost`, `adGroup`, `computerNames`, `resolvedHost`, `scriptParameters`, `mailToString`, `stagedScript`, `scriptRunResult`, `reportSubject`, `reportHtml`, `emailError` | various | at run time | Passed between elements |

### Outputs

| Output | Type | Meaning |
|---|---|---|
| `executionSuccess` | boolean | `true` only if every server was processed without error **and** (when requested) the report was sent |
| `executionOutput` | string | One-line summary |
| `serversProcessed` | number | Servers whose admin share could be opened |
| `itemsDeleted` | number | Items removed (0 in a Report Only run) |
| `bytesFreed` | number | Bytes removed; in Report Only, the estimate of what would be removed |
| `transcript` | string | The script's full log |

---

## 4. Inputs (request form)

| Input | Form label | Type | Notes |
|---|---|---|---|
| `distinguishedName` | AD Group Distinguished Name | string | The group's full DN. The domain, AD endpoint and target list all follow from it |
| `folderTarget` | Folder where files to be deleted are located | Array/string | One **local** path per row, as seen on each server, e.g. `c:\Windows\ccmcache` |
| `fileFilter` | Delete files matching (wildcards supported) | string | Applies to **files only**. `*.*` = every file |
| `reportOnly` | Report Only or Report and Delete? | string | `yes` = Report Only (default), `no` = Report and Delete |
| `olderThanDays` | Delete items older than N days | number | Whole number ≥ 0 |
| `forceEnable` | Delete read-only items? | boolean | |
| `folderIncluded` | Delete folders as well? | boolean | Subject to the folder rule (§6) |
| `emailReport` | Email report? | boolean | |
| `mailTo` | Email addresses to whom the report is sent | Array/string | One address per row |
| `mailSubject` | Email subject | string | Subject stem; the outcome is appended |
| `targetPath` | Script directory on the PowerShell host | string | **Local directory**, e.g. `C:\PSO\Scripts`. Not a UNC path, not a file name |

---

## 5. Targeting — which servers are cleaned

- Only computer accounts that are **direct** members of the group. **Nested groups are
  not expanded.** Each nested group is named in a warning so the omission is visible.
  This is deliberate for a destructive action: a group added later by someone else cannot
  silently add its servers to a delete run.
- **Disabled** computer accounts are skipped and logged.
- Each computer's FQDN is built from its own DN, so members from another domain are
  addressed correctly.
- Zero direct, enabled computer members stops the run before anything touches a host.

---

## 6. Selection — what is deleted

For each folder target on each reachable server:

1. **Files** under the target are found recursively, matching `fileFilter`. Hidden and
   system items are not enumerated.
2. **Folders** are considered only with **Delete folders as well**, and are chosen **by age
   alone, whatever their name**. A folder is removed whole, with everything in it.
3. An item is a candidate when its last-write time is older than the cutoff (now minus
   `olderThanDays`) **and** its name is not exactly `vmware-vmsvc-SYSTEM.log`.
4. Each candidate is removed individually. Read-only items are removed only with
   **Delete read-only items**. One failure is logged and the rest continue.
5. The target folder itself is never removed; it is emptied.

### The folder rule

Deleting a folder deletes everything in it, so folders are deleted **only** when
**Delete folders as well** comes together with:

- a filter that matches every file (`*` or `*.*`), **and**
- **Delete read-only items**.

With any other combination, **folder deletion is declined, not the run.** Every folder is
left in place and files matching the filter are still cleaned (or listed, in Report
Only). *Create Script Parameters* warns up front. The script makes the decision and
returns the reason, and the summary and email show it in red. A request is never widened
automatically.

### What is never deleted

| Item | Why |
|---|---|
| `vmware-vmsvc-SYSTEM.log` (exact, case-sensitive name) | Live VMware Tools log. Exception: it goes with a folder that is itself removed |
| Anything last written at or after the cutoff | Age rule. Same folder exception |
| Loose hidden / system files directly in a target | Not enumerated |
| The target folder itself | Emptied, not removed |
| Read-only items, unless **Delete read-only items** | Delete fails and is logged |
| All folders, unless the folder rule is met | See above |
| **Everything**, in a Report Only run | Nothing is deleted |

> **A folder is removed whole.** A folder's own timestamp changes only when entries
> directly in it change, so an old folder can hold newer files and they go with it. The
> user-profile templates rely on this to remove whole profiles. It is harmless for the
> SCCM cache, whose content is written once.

### Folder-target guard

Checked in *Create Script Parameters* and again in the script, before any server is touched:

- Must be an absolute local path with a drive letter. No UNC paths, wildcards or `..`.
- A **drive root** is refused.
- Anything that **is, or is inside**, `\Windows`, `\Program Files`, `\Program Files (x86)`,
  `\ProgramData`, `\Boot`, `\Recovery` or `\System Volume Information` (on any drive) is
  refused, **except** `\Windows\ccmcache`, `\Windows\Temp` and
  `\Windows\SoftwareDistribution\Download` and anything inside them.
- `c:\users` is allowed (profile templates).

---

## 7. Script delivery and execution

- **Staging.** `stageScriptOnHost` builds `targetPath\<Resource Element name>` and
  compares the SHA-256 and size of the file on the host with the Resource Element:
  - **absent:** copy it;
  - **exact match:** run the existing copy, and nothing is sent;
  - **any difference:** overwrite it, re-hash, and fail the run if it still does not match.

  The copy is written through a temporary file and a move, so a half-written script is
  never run. The log records the version, hash and outcome (`first copy` / `unchanged` /
  `updated`).
- **Execution.** `invokeStagedScript` runs the verified path through the host's own
  session, merges all output streams, and parses the script's single `PSO_RESULT=` JSON
  line. A missing result line means the script did not complete, and the run fails
  rather than reporting "nothing found".
- **Host selection.** `selectPowerShellHost` probes each host in `psHosts` (CPU, memory,
  active remote PowerShell sessions) and picks the least busy. A list of one is used
  without probing. A host that does not answer is skipped.
- **Reachability.** Each server's admin share is checked by listing it, so a failure
  reports the real reason: network path not found, share missing, or access denied.

### Run time and the WinRM timeout

The clean is one synchronous PowerShell call. Deleting over SMB costs time per item, not
per byte, so a large cache takes minutes. The host's `WSMan:\localhost\MaxTimeoutms` and the
PowerShell plug-in timeout must both exceed the longest run. A Report Only run's duration
is a lower bound for the live run.

---

## 8. Reporting and end states

- **Per-server statuses:** `Cleaned`, `CleanedWithErrors`, `ReportOnly`, `Unreachable`, `Failed`.
- **Email** (Orchestrator Mail plug-in): summary, a red notice if folder deletion was
  declined, the AD group, folders, cutoff, options and script, then a per-server table
  (matched, deleted, failed, freed, free space before/after, detail). Problems are listed
  first.
- **A send failure does not fail the run.** The send's exception is routed to *Closing
  Summary*, which sets `executionSuccess = false` and logs "report NOT emailed" with the
  reason.

| Condition | End |
|---|---|
| Bad inputs, empty group, no answering host, staging failure, script did not complete | Workflow fails (nothing deleted if before element 7) |
| Unreachable server, undeletable item, folder missing on every server | Completes, `executionSuccess = false` |
| Folder deletion declined | Completes; files cleaned; notice in summary and email |
| Report could not be emailed | Completes, `executionSuccess = false` |
| Everything handled | Completes, `executionSuccess = true` |

---

## 9. Security considerations

- The PowerShell host's account needs **local administrator** on every target (required
  for `\\server\c$`) and delegation for the second hop. Scope it to the servers this
  workflow cleans.
- The script directory (`C:\PSO\Scripts`) should be writable only by the account the
  PowerShell host object connects as. Anything else written there is overwritten on the
  next run, because the file is re-verified by hash every time.
- Credentials: none are stored in the workflow for AD (the plug-in endpoint's account is
  used) or for the host (the PowerShell host object's account). SMTP credentials, if
  ever needed, are a SecureString attribute.
- Destructive safeguards: Report Only default, direct-membership targeting, folder rule,
  system-folder guard, protected VMware log.

---

## 10. Assumptions, dependencies and known limitations

### Dependencies

- PowerShell host(s) registered in Orchestrator (WinRM/HTTPS, Kerberos, SHA-256 listener
  certificate) with delegation to the targets.
- SMB (TCP 445) from the PowerShell host to every target.
- AD plug-in endpoint registered for every domain whose groups are targeted.
- **Network path from every Orchestrator appliance to the SMTP relay** (TCP 25, or the
  configured port), DNS resolution of the relay name, and a relay allow-list covering the
  appliance addresses. If the relay uses TLS, its certificate trusted in Orchestrator and
  the port's security mode matched to `useStartTls`. See
  `_Shared/Documentation/Email-Notification-Standard.md`.

### Known limitations

- Load-based host selection is a snapshot. Two runs starting together may pick the same host.
- A folder older than the cutoff is removed with any newer content inside it (§6).
- Loose hidden/system files directly in a target are never removed.
- The free-space figures are for the whole drive and can be affected by other activity
  during the run.
- The OOTB mail workflow has no CC. All recipients go in `mailTo`.
