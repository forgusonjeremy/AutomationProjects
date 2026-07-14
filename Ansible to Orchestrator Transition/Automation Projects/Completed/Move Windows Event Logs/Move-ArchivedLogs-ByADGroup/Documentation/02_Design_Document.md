# Move Archived Logs (By AD Group) — Design Document

**Deliverable:** Move-ArchivedLogs-ByADGroup
**Project:** Ansible → VCF Orchestrator transition — "Move Windows Event Logs"
**Platform:** VCF Automation 9 / VCF Operations Orchestrator 9
**Status:** Phase 1
**This set:** 01 Executive Summary · 02 Design Document · 03 Implementation Guide · 04 User Guide · 05 Validation & Testing Plan
**Shared references:** ../../_Shared/Documentation/Shared-Components.md · ../../_Shared/Documentation/Change-Register.md · ../../_Shared/Documentation/Ansible-to-vRO-MappingTable.md · "How to Build a PowerShell Host" (Automation Projects/_Shared References/PowerShell Host Build Guide/)

---

## 1. Architecture overview

The workflow builds one PowerShell invocation string, executes it on a pre-staged PS host via the OOTB *Invoke a PowerShell script* workflow, and parses the result. **All AD resolution and per-server iteration happen inside `cvs_functions.ps1`**, not in Orchestrator. **One workflow run = one script invocation; there is no Orchestrator-side loop.**

```
Operator (custom form)
      │
      ▼
Move-ArchivedLogs-ByADGroup workflow
      │
      ├─ buildMoveByADGroupInvocation (Action) ── invocation string
      │                                            │
      │        OOTB "Invoke a PowerShell script" (WinRM/HTTPS 5986)
      │                                            ▼
      │                                   PowerShell Host ── cvs_functions.ps1
      │                                            │   (Action: move-archived-logs-ByCN)
      │                                            │   Get-ListOfServers-ByCN (recursive, Enabled-only)
      │                     ┌──────────────────────┼───────────────────────┐
      │                     ▼                       ▼                       ▼
      │            AD (Get-ADGroupMember     \\server\C$ (source)   \\fileshare (destination)
      │             / Get-ADComputer)         winevt\Logs            <share>\<server-short-name>
      ▼
 parseScriptOutput (Action) ── success/outputText/errorText ── End state
```

- **Server targeting** is by AD group, resolved recursively to **enabled computer objects only**; disabled objects are skipped **and logged**; each object is resolved in its own `try/catch`.
- The script targets a specific DC via `-Server <domainName>`.

## 2. Components

| Component | Role | Shared? |
|---|---|---|
| **Workflow: Move-ArchivedLogs-ByADGroup** | Move `Archive-*.evtx` off enabled AD-group members to `<share>\<server-short-name>` | No — this deliverable |
| **Action: buildMoveByADGroupInvocation** | Build the `move-archived-logs-ByCN` invocation string; validate inputs (return type: string) | No — this deliverable |
| **Action: parseScriptOutput** | Parse the OOTB PSObject output → Properties `{success, outputText, errorText}` | Yes → Shared-Components.md |
| **Scriptable task: handlePSFailure** | Shared exception path for terminating PS/plugin failures | Yes → Shared-Components.md |
| **OOTB: Invoke a PowerShell script** | Executes the invocation string on the PS host | Yes → Shared-Components.md |
| **cvs_functions.ps1** | Shared PowerShell toolbox (AD resolution, move); changes S-1…S-5 | Yes → Change-Register.md |
| **PowerShell host** | Windows Server running `cvs_functions.ps1`; reaches targets via UNC | Yes → PS-Host guide |

- **Module namespace (action):** `broadcom.pso.vc.vm.guestOps.files.windows.logs`
- **Workflow folder:** `Production > Servers > Windows > Event Log Management` (lab/dev: `Workflows > Customer > <Customer Name> > Production > Servers > Windows > Event Log Management`)
- **No Configuration Element:** this workflow uses plain input parameters with defaults set directly on each input.

## 3. Data flow

1. `buildMoveByADGroupInvocation` validates inputs and returns:
   `& "<scriptPath>" -Action 'move-archived-logs-ByCN' -SecurityGroup_CN '<groupDN>' -DomainName '<domain>' -FileShareTarget '<share>' -FilterOn '<filter>' -NumberOfDays '<age>' *>&1 | Out-String -Width 4096`
   - `-SecurityGroup_CN` has an **underscore** (maps from `groupDN`).
   - `groupDN` should be a `distinguishedName` (preferred); CN / sAMAccountName / GUID / SID also resolve. A non-DN value (no `DC=`) logs a `System.warn` nudge but still runs.
   - The `*>&1 | Out-String -Width 4096` stream-capture is a shared requirement (see Shared-Components.md); without it the plugin returns a null object.
2. OOTB *Invoke a PowerShell script* runs the string on `psHost`; output → attribute `psRawOutput`.
3. In the script, `Get-ListOfServers-ByCN` resolves the group (recursive, enabled-only) to computers; each server's `Archive-*.evtx` files are moved via UNC to `<share>\<server-short-name>`.
4. `parseScriptOutput` receives `psOutput = psRawOutput` and `executionContext = groupDN + " @ " + domainName` (a **log label only** — it is not passed to the script), returning Properties `{success, outputText, errorText}`.
5. Decision `parsedResult.get("success") === true` → **End - Completed Successfully**; false → **End - Completed with Errors**.

**Outputs:** `executionSuccess` (boolean), `executionOutput` (string).

## 4. Failure-handling contract

| Condition | Behavior | End state |
|---|---|---|
| Disabled member | Skipped during resolution; logged `Info: skipping disabled computer …` | Not fatal |
| Enabled-but-unreachable member | `Move-files` terminating error (`-ErrorAction Stop`), logged `Error:` to stdout, **loop continues** | Completed with Errors |
| Zero enabled members | Logged `Warn:`; clean exit, no action | Completed Successfully |
| Bad inputs (validation) | `buildMoveByADGroupInvocation` throws | Failed: Bad Inputs |
| Total failure (AD module missing, group/domain unresolvable) | Script terminates; routes via `handlePSFailure` | Failed: PS Execution |

> **Operational note:** an AD account being **enabled is not the same as the host being reachable**. A computer whose AD account is still enabled will be processed and will error if offline. To exclude a host, `Disable-ADAccount` it or remove it from the group.

## 5. Dependencies

- **PS host** (domain-joined Windows Server) with **RSAT ActiveDirectory module** (`Get-ADGroupMember` / `Get-ADComputer`), WinRM HTTPS listener (5986), and network reach to targets' `C$` admin share and the archive share.
- **Updated `cvs_functions.ps1`** deployed (changes S-1…S-5 — Change-Register, shared).
- **AD group(s)** whose members are the servers to process (identified by DN).
- **Archive file share** writable by the PS host service account.
- **VCF Orchestrator 9** with the PowerShell plug-in and a registered PS host.
- **Certificate trust** between Orchestrator and the PS host.

## 6. Assumptions

- The PS host service account is local admin on target servers (or has admin-share read + file-share write).
- Servers requiring processing are AD-group members; the PS host itself is added to the group rather than handled as a local special case.
- The file filter (`Archive-*.evtx`) and age (`-1` day) match current Ansible behavior unless overridden per run.
- Single-node Orchestrator in the lab; clustered deployments replicate host-side config on each node.

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Second-hop auth fails without delegation | Kerberos + constrained delegation (prod) or Basic-over-HTTPS (lab); validate the hop explicitly |
| Enabled AD object for an offline host is still processed | Disable the account or remove from group; treat "enabled" as intent-to-process, not reachability |
| RSAT AD module absent | Verify `Get-Module -ListAvailable ActiveDirectory` before go-live |
| Script drift | Verify S-1…S-5 present on the deployed script before use |
| Partial move on one server | Per-server isolation; failures logged and reported, other servers unaffected |
| Kerberos / cert bring-up | Follow the PS-Host guide (krb5.conf format, salt/name-length, cert trust) |

## 8. Security considerations

- **Transport:** WinRM over **HTTPS (5986)** only; `AllowUnencrypted` stays `false`.
- **Authentication:** Kerberos (preferred, production) enables the second hop **only with constrained delegation**; Basic-over-HTTPS (lab) passes credentials so the hop generally works without delegation. Never use Basic over HTTP. Details in the PS-Host guide.
- **Credentials:** managed by the Orchestrator PS host configuration (service account); no secrets in the workflow or script.
- **Least privilege:** service account scoped to admin-share read + file-share write; member of *Remote Management Users* on the PS host.
- **Service account name/salt:** Kerberos requires `UPPERCASE_REALM + sAMAccountName ≥ 16 chars` (AES salt); defer detail to the PS-Host guide.

## 9. Operational considerations

- **Execution model:** on-demand via custom form, or scheduled in Orchestrator.
- **Idempotency:** re-running is safe — already-moved files are simply absent on the next pass.
- **Observability:** per-server progress and failures are in the workflow run log; `executionSuccess`/`executionOutput` summarize the result. Per-server structured reporting is deferred to Phase 2.
- **Maintenance:** monitor certificate expiry; keep AD group membership current (add/remove servers there, not in code); re-verify Kerberos config after major Orchestrator upgrades (PS-Host guide).
- **Change control:** all `cvs_functions.ps1` and tooling changes are tracked in the shared Change-Register (S-# and T-#).
