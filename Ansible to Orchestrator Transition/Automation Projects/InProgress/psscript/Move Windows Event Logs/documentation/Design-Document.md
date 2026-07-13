# Windows Archive Log Management — Design Document

**Project:** Ansible → VCF Orchestrator transition — "Move Windows Event Logs"
**Platform:** VCF Automation 9 / VCF Operations Orchestrator 9
**Status:** Draft — Phase 1
**Companion documents:** Executive Summary · Implementation Guide · User Guide ·
Change-Register.md · WindowsLogManagement-Config_definition.txt · Ansible-to-vRO-MappingTable.txt

---

## 1. Architecture overview

Orchestrator runs two operator-facing workflows. Each builds a PowerShell
invocation string, executes it on a pre-staged PowerShell host via the built-in
*Invoke a PowerShell script* workflow, and parses the result. All Active
Directory resolution and per-server iteration happen **inside the PowerShell
script**, not in Orchestrator.

```
Operator (custom form)
      │
      ▼
vRO Workflow ── build*Invocation (Action) ── invocation string
      │                                            │
      │            OOTB "Invoke a PowerShell script" (WinRM/HTTPS 5986)
      │                                            ▼
      │                                   PowerShell Host ── cvs_functions.ps1
      │                                            │
      │                     ┌──────────────────────┼───────────────────────┐
      │                     ▼                       ▼                       ▼
      │            AD (Get-ADGroupMember)   \\server\C$ (source)   \\fileshare (dest)
      ▼
 parseScriptOutput (Action) ── success/error ── End state
```

- **One invocation = one workflow run.** The script iterates all servers
  internally; there is no Orchestrator-side loop.
- **Server targeting** is by AD group, resolved recursively to **enabled
  computer objects only**.

---

## 2. Components

| Component | Role |
|---|---|
| **Workflow: Move-ArchivedLogs-ByADGroup** | Move `Archive-*.evtx` off enabled AD-group members to the archive share |
| **Workflow: Remove-OldFiles-UNCShare** | Delete files on the archive share older than a retention threshold (report-only default) |
| **Action: buildMoveByADGroupInvocation** | Build the `move-archived-logs-ByCN` invocation string; validate inputs |
| **Action: buildRemoveFilesInvocation** | Build the `Delete-OldFiles-UNC-Share` invocation string; validate inputs |
| **Action: parseScriptOutput** | Parse `PowerShellRemotePSObject` → `Properties{success, outputText, errorLines}` |
| **Scriptable task: handlePSFailure** | Shared exception path for terminating PS/plugin failures |
| **OOTB: Invoke a PowerShell script** | Executes the invocation string on the PS host |
| **Configuration Element: WindowsLogManagement-Config** | Default values for **Remove-OldFiles-UNCShare only** (`defaultScriptPath`, `defaultLogRetentionDays`). Move-ArchivedLogs-ByADGroup uses plain input parameters with defaults set on each input — no Config Element. |
| **PowerShell host** | Windows Server running `cvs_functions.ps1`; reaches targets via UNC |
| **cvs_functions.ps1** | Shared PowerShell toolbox (AD resolution, move, cleanup) |

**Module namespace (actions):** `broadcom.pso.vc.vm.guestOps.files.windows.logs`
**Workflow folder:** `Production > Servers > Windows > Event Log Management`
(lab/dev: `Workflows > Customer > <Customer Name> > Production > Servers > Windows > Event Log Management`)

---

## 3. Data flows / interactions

### Move-ArchivedLogs-ByADGroup
1. `buildMoveByADGroupInvocation` validates inputs and returns:
   `& "<scriptPath>" -Action 'move-archived-logs-ByCN' -SecurityGroup_CN '<groupDN>' -DomainName '<domain>' -FileShareTarget '<share>' -FilterOn '<filter>' -NumberOfDays '<age>'`
2. OOTB *Invoke a PowerShell script* runs it on `psHost`.
3. In the script, `Get-ListOfServers-ByCN` resolves the group (recursive) to
   enabled computers; each server's logs are moved via UNC to
   `<share>\<server-short-name>`.
4. `parseScriptOutput` scans stdout for `Error:` lines → `success` boolean.
5. End state: **Completed Successfully**, **Completed with Errors** (per-server
   failures logged), **Failed: Bad Inputs**, or **Failed: PS Execution**.

### Remove-OldFiles-UNCShare
1. `buildRemoveFilesInvocation` returns the `Delete-OldFiles-UNC-Share`
   invocation with `-UNC_SharePath`, `-OlderThanDays`, `-WhatIf`.
2. `whatIf='yes'` (default) → report-only (lists candidates, deletes nothing).
   `whatIf='no'` → live delete. Non-interactive (no `Read-Host`).
3. Parse + end state as above.

### Failure-handling contract
| Condition | Behavior |
|---|---|
| Disabled server | Skipped during resolution; logged `Info: skipping disabled computer …` |
| Unreachable/failed server | Terminating error inside `Move-files` (`-ErrorAction Stop`), logged `Error:` to stdout, loop continues; run ends **Completed with Errors** |
| Zero enabled members | Logged `Warn:`; run ends cleanly, no action |
| Total failure (AD module missing, group/domain resolution fails, bad inputs) | Terminating → routes to a **Failed** end state via `handlePSFailure` |

---

## 4. Dependencies

- **PowerShell host** (domain-joined Windows Server) with RSAT ActiveDirectory
  module, WinRM HTTPS listener (5986), and network reach to target servers'
  `C$` admin share and the archive file share.
- **Updated `cvs_functions.ps1`** deployed on the PS host (changes S-1…S-5).
- **AD group(s)** whose members are the servers to process (identified by DN).
- **Archive file share** writable by the PS host service account.
- **VCF Orchestrator 9** with the PowerShell plug-in and a registered PS host.
- **Certificate trust** between Orchestrator and the PS host (CA-signed or
  imported self-signed).

---

## 5. Assumptions

- The PS host service account is a local admin on target servers (or otherwise
  has admin-share read + file-share write).
- Servers requiring processing are AD-group members; the PS host itself is added
  to the group rather than handled as a local special case.
- The file filter (`Archive-*.evtx`) and age (`-1` day) match the current
  Ansible behavior unless overridden per run.
- Single-node Orchestrator in the lab; clustered deployments replicate host-side
  config on each node.

---

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| **Second-hop auth** (PS host → remote UNC) fails without delegation | Kerberos + constrained delegation (prod) or Basic-over-HTTPS (lab); validate the hop explicitly (Implementation Guide) |
| **Kerberos on containerized Orchestrator** not configured | Place `krb5.conf` at `/usr/lib/vco/app-server/conf/` in the `vco-app` pod (PVC-backed, persists); realm UPPERCASE |
| **Native-command false success** in host setup | `Configure-vROPSHost.ps1` now creates the listener via the WSMan provider and verifies it (change T-2) |
| **Script drift** | Verify S-1…S-5 present on the deployed script before use |
| **Accidental deletion** (cleanup workflow) | `whatIf` defaults to `yes` (report-only) |
| **Partial move on one server** | Per-server isolation; failures logged and reported, other servers unaffected |

---

## 7. Security considerations

- **Transport:** WinRM over **HTTPS (5986)** only. `AllowUnencrypted` must remain
  `false`; HTTP/5985 is not used for these workflows.
- **Authentication:**
  - *Kerberos* — preferred for production; no password transmitted; enables the
    second hop **only with constrained delegation** configured on the PS host's
    computer account.
  - *Basic over HTTPS* — acceptable in lab; password is TLS-encrypted in transit
    but presented to the PS host; disabled by default on WinRM. Passes
    credentials, so the second hop generally works without delegation. Do **not**
    use Basic over HTTP.
- **Credentials:** managed by the Orchestrator PS host configuration (service
  account); no secrets embedded in workflows or the script.
- **Least privilege:** service account scoped to the admin-share read and
  file-share write it requires; member of *Remote Management Users* on the PS host.
- **Certificate:** self-signed (default) must be imported to the Orchestrator
  trust store as Base-64/PEM (change T-1); prefer CA-issued in production.

---

## 8. Operational considerations

- **Execution model:** on-demand via custom form, or scheduled in Orchestrator.
- **Idempotency:** re-running is safe — already-moved files are simply absent on
  the next pass; the cleanup workflow's report-only default prevents accidental
  deletion.
- **Observability:** per-server progress and failures are in the workflow run
  log; `executionSuccess`/`executionOutput` summarize the result. Per-server
  structured reporting is deferred to Phase 2.
- **Maintenance:** monitor certificate expiry; re-verify `krb5.conf` presence
  after major Orchestrator upgrades (PVC-backed but reprovision-sensitive);
  keep the AD group membership current (add/remove servers there, not in code).
- **Change control:** all `cvs_functions.ps1` and tooling changes are tracked in
  `Change-Register.md` (S-# and T-#).
