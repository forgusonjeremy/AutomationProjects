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
> This deliverable adds **S-6 … S-15** and process changes **P-9 … P-18**.
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
| S-8 | 2026-07-17 | `Invoke-ServerReboot` switch case | Reboot target test changed from `!(PendingReboot -eq 'False')` to `PendingReboot -eq 'True'`; anything else is skipped and logged as an `Error:` | **Defect.** `Get-RebootStatus` returns `'Error Accessing Server'` when the remote WMI/registry call fails. The old negative test treated that as "pending", so a server we could **not interrogate** was force-rebooted (`shutdown /f`) regardless. A machine whose state cannot be read must never be rebooted blind. | Redeploy the script. **Behaviour change:** unreachable servers are no longer rebooted; they are reported, the run completes, and `executionSuccess` comes back false. |
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
| P-12 | 2026-07-17 | Reporting | No report, no mail (`var_eMailReport: 'no'`) | HTML per-server report emailed to a recipient **array** (S-11); run outcome also surfaced through the `executionSuccess` / `executionOutput` workflow outputs | Closes the two Phase-2 items the Move project deferred ("per-server status reporting", "email reporting on workflow completion") |
| P-13 | 2026-07-17 | Report header label | `var_HeaderNotesSubstr` supplied as its own variable | **Dropped as an input.** The script's `-HeaderNotesSubstr` is only a display label ("the security group called X") in the report header, so `buildServerRebootInvocation` now **derives** it from `groupDN` (leftmost CN of a DN, or the identifier as-is). No script change — the parameter is still passed, just computed | Removes a redundant input and makes it impossible for the header to name a different group than the one actually targeted |

### 2a. S-14 — the pre-reboot step moves inside the script

| # | Date | Function / Section | Change | Reason | Deployment impact |
|---|------|--------------------|--------|--------|-------------------|
| S-14 | 2026-09-14 | New `$PreRebootStep` script block in `Invoke-ServerReboot.ps1`; `-PreRebootScriptPath` parameter **removed** | `ownership_w2k.ps1` is no longer a separate file staged on the PowerShell host and reached by path. Its contents are carried into `Invoke-ServerReboot.ps1` as a script block and sent to each target with `Invoke-Command -ScriptBlock`. The commands themselves are unchanged — this is a port, not a rewrite. Each `takeown` / `icacls` call now has its **exit code checked** and its failure returned to the caller and logged. | **Consequence of P-14.** Nothing is pre-staged under the current design, so a path parameter would have rebuilt the exact shape of defect **S-6**: a path resolving to nothing, a non-terminating failure, and the server rebooted as though the step had run. Embedding removes that failure mode — the step cannot be missing. Separately, `takeown` and `icacls` are **native executables**: they raise no PowerShell exception on failure, so the original's `try/catch` never fired and *every* failure was invisible. Same defect class as S-9. Verified by running the block unelevated: all five commands failed and all five were reported, where the original would have reported nothing. | Redeploy the script. **`-PreRebootScriptPath` no longer exists** — remove it from any caller. `ownership_w2k.ps1` no longer needs to exist on the PS host at all. Default behaviour is unchanged: the step still does not run unless `-RunPreRebootScript 'yes'`. The S-13 decision stands — a failure is logged as an ERROR and the server is **still rebooted**. |

### 2b. S-15 — run-time defects found on the first live run

> Found on the first successful end-to-end reboot (2026-09-23). Both are in code
> added by this transition, not inherited from `cvs_functions.ps1`.

| # | Date | Function / Section | Change | Reason | Deployment impact |
|---|------|--------------------|--------|--------|-------------------|
| S-15a | 2026-09-23 | `Invoke-ServerReboot.ps1` — Phase 1 reboot loop | The inter-server delay is no longer applied after the **last** server. Loop converted from `foreach` to indexed so the final iteration skips `Start-Sleep`. | **Defect.** The delay is *between* servers, so there is nothing to space out after the last one — but the loop slept anyway, adding a full `DelayBetweenServersSec` of dead time to every run before verification even began. On the first live run (2 servers, 600s delay) this was **10 minutes of a 21-minute run**. Cost scales with the delay, not the server count, so it is worst exactly where the delay was set high for safety. | Redeploy the script. Run time drops by one delay interval. No behaviour change to the reboots themselves. |
| S-15b | 2026-09-23 | `Wait-ServersBackOnline` | `DurationSec` is now measured from `RebootIssuedAt` to the server's own `LastBootUpTime`, not to the moment the verification pass happened to poll it. | **Reporting defect.** Verification is a single batch pass that starts only after every reboot is issued (S-10), so a server rebooted early has been up for the whole remaining delay before anything looks at it. Timing to `Get-Date` therefore reported the *wait*, not the *reboot*: on the first live run a server that came back in **14 seconds** was logged and reported as `back online after 1200s`, purely for being first in the queue. `LastBootUpTime` is what the machine itself reports, so it reads the same however late the poll arrives. | Redeploy the script. The "Return time (s)" column in the HTML report and the transcript now show real return times; previously-issued reports overstate them. |

**Also corrected:** the worst-case run-time estimate logged by *Create Script
Parameters* used `N × delay`; it now uses `(N-1) × delay`, matching S-15a.

### 2c. P-18 — script size drives startup time; deploy a stripped build

**Measured on VCF Automation 9.1.1 against `pshost.vcf.lab`.** `runPowerShellScript`
does not copy a file to the host — it **embeds the whole script text inside the
command it sends over WinRM**. Startup is therefore linear in script size:

| Payload | Time before the script's first line runs |
|---|---|
| ~0 (OOTB *Invoke a PowerShell script*) | 6s |
| 11,290 chars (`Move-ArchivedLogs.ps1`) | 25s |
| 20,195 chars (`Invoke-ServerReboot.ps1`, stripped) | 38s |
| 39,261 chars (`Invoke-ServerReboot.ps1`, as written) | 73s |

≈ **5s fixed + 1.7s per KB**, confirmed across four points. The cost is paid once
per run and does **not** scale with server count — a 50-server reboot pays the same
73 seconds as a 2-server one.

This is a property of the **shared** `runPowerShellScript` action, so it applies to
every package in this family. The Move package has been paying ~19s of it since it
was delivered.

**Resolution.** Roughly half of these scripts is comments, deliberately so — the
*why* behind several behaviours (S-6, S-8, S-9, S-14) is not recoverable from the
code. Those comments are worth keeping in the repository and worth nothing on the
wire. `Completed/_Shared References/Tools/Build-ResourceElement.ps1` produces the
deployable copy:

- strips comments using PowerShell's **tokenizer** against comment token extents,
  not regular expressions, so a `#` inside a string or here-string is safe;
- **proves equivalence** — re-tokenizes the output and compares every non-comment,
  non-newline token by kind and text against the source, failing the build and
  writing nothing on any difference (2,059 tokens compared for
  `Invoke-ServerReboot.ps1`, 677 for `Move-ArchivedLogs.ps1`);
- re-checks the two things `runPowerShellScript` requires: no bare `'@` line, and
  a `PSO_RESULT` emission;
- stamps a DO-NOT-EDIT header naming the source.

`Invoke-ServerReboot.ps1` 39,261 → 20,813 chars (47% smaller, ~73s → ~38s
measured). `Move-ArchivedLogs.ps1` 11,290 → 6,527 (42%, ~25s → ~16s predicted).

**Process change:** import the `.deploy.ps1` as the Resource Element, keeping the
element NAME as the original (`Invoke-ServerReboot.ps1`) — `runPowerShellScript`
uses the element name as the filename on the host, and the transcript is easier to
read that way. **Re-run the build after every source change**, or a stale copy is
deployed and a fix appears not to take effect.

---

### 3a. Alignment with the Move Windows Event Logs delivery pattern (P-14 … P-17)

> **These four supersede P-9, P-10 and P-13.** The first cut of this package kept
> the Ansible shape — a pre-staged `cvs_functions.ps1` invoked by a hand-built
> command line. It has been re-based onto the pattern already delivered and proven
> by **Move Windows Event Logs**, so that the two packages are built, installed and
> supported the same way rather than each having its own idea of how a script
> reaches a Windows host.
>
> **The targeting rule is unchanged.** S-7 stands in full: direct members only,
> computer objects only, enabled only. It moved from `Get-ListOfServers-Direct` in
> the shared PowerShell to `getGroupComputersDirect` in Orchestrator. Nothing about
> *which servers get rebooted* changed — only *who works the list out*.

| # | Date | Area | Previous (P-9 … P-13) | New | Reason |
|---|------|------|------------------------|-----|--------|
| P-14 | 2026-09-14 | Script storage | `cvs_functions.ps1` **pre-staged** on the PS host; workflow took a `scriptPath` input and invoked `-Action Invoke-ServerReboot` | Purpose-built **`Invoke-ServerReboot.ps1`** held in Orchestrator as a **Resource Element**, copied to the host at run time, run, and deleted | Matches the Move package. No staged copy can drift out of date with the version Orchestrator holds, and the run record shows exactly which script ran. The 3,356-line shared toolbox is no longer a runtime dependency of this workflow, so a change made for another action cannot alter a reboot run |
| P-15 | 2026-09-14 | Execution | OOTB *Invoke a PowerShell script* driven by a hand-built invocation string from `buildServerRebootInvocation` | Shared **`runPowerShellScript`** action; parameters passed as a `Properties` bag | One component knows about the PowerShell plug-in, so plug-in behaviour changes in one file. Removes hand-rolled PowerShell quoting — the old action escaped single quotes itself, which is a defect waiting to happen in a DN or a mail subject. Also inherits the `invokeScript()`-over-`openSession()` fix, which is what makes second-hop access to each target work |
| P-16 | 2026-09-14 | AD resolution | **Unchanged from Ansible (P-10)** — the script resolved the group itself via `Get-ADGroupMember` | New **`getGroupComputersDirect`** action; Orchestrator resolves the group and passes `-ComputerNames`. The script no longer talks to AD at all | Reverses the P-10 decision to keep resolution in the script. The target list is now in the run record *before* anything is rebooted, rather than only visible in the transcript afterwards; the `ActiveDirectory` module is no longer required on the PS host; and S-12's `Invoke-Module` defect stops being on this workflow's critical path. Deliberately **non-recursive**, unlike the Move package's `getGroupComputers` — see the note below |
| P-17 | 2026-09-14 | Result contract | `parseScriptOutput` scanned the transcript for `Error:` text | The script writes one **`PSO_RESULT={json}`** line; `runPowerShellScript` parses it | A reworded log line could previously change the workflow's end state. Counts are now reported by the script rather than inferred, which is what lets the workflow distinguish *skipped*, *reboot rejected* and *did not return* — three outcomes with three different owners that the transcript scan collapsed into one |

**`getGroupComputersDirect` is NOT `getGroupComputers`.** The Move package's action
is recursive by design; this one is deliberately not, and the two must not be
merged. Moving a log file off a machine that should not have been in scope wastes
a little time — rebooting one takes a production service down. A sub-group nested
in the reboot group is reported in a warning naming it, so the omission is visible
on the run that made it rather than discovered months later.

**Net result:** 1 playbook → **1 workflow** (`Invoke Server Reboot`). Five actions
shared with the Move package (`runPowerShellScript`, `selectPowerShellHost`,
`resolveAdGroup`, `findAdHostForDn`, `probeAdPlugin` — create each **once**), one
new action of its own (`getGroupComputersDirect`), two scriptable tasks, and one
Resource Element. `buildServerRebootInvocation` is **retired** — it existed only to
build the pre-staged command line. `parseScriptOutput` / `handlePSFailure` are no
longer used by this workflow.

**Script changes S-6 … S-13 are all carried forward** into
`Invoke-ServerReboot.ps1`, with S-7 relocated to Orchestrator as described above.
`cvs_functions.ps1` keeps them too: its other actions still need them, and it
remains the working copy for every automation that has not yet been transitioned.

---

## 4. Current vs new — quick mapping

| Today (Ansible) | New (Orchestrator) |
|---|---|
| `servers_reboot.yml` + `vars.txt` | `Invoke Server Reboot` workflow |
| `var_ADGroupMember` | `adGroup` (picked from a tree) or `adGroupDn` (scheduled/API runs) → resolved by the AD plug-in → `-ComputerNames` |
| `var_DomainName` | *(dropped as an input — the domain is read from the group's own DN, so the two can never disagree; see P-16)* |
| `var_RebootIt` (`simpleMode`) | `rebootMode` input → `-RebootMode` (default `no` = report only) |
| `var_RebootIt_DelayBetweenServer` | `delayBetweenServersSec` input |
| *(new)* | `verifyTimeoutSec` / `verifyPollSec` inputs (S-10) |
| *(new)* | `runPreRebootScript` / `preRebootScriptPath` inputs (S-13, default OFF) |
| `var_eMailReport` | `emailReport` input (boolean) |
| `var_SMTPServer` | `smtpServer` input |
| `var_MailToString` / `var_MailCcString` | `mailTo` / `mailCc` inputs (**arrays**, joined to CSV) |
| `var_MailSubjectstring` | `mailSubject` input |
| `var_HeaderNotesSubstr` | *(no input — taken from the resolved group object; see P-13, P-16)* |
| `var_OUPath` | *(dropped — not used by this action)* |
| `var_ps_folder` / `var_ps_script_file` / `var_parameter_action` | *(dropped — the script is a Resource Element, selected by binding, not by path)* |
| `var_cleanup_temporary_folder` | *(dropped — `runPowerShellScript` always deletes the script after the run)* |
| *(was `scriptPath` in the first cut)* | *(dropped — nothing is pre-staged; see P-14)* |

---

## 5. Open items / risks

| Item | Status |
|---|---|
| **Pre-reboot step — security review required** | **RESOLVED for now via S-13 (opt-in, default OFF) and S-14 (embedded in the script).** Its content is *not* benign: it `takeown`s and loosens ACLs on `usbstor.inf` (USB mass storage) and `termsrv.dll` (Terminal Services). Combined with S-6 — which proves the step has never run — enabling it would newly weaken two hardening controls on the security reboot group. **Recommend a security review before ever setting `-RunPreRebootScript` to `'yes'`;** the `w2k` (Windows 2000) naming of the original suggests it may simply be obsolete and safe to retire. Since S-14 there is no `ownership_w2k.ps1` file to stage or maintain — the step is the `$PreRebootStep` block inside `Invoke-ServerReboot.ps1`, so a review reads one place. |
| **Pre-reboot failure policy** | **DECIDED (2026-07-17): keep historic behaviour.** *If* the step is enabled and `ownership_w2k.ps1` fails, log an `Error:` and **still reboot** the server. Implemented. |
| **`Invoke-Module` defect** | **RESOLVED — see S-12** (applied 2026-07-17). |
| **Old `!(PendingReboot -eq 'False')` test elsewhere** | Still present in `Get-ServerRebootReportStatus-ByCN` and `Get-ServerPendingRebootStatus`. **Intentionally left as-is:** in those report-only actions the test merely increments a counter for the mail subject ("X of Y might require reboot") and never triggers a reboot. Changing it would alter those actions' reported figures. Only the reboot path (S-8) was corrected. |
| **`Get-RebootStatus` stale `$ComputerlastBootUptime`** | In its catch block the emitted object can carry the *previous* server's boot time. Harmless here (status-unknown servers are never rebooted or verified), but worth a future tidy. |
| **WinRM operation timeout** | One synchronous invocation now runs for `(N × delay) + up to VerifyTimeoutSec`. The PS host's WinRM `MaxTimeoutms` / plug-in timeout must exceed the worst case. Validate before first production run. |
| **Second hop (delegation)** | PS host → AD and PS host → each target over RPC/WMI/SMB. Same Kerberos constrained-delegation requirement as the Move package. See *How to Build a PowerShell Host* §6. |
| **Event Log package re-test** | S-12 changes `Invoke-Module`, which `move-archived-logs-ByCN` also calls. The already-delivered package benefits from the fix but should be re-tested before the updated script is deployed. **Reduced in scope by P-16:** this workflow no longer calls `Invoke-Module` at all, so the risk is now confined to the Event Log package itself. |
| **PS host certificate must be SHA-256 (VCF Automation 9.1.1)** | **RESOLVED 2026-09-22 — root cause of a full outage.** After the 9.1 → 9.1.1 upgrade, *every* PowerShell workflow in both this package and the Move Windows Event Logs package failed with `document out [EMPTY]` on the WS-Man Shell Create. Cause: `Configure-vROPSHost.ps1` pinned the legacy `Microsoft RSA SChannel Cryptographic Provider` CSP and did not pass `-HashAlgorithm`, producing a **SHA-1 signed** certificate. 9.1.1 runs the Orchestrator JVM with BouncyCastle in FIPS approved-only mode (`FIPS_MODE: strict`) and refuses SHA-1, so the TLS handshake failed — while the SSL Trust Manager still reported the certificate as *trusted*, because trust and algorithm policy are separate checks. Nothing in the vRO error named TLS or the certificate. Fixed in the shared script (`-HashAlgorithm SHA256` + CNG KSP, with a post-generation check that refuses to continue if the result is still weak) and documented in *How to Build a PowerShell Host* §3. **Re-verify on any host built before 2026-09-22:** `curl -vk https://<host>:5986/wsman 2>&1 \| grep 'signed using'`. |
| **Remaining documentation still describes the pre-staged design** | **OPEN.** `01_Executive_Summary`, `02_Design_Document`, `03_Implementation_Guide` and `04_User_Guide` (and their `.docx` builds) were written against P-9/P-10/P-13 and still refer to a `scriptPath` input, `buildServerRebootInvocation` and `parseScriptOutput`. The code and this register are current; those four are not. They need rewriting against the canvas in `Code/workflow_Invoke-ServerReboot.js` before the package is handed over. |
| **Shared actions — do not create twice** | **ACTION ON BUILD.** `runPowerShellScript`, `selectPowerShellHost`, `resolveAdGroup`, `findAdHostForDn` and `probeAdPlugin` are shared with the Move / Remove Archived Logs packages and are delivered inside this one so it can stand alone. If either of those is already installed, these actions exist — create each **once** and let all three workflows call it. A second copy under a different name drifts silently from the first. |
| **`Invoke-ServerReboot.ps1` not yet run against real servers** | **OPEN.** The script has been verified end to end for parsing, input validation, report generation, the `PSO_RESULT` contract and the S-8 skip path (using unreachable hosts). The paths that need real infrastructure — a genuine pending-reboot detection, `shutdown.exe` acceptance, and `LastBootUpTime` verification — have not been exercised. Run report-only against a real group first, then a single-server live run, before any group-wide run. |

---

## Revision history

| Date | Author | Summary |
|---|---|---|
| 2026-07-17 | Automation transition | Initial register for Server Reboots. Recorded script changes S-6 (`$PSScriptRoot` fix — pre-reboot step never ran), S-7 (new `Get-ListOfServers-Direct`: direct + computer-only + enabled), S-8 (never reboot a server whose pending state could not be read), S-9 (`shutdown.exe` exit-code capture), S-10 (batch post-reboot verification via `LastBootUpTime`), S-11 (per-server HTML report + mail). Recorded process changes P-9…P-12. Logged open items: missing `ownership_w2k.ps1`, pre-reboot failure policy, `Invoke-Module` latent defect. |
| 2026-07-17 | Automation transition | Added script change S-12 — `Invoke-Module` defect fix (`-ErrorAction Stop` so a failed import reaches the Catch; missing `return $true` on the successful-import path). Shared-code change: the Event Log package calls the same function and should be re-tested. Decided the pre-reboot failure policy: a failed `ownership_w2k.ps1` logs an `Error:` and the server is **still rebooted** (preserves historic behaviour). Recorded that the old `!(PendingReboot -eq 'False')` test is intentionally retained in the two report-only actions, where it only feeds a counter. |
| 2026-07-17 | Automation transition | **Canonical script location corrected.** S-6…S-12 were first applied to `Completed/_shared/cvs_functions.ps1`, which was removed during a repository reorganisation; the changes were reapplied and re-verified (parses clean, all changes present, reboot decision confirmed as `$pending -eq 'True'`). |
| 2026-07-17 | Automation transition | **Two-copy policy adopted.** Working edits are made in `InProgress/psscript/files/`; `Completed/_Shared References/psscript/files/` receives the promoted copy when a project completes and is what migrates to the customer environment. The `Ansible Playbooks and Files - Sanitized/psscript/files/` originals are retained as an as-received source archive (exempt). Server Reboots' working copy is the In-Progress one. |
| 2026-07-17 | Automation transition | Added script change S-13 after reviewing the supplied `ownership_w2k.ps1`: the pre-reboot step is now **opt-in, default OFF**. The script `takeown`s and loosens ACLs on `usbstor.inf` and `termsrv.dll`; since S-6 shows the step has never executed, fixing S-6 alone would have silently introduced a security-posture change on the `Security-Reboot-Servers` group. Default behaviour therefore remains identical to today. Security review recommended before enabling. |
| 2026-07-20 | Automation transition | Added process change P-13: the report-header label (`-HeaderNotesSubstr`) is no longer an input — `buildServerRebootInvocation` derives it from `groupDN` (a vRO-layer change; no script change). Corrected the header note "P-9 … P-12" → "P-9 … P-13". This register is reproduced as Appendix A of the Design Document (the standalone file remains authoritative). |
| 2026-09-14 | Automation transition | **Re-based onto the Move Windows Event Logs delivery pattern.** Added process changes P-14 … P-17, which **supersede P-9, P-10 and P-13**: the workflow now runs a purpose-built `Invoke-ServerReboot.ps1` held in Orchestrator as a Resource Element (copied to the host per run, then deleted) via the shared `runPowerShellScript` action, resolves the AD group with the new `getGroupComputersDirect` action instead of in the script, and reads its outcome from a single `PSO_RESULT` line instead of scanning the transcript. **Targeting is unchanged** — S-7's direct / computer-only / enabled-only rule moved from `Get-ListOfServers-Direct` to `getGroupComputersDirect`, and nested sub-groups are still never expanded (now reported in a warning naming each one). S-6 … S-13 are all carried forward into the new script. `buildServerRebootInvocation` retired; `parseScriptOutput` / `handlePSFailure` no longer used here. `domainName` dropped as an input — the domain is read from the group's own DN. Corrected the header note "P-9 … P-13" → "P-9 … P-17". Logged three new open items: the four remaining documents still describe the superseded design, the five shared actions must be created only once, and the new script has not yet been run against real servers. |
| 2026-09-14 | Automation transition | **Code layout only — no behaviour change.** `Code/` now holds one `.js` per Orchestrator *action* plus one `.js` per *workflow*, matching how the objects actually exist in Orchestrator. `workflow_Invoke-ServerReboot.js` became the single build sheet for the canvas — the seven elements in order with every IN/OUT binding, the inputs and their presentation, the attributes, the outputs, the exception routing, and the four scriptable tasks inline ready to paste. `Invoke-ServerReboot_spec.js` was folded into it and removed (two files describing one schema would have drifted); `task_CreateScriptParameters.js` and `task_ParseResult.js` were inlined and removed, as a scriptable task is not a separate Orchestrator object. Also documented the AD-host-vs-PowerShell-host distinction that the two `Select`/`Find` elements are easily confused over, and made `Select PowerShell Host` an explicit element of its own (element 4 of 7) rather than something assumed. |
| 2026-09-14 | Automation transition | Added script change **S-14**: the pre-reboot step (`ownership_w2k.ps1`) moved INSIDE `Invoke-ServerReboot.ps1` as the `$PreRebootStep` script block, and `-PreRebootScriptPath` was removed. Nothing is pre-staged under P-14, so a path parameter would have rebuilt the exact shape of defect S-6 — a path resolving to nothing, a silent non-terminating failure, and the server rebooted as though the step had run. Each `takeown`/`icacls` call now has its exit code checked, which the original never did (native executables raise no PowerShell exception — the S-9 defect class); verified by running the block unelevated, where all five commands failed and all five were reported. Default behaviour unchanged: the step still does not run unless `-RunPreRebootScript 'yes'`, and a failure still logs an ERROR and reboots anyway. |
| 2026-09-22 | Automation transition | **Shared-component defect fixed: PS host certificate was SHA-1.** Following the VCF Automation 9.1 → 9.1.1 upgrade, every PowerShell workflow in **both** this package and the already-delivered Move Windows Event Logs package failed identically with `document out [EMPTY]` on the WS-Man Shell Create. Root cause: `Configure-vROPSHost.ps1` pinned the legacy SChannel CSP and omitted `-HashAlgorithm`, yielding a SHA-1 signed listener certificate. 9.1.1 runs the Orchestrator JVM under BouncyCastle FIPS approved-only mode and refuses SHA-1, failing the TLS handshake — with no error naming TLS or the certificate, and with the SSL Trust Manager simultaneously reporting the certificate as trusted. `Configure-vROPSHost.ps1` now uses `-HashAlgorithm SHA256` (configurable to SHA384/SHA512) with the CNG KSP, adds a Server Authentication EKU and explicit subject, **verifies the generated certificate is not weakly signed and aborts if it is**, refuses a SHA-1 cert in `ExistingCA` mode, warns when SANs omit the FQDN, and reports what the listener is actually bound to. Per operator decision it generates a **new certificate on every run** — so each run must be followed by re-importing the cert and re-running *Update a PowerShell host*; superseded certificates are reported, not deleted. Also fixed a `Set-StrictMode` defect in the new code (`.Count` on an unrolled empty array). Guide §3 updated. `Test-PSHostWinRM.ps1` (new diagnostic, `InProgress/Server Reboots/Code/`) flags a weak listener certificate. |
| 2026-09-14 | Automation transition | **Workflow schema simplified — no behaviour change.** The Decision element and the two end-state scriptable tasks (`End - Success` / `End - Errors`) were removed. `Parse Results` now does all the reporting, including the run's closing line, and connects straight to a single `End`. The canvas is seven elements plus three failure end states hung off exception bindings. Per-server problems no longer land on a separate "Completed with Errors" end state — the run completes and the `executionSuccess` output (false when the script reported any error) is what a caller branches on. Rationale: the whole account of a run stays in one place and one order, rather than split across two branches where half is only reached on one of them. `rebootMode` added to `Parse Results`' IN tab for the closing line. |
