# Change Register — Server Reboot Automation

**Project:** Ansible → VCF Orchestrator transition — "Server Reboots"
**Platform:** VCF Automation 9 / VCF Operations Orchestrator 9
**Purpose of this document:** A single, customer-facing record of *how the server
reboot process works today* and *every change* made to it during the Orchestrator
transition — what changed, and **why**.

> **Continues the shared `S-` numbering.** `cvs_functions.ps1` is a shared toolbox.
> Changes S-1 … S-5 were made by the **Move Windows Event Logs** project and are
> recorded in that project's register
> (`Completed/Move Windows Event Logs/_Shared/Documentation/Change-Register.md`).
> This deliverable adds **S-6 … S-13** and process changes **P-9 … P-12**.
>
> **Script under change (working copy):** `InProgress/psscript/files/cvs_functions.ps1`
> **Promoted to (on completion):** `Completed/_Shared References/psscript/files/cvs_functions.ps1`
> **Current-state baseline:** `InProgress/Server Reboots/servers_reboot.yml` + `vars.txt`
>
> Only **two** working copies of the shared PowerShell exist: the In-Progress copy
> (edited while a project is in flight) and the Completed copy (what is migrated to
> the customer environment). The pre-transition originals under
> `Ansible Playbooks and Files - Sanitized/psscript/files/` are an **as-received
> source archive**, not a working copy, and are exempt from that rule.

---

## 1. Current state — how the customer does it today

**Goal of the automation (unchanged):** reboot the Windows servers in a security
group (`Security-Reboot-Servers`) that are reporting a **pending reboot**, one at a
time with a delay between each.

**How it runs today (Ansible):**
- `servers_reboot.yml` creates a temp dir on a Windows host over WinRM (5986),
  `win_copy`s the script folder, runs
  `cvs_functions.ps1 -Action Invoke-ServerReboot …`, then deletes the temp dir.
- The playbook is only a **delivery shell**. All real work happens in the script,
  on that one host, reaching every target over RPC/WMI/SMB.
- The script:
  1. `Get-ListOfServers` → `Get-ADGroupMember` (non-recursive, **unfiltered**).
  2. `Get-RebootStatus` → remote WMI/registry per server: CBS `RebootPending`,
     Windows Update `RebootRequired`, SCCM `DetermineIfRebootPending`, plus
     `crashonauditfail` and logged-on sessions.
  3. For servers where `PendingReboot -ne 'False'`: run `ownership_w2k.ps1`
     remotely, then `shutdown /r /t 2 /f /m \\server`, then sleep the delay.
- **Why it supports physical *and* virtual:** every step is OS-level. Nothing
  touches the hypervisor, so hardware and VMs are handled identically.

**Behaviours the transition preserves deliberately:**
- Only servers with a **pending reboot** are rebooted (not the whole group).
- Reboots are issued **sequentially with a delay** between each.
- Group membership is **non-recursive** — only direct members are targets.
- `RebootIt` remains the safety gate: only `simpleMode` actually reboots.

---

## 2. Changes to `cvs_functions.ps1`

> The package reuses the proven script as-is where possible. S-6, S-8, S-9 and
> S-12 are **defect fixes** found during the transition; S-7 tightens targeting;
> S-10 and S-11 are the **new capability** the customer asked for (verified reboots
> and reporting) — both of which the Move project explicitly deferred to Phase 2.
>
> **Three of these are pre-existing defects that affect the automation as it runs
> today, independently of this transition** — S-6 (the pre-reboot step has never
> executed), S-8 (servers that could not be interrogated were force-rebooted) and
> S-9 (failed reboots were reported as successes).

| # | Date | Function / Section | Change | Reason | Deployment impact |
|---|------|--------------------|--------|--------|-------------------|
| S-6 | 2026-07-17 | `Get-ScriptDirectory` | `$global:PSScriptRoot` → `$PSScriptRoot` | **Defect.** `$PSScriptRoot` is an *automatic* variable scoped to the running script; it is not published to the global scope, so `$global:PSScriptRoot` was always `$null` and this function returned an empty string. Every caller that builds a path from it produced a rooted path — `Invoke-ServerReboot` → `"/ownership_w2k.ps1"`, `tls-fix` → `"/$ActionRemoteFile"` — which `Invoke-Command -FilePath` could not find. The failure is non-terminating, so **the pre-reboot step was silently skipped and the server was rebooted anyway**. | Redeploy the script. `ownership_w2k.ps1` must now actually exist beside `cvs_functions.ps1` on the PS host — the step will now really run. Also fixes `tls-fix`. |
| S-7 | 2026-07-17 | New `Get-ListOfServers-Direct` | New resolver: `Get-ADGroupMember` **without** `-Recursive`, filtered to `objectClass -eq 'computer'` and `Enabled -eq $true`, with per-object `try/catch` and logged skips | `Invoke-ServerReboot` used `Get-ListOfServers`, which is non-recursive (correct) but applies **no filtering** — a user object, a disabled account, or a nested sub-group in the group would be passed to `Get-RebootStatus`. Rebooting is destructive, so targets must be explicit: only direct, enabled computer members. Implemented as a **new** function because `Get-ListOfServers` is also called by `Get-ServerPendingRebootStatus`, `clean-ServerDisk`, `move-archived-logs` and `tls-fix` and must not regress. | Redeploy the script. No caller impact — the new function is used only by `Invoke-ServerReboot`. |
| S-8 | 2026-07-17 | `Invoke-ServerReboot` switch case | Reboot target test changed from `!(PendingReboot -eq 'False')` to `PendingReboot -eq 'True'`; anything else is skipped and logged as an `Error:` | **Defect.** `Get-RebootStatus` returns `'Error Accessing Server'` when the remote WMI/registry call fails. The old negative test treated that as "pending", so a server we could **not interrogate** was force-rebooted (`shutdown /f`) regardless. A machine whose state cannot be read must never be rebooted blind. | Redeploy the script. **Behaviour change:** unreachable servers are no longer rebooted; they are reported and the run ends *Completed with Errors*. |
| S-9 | 2026-07-17 | `Invoke-ServerReboot` function | Capture `shutdown.exe` output and test `$LASTEXITCODE`; return `$true`/`$false`; reworded the `/c` broadcast message off "Ansible" | **Defect.** `shutdown.exe` is a native executable — on failure (access denied, RPC unavailable, host down) it raises **no** PowerShell exception, so the surrounding `try/catch` never fired and a failed reboot was indistinguishable from a successful one. The caller now records `RebootFailed`. | Redeploy the script. Failed reboots are now visible in the report and the transcript. |
| S-10 | 2026-07-17 | New `Wait-ServersBackOnline` + `-RebootIt_VerifyTimeoutSec` / `-RebootIt_VerifyPollSec` params | After **all** reboots are issued, one polling pass verifies each rebooted server returns by confirming its `LastBootUpTime` advanced past the pre-reboot value, within a per-server timeout (default 600s) | **New capability.** The script previously never verified a server came back — a machine that failed to boot was silently reported as a success. `LastBootUpTime` is stronger proof than a ping (it shows the OS actually restarted **and** is answering WMI again) and works identically for physical and virtual. A **single pass after** all reboots bounds the run to ≈ one boot window instead of *N × timeout*, which matters because the whole thing is one synchronous WinRM session. | Redeploy the script. New optional parameters (defaults preserve sensible behaviour). Run time now includes up to `VerifyTimeoutSec`. |
| S-11 | 2026-07-17 | New `GenerateReportServerReboot`; wired into the `Invoke-ServerReboot` case | Builds an HTML per-server report (ComputerName, PendingReboot, pre-reboot LastBootUpTime, RebootIssued, BackOnline, return time, Status, Detail), writes it to the Debug folder and mails it when `-eMailReport 'yes'` | **New capability.** The `Invoke-ServerReboot` action produced **no report and sent no mail** — the only record of a reboot run was the stdout transcript (`var_eMailReport` was set to `'no'` for exactly this reason). Modelled on the existing `GenerateReportServerPendingRebootStatus`. Also creates the Debug folder if absent rather than letting `Out-File` throw. | Redeploy the script. Operators now get a per-server reboot report by email. |
| S-13 | 2026-07-17 | New `-RebootIt_RunPreRebootScript` param; `Invoke-ServerReboot` switch case | The pre-reboot `ownership_w2k.ps1` step is now **opt-in and defaults to `'no'`** — it does not run unless explicitly enabled | **Consequence of fixing S-6.** `ownership_w2k.ps1` takes ownership of and loosens the ACLs on `c:\windows\inf\usbstor.inf` (USB mass-storage driver INF — a common hardening DENY target) and `c:\windows\system32\termsrv.dll` (Terminal Services). Because of S-6 the step has **never actually executed**, so simply fixing the path would have *silently started* applying those permission changes to every rebooted member of the `Security-Reboot-Servers` group. That is a **security-posture change**, not a restoration of working behaviour, and must be a deliberate reviewed decision rather than a side effect of a defect fix. | Redeploy the script. **Default behaviour is unchanged from today** (the step still does not run). Set `-RebootIt_RunPreRebootScript 'yes'` only after security review. |
| S-12 | 2026-07-17 | `Invoke-Module` function | (a) `Import-Module … -ErrorAction SilentlyContinue` → `-ErrorAction Stop`; (b) added the missing `return $true` on the successful-import path; (c) include the exception message in the error log | **Defect (two, compounding).** On the branch taken when the module is not already listed by `Get-Module -ListAvailable`: (a) `SilentlyContinue` suppressed the import failure so a genuinely missing module never reached the `Catch`, and (b) the success path had no `return`, so the function fell out of the `else` block returning `$null`. Every caller tests `if (Invoke-Module $strModule)`, so **both** outcomes — success and failure — were reported as "module unavailable". With S-8's terminating guard this would have turned a working host into a hard workflow failure. | Redeploy the script. **Shared-code change:** also affects `move-archived-logs-ByCN` and every other action that calls `Invoke-Module` — all are improved (a successful import is now correctly reported), but the already-delivered Event Log package should be re-tested. |

### S-10 detail — why verification is a batch pass, not per-server

*Rejected:* reboot server → block until it returns (or 600s) → next server.
With 20 pending servers that is up to **200 minutes** in a single synchronous
PowerShell invocation, which would exceed the WinRM/PSRP operation timeout and cut
the transcript off mid-run.

*Implemented:* issue all reboots sequentially with the delay (unchanged cadence),
then poll all rebooted servers in one pass, each against its **own** deadline
(`RebootIssuedAt + VerifyTimeoutSec`). Servers reboot concurrently in reality, so
total ≈ `(N × delay) + one boot window`. For 20 servers at 10s: ≈ 13 minutes.

A server that has not gone down yet simply reports its old `LastBootUpTime`, fails
the "advanced past" test, and stays in the pending set — so the check cannot produce
a false success by sampling too early.

---

## 3. Changes to the automation process (Ansible → Orchestrator)

| # | Date | Area | Current process (Ansible) | New process (Orchestrator) | Reason |
|---|------|------|---------------------------|----------------------------|--------|
| P-9 | 2026-07-17 | Execution engine | `servers_reboot.yml` stages the script to a Windows host with `win_copy` and runs it over WinRM | Orchestrator calls the **pre-staged** `cvs_functions.ps1` via the OOTB *Invoke a PowerShell script* over the PowerShell plug-in, from a single PS host | Same rationale as P-1: replace Ansible, reuse proven script logic, eliminate per-run staging |
| P-10 | 2026-07-17 | Server iteration & timing | Script iterates internally; Ansible only launches it | **Unchanged** — the script still owns AD resolution, iteration, the inter-server delay and verification. Orchestrator passes inputs and classifies the transcript; it owns no loop | Customer decision: keep all looping/timing in `cvs_functions.ps1`. Consistent with P-6 |
| P-11 | 2026-07-17 | Targeting | `-ADGroupMember` name, unfiltered non-recursive membership | Same parameter, but resolution is now direct + computer-only + enabled (S-7). Operator input named `groupDN` to steer toward the unambiguous DN form | Rebooting is destructive; targets must be explicit. Consistent with the Move package's `groupDN` naming |
| P-12 | 2026-07-17 | Reporting | No report, no mail (`var_eMailReport: 'no'`) | HTML per-server report emailed to a recipient **array** (S-11); run outcome also surfaced through the workflow end state | Closes the two Phase-2 items the Move project deferred ("per-server status reporting", "email reporting on workflow completion") |

**Net result:** 1 playbook → **1 workflow** (`Invoke-ServerReboot`); 1 new build
action; `parseScriptOutput` / `handlePSFailure` reused from the Event Log package.
The invoked script action (`Invoke-ServerReboot`) already existed; changes are
limited to S-6…S-11.

---

## 4. Current vs new — quick mapping

| Today (Ansible) | New (Orchestrator) |
|---|---|
| `servers_reboot.yml` + `vars.txt` | `Invoke-ServerReboot` workflow |
| `var_ADGroupMember` | `groupDN` input → `-ADGroupMember` |
| `var_DomainName` | `domainName` input → `-DomainName` |
| `var_RebootIt` (`simpleMode`) | `rebootMode` input → `-RebootIt` (default `no` = report only) |
| `var_RebootIt_DelayBetweenServer` | `delayBetweenServersSec` input |
| *(new)* | `verifyTimeoutSec` / `verifyPollSec` inputs (S-10) |
| `var_eMailReport` | `emailReport` input (boolean) |
| `var_SMTPServer` | `smtpServer` input |
| `var_MailToString` / `var_MailCcString` | `mailTo` / `mailCc` inputs (**arrays**, joined to CSV) |
| `var_MailSubjectstring` | `mailSubject` input |
| `var_HeaderNotesSubstr` | `headerNote` input |
| `var_OUPath` | *(dropped — not used by this action)* |
| `var_ps_folder` / `var_ps_script_file` / `var_parameter_action` / `var_cleanup_temporary_folder` | *(dropped — script is pre-staged, not copied per run)* |

---

## 5. Open items / risks

| Item | Status |
|---|---|
| **`ownership_w2k.ps1` — security review required** | **RESOLVED for now via S-13 (opt-in, default OFF).** Script supplied and staged. Its content is *not* benign: it `takeown`s and loosens ACLs on `usbstor.inf` (USB mass storage) and `termsrv.dll` (Terminal Services). Combined with S-6 — which proves the step has never run — enabling it would newly weaken two hardening controls on the security reboot group. **Recommend a security review before ever setting `RebootIt_RunPreRebootScript` to `'yes'`;** the `w2k` (Windows 2000) naming suggests it may simply be obsolete and safe to retire. |
| **Pre-reboot failure policy** | **DECIDED (2026-07-17): keep historic behaviour.** *If* the step is enabled and `ownership_w2k.ps1` fails, log an `Error:` and **still reboot** the server. Implemented. |
| **`Invoke-Module` defect** | **RESOLVED — see S-12** (applied 2026-07-17). |
| **Old `!(PendingReboot -eq 'False')` test elsewhere** | Still present in `Get-ServerRebootReportStatus-ByCN` and `Get-ServerPendingRebootStatus`. **Intentionally left as-is:** in those report-only actions the test merely increments a counter for the mail subject ("X of Y might require reboot") and never triggers a reboot. Changing it would alter those actions' reported figures. Only the reboot path (S-8) was corrected. |
| **`Get-RebootStatus` stale `$ComputerlastBootUptime`** | In its catch block the emitted object can carry the *previous* server's boot time. Harmless here (status-unknown servers are never rebooted or verified), but worth a future tidy. |
| **WinRM operation timeout** | One synchronous invocation now runs for `(N × delay) + up to VerifyTimeoutSec`. The PS host's WinRM `MaxTimeoutms` / plug-in timeout must exceed the worst case. Validate before first production run. |
| **Second hop (delegation)** | PS host → AD and PS host → each target over RPC/WMI/SMB. Same Kerberos constrained-delegation requirement as the Move package. See *How to Build a PowerShell Host* §6. |
| **Event Log package re-test** | S-12 changes `Invoke-Module`, which `move-archived-logs-ByCN` also calls. The already-delivered package benefits from the fix but should be re-tested before the updated script is deployed. |

---

## Revision history

| Date | Author | Summary |
|---|---|---|
| 2026-07-17 | Automation transition | Initial register for Server Reboots. Recorded script changes S-6 (`$PSScriptRoot` fix — pre-reboot step never ran), S-7 (new `Get-ListOfServers-Direct`: direct + computer-only + enabled), S-8 (never reboot a server whose pending state could not be read), S-9 (`shutdown.exe` exit-code capture), S-10 (batch post-reboot verification via `LastBootUpTime`), S-11 (per-server HTML report + mail). Recorded process changes P-9…P-12. Logged open items: missing `ownership_w2k.ps1`, pre-reboot failure policy, `Invoke-Module` latent defect. |
| 2026-07-17 | Automation transition | Added script change S-12 — `Invoke-Module` defect fix (`-ErrorAction Stop` so a failed import reaches the Catch; missing `return $true` on the successful-import path). Shared-code change: the Event Log package calls the same function and should be re-tested. Decided the pre-reboot failure policy: a failed `ownership_w2k.ps1` logs an `Error:` and the server is **still rebooted** (preserves historic behaviour). Recorded that the old `!(PendingReboot -eq 'False')` test is intentionally retained in the two report-only actions, where it only feeds a counter. |
| 2026-07-17 | Automation transition | **Canonical script location corrected.** S-6…S-12 were first applied to `Completed/_shared/cvs_functions.ps1`, which was removed during a repository reorganisation; the changes were reapplied and re-verified (parses clean, all changes present, reboot decision confirmed as `$pending -eq 'True'`). |
| 2026-07-17 | Automation transition | **Two-copy policy adopted.** Working edits are made in `InProgress/psscript/files/`; `Completed/_Shared References/psscript/files/` receives the promoted copy when a project completes and is what migrates to the customer environment. The `Ansible Playbooks and Files - Sanitized/psscript/files/` originals are retained as an as-received source archive (exempt). Server Reboots' working copy is the In-Progress one. |
| 2026-07-17 | Automation transition | Added script change S-13 after reviewing the supplied `ownership_w2k.ps1`: the pre-reboot step is now **opt-in, default OFF**. The script `takeown`s and loosens ACLs on `usbstor.inf` and `termsrv.dll`; since S-6 shows the step has never executed, fixing S-6 alone would have silently introduced a security-posture change on the `Security-Reboot-Servers` group. Default behaviour therefore remains identical to today. Security review recommended before enabling. |
