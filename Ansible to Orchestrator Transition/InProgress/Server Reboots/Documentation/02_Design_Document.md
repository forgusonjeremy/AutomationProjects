# Design Document — Server Reboot Automation

**Project:** Ansible → VCF Orchestrator transition — "Server Reboots"
**Platform:** VCF Automation 9 / VCF Operations Orchestrator 9
**Workflow:** `Reboot Servers in AD Group` (`Invoke-ServerReboot`), id `3d6396e9-376c-4be0-bd10-b66267189287`

---

## 1. Architecture

Orchestrator is a **thin pass-through**. It builds a PowerShell invocation string,
runs it on a Windows **PowerShell (PS) host** via the out-of-the-box (OOTB) *Invoke a
PowerShell script* library workflow, and classifies the returned transcript. All
Active Directory resolution, per-server iteration, the inter-server delay,
post-reboot verification, and report generation happen **inside `cvs_functions.ps1`**
on the PS host. Nothing touches vCenter, so physical and virtual servers are handled
identically.

```
Operator / Scheduler
        │  (inputs)
        ▼
[Workflow: Reboot Servers in AD Group]  (VCF Orchestrator)
   buildServerRebootInvocation ──► invocation string
        │
        ▼  OOTB "Invoke a PowerShell script"  (PowerShell plug-in, WinRM/HTTPS/Kerberos)
[PowerShell Host]  ── runs ──►  cvs_functions.ps1 -Action Invoke-ServerReboot
        │                         • resolve AD group (direct, enabled computers)
        │                         • Get-RebootStatus per server (WMI/registry/SCCM)
        │                         • reboot pending servers (shutdown /r /f), delay between
        │                         • verify each returns (LastBootUpTime advances)
        │                         • build HTML report + email
        ▼
   parseScriptOutput ──► { success, outputText, errorText }
        │
        ▼
   Script Succeeded?  ──► Log Success (Completed Successfully)
                     └─► Log Failures (Completed with Errors)
```

### Second hop (delegation)
The PS host reaches Active Directory and each target server over RPC/WMI/SMB using
the plug-in's Kerberos identity. This requires Kerberos constrained delegation on the
PS host (see the cross-project *How to Build a PowerShell Host* reference). This is
the same requirement as the Move Windows Event Logs package.

---

## 2. Components

| Component | Type | Role |
|---|---|---|
| `Reboot Servers in AD Group` | Workflow | Orchestrates the steps below; owns no loop or timing |
| `buildServerRebootInvocation` | Action (`com.broadcom.pso.vcf.vm.guestOps.windows.reboot`) | Builds the PowerShell invocation string; validates inputs; derives the report-header group name from the group DN |
| OOTB *Invoke a PowerShell script* | Library workflow | Runs the invocation on the PS host; returns a `PowerShellRemotePSObject` |
| `parseScriptOutput` | Action (`com.broadcom.pso.vcf.vm.guestOps.files.windows.logs`) | Parses the transcript into `{ success, outputText, errorText }` |
| `cvs_functions.ps1` | PowerShell toolbox | The reused script; `-Action Invoke-ServerReboot` does all the work |
| `ownership_w2k.ps1` | PowerShell script | Optional, security-sensitive pre-reboot step (off by default) |
| PS host | Windows Server + plug-in | Executes the script; reaches AD and targets |

---

## 3. Workflow schema (as built)

Elements and flow, from the exported definition:

| # | Element | Type | Next |
|---|---|---|---|
| item1 | **buildServerRebootInvocation** | action task | item2 |
| item2 | **Invoke a PowerShell script** | linked OOTB workflow | item4 (normal); **catch → item9** |
| item4 | **Create Execution Context** (`groupDN + "@" + domainName`) | scriptable task | item3 |
| item3 | **parseScriptOutput** | action task | item6 |
| item6 | **Script Succeeded?** (`return parsedResult.success`) | custom decision | item7 (true) / item8 (false) |
| item7 | **Log Success** → sets `executionSuccess=true`, `executionOutput=outputText` | scriptable task | item0 (end) |
| item8 | **Log Failures** → sets `executionSuccess=false`, `executionOutput=errorText` | scriptable task | item5 (end) |
| item9 | **Throw Error** (`throw err_0`) — terminating-failure path | scriptable task | item10 (end) |
| item10 | **End workflow** | end | — |

**Exception path:** the *Invoke a PowerShell script* element (item2) captures a
terminating plug-in error into the `err_0` attribute (`catch-name: item9`,
`throw-bind-name: err_0`). item9 re-throws it, so a hard PS failure (PS host
unreachable, or a terminating error inside the script such as the AD module missing)
ends the workflow in a **Failed** state rather than silently continuing. The normal
transcript-classification path (parse → decision → Log Success/Log Failures) is
unaffected.

**Attributes:** `host` (PowerShell:PowerShellHost — the target PS host),
`psRawOutput` (PowerShellRemotePSObject), `invocationScript` (string, produced by the
build action), `executionContext` (string), `parsedResult` (Properties),
`executionSuccess` (boolean), `executionOutput` (string), `err_0` (string — captured
terminating error).

**Key binding:** the build action's return value (`actionResult`) is bound OUT to the
`invocationScript` attribute, which is bound IN to the OOTB element's `script` input.
(An unbound `invocationScript` yields an empty command and a "Cannot bind argument to
parameter 'Command'" failure — verify this binding after any edit.)

---

## 4. Inputs

| Input | Type | Default | Maps to script parameter |
|---|---|---|---|
| `scriptPath` | string | `C:\PSO\Scripts\cvs_functions.ps1` | (script path) |
| `groupDN` | string | — | `-ADGroupMember` |
| `domainName` | string | `vcf.lab` | `-DomainName` |
| `rebootMode` | string (dropdown: Reboot=`simpleMode` / Report-Only=`no`) | — | `-RebootIt` |
| `delayBetweenServersSec` | number | 10 | `-RebootIt_DelayBetweenServer` |
| `verifyTimeoutSec` | number | 600 | `-RebootIt_VerifyTimeoutSec` |
| `verifyPollSec` | number | 30 | `-RebootIt_VerifyPollSec` |
| `runPreRebootScript` | boolean (label "Enable USB Mass Storage and make termsrv.dll writeable?") | false | `-RebootIt_RunPreRebootScript` |
| `emailReport` | boolean | (unset) | `-eMailReport` (`yes`/`no`) |
| `smtpServer` | string | — | `-SMTPServer` |
| `mailTo` | Array/string | — | `-MailToString` (joined with `,`) |
| `mailCc` | Array/string | — | `-MailCcString` (joined with `,`) |
| `mailSubject` | string | — | `-MailSubjectstring` |

`-HeaderNotesSubstr` (the report-header group label) is **not an input** — it is
derived from `groupDN` inside the build action, so the header can never name a
different group than the one targeted.

---

## 5. Reboot eligibility — what makes a system get rebooted

This is the core operational contract. On any run, a given server is rebooted only
when **both gates** below are satisfied.

### Gate 1 — the run is in reboot mode
`rebootMode = simpleMode` (`-RebootIt simpleMode`). Any other value (e.g. `no`) is a
**report-only** run: eligibility is evaluated and reported, but nothing is rebooted.
**Scheduled production runs always set `simpleMode`.**

### Gate 2 — the server is eligible AND pending

A server must first be **eligible** (in scope):

- It is a **direct member** of the target AD group — membership is **non-recursive**,
  so servers in nested sub-groups are **not** included.
- Its AD object is a **computer** — user or group objects in the group are ignored.
- Its AD account is **enabled** — disabled/decommissioned accounts are skipped and
  logged.

An eligible server is then rebooted only if it reports a **pending reboot**.
`Get-RebootStatus` sets `PendingReboot = True` when **any one** of these is present
(read remotely over WMI/registry):

| Source | Exact signal | Typical cause |
|---|---|---|
| **Component Based Servicing (CBS)** | a subkey named `RebootPending` under `…\CurrentVersion\Component Based Servicing\` | feature enable/disable (DISM), component install/removal, servicing-stack or some cumulative updates |
| **Windows Update** | a subkey named `RebootRequired` under `…\CurrentVersion\WindowsUpdate\Auto Update\` | Windows Update installed patches needing a reboot |
| **SCCM / ConfigMgr** | `CCM_ClientUtilities.DetermineIfRebootPending().RebootPending -eq $true` (only if the ConfigMgr client namespace exists) | software updates / apps deployed by ConfigMgr |

### What is NOT rebooted (safety behaviour)

- **No pending reboot** → skipped, reported "no reboot required".
- **Pending state unreadable** (WMI/RPC failure → `Error Accessing Server`) → **skipped
  and reported as an error; never rebooted.** A machine that cannot be interrogated is
  never rebooted blind.
- **Disabled / non-computer / nested-group members** → excluded during resolution.

### Detection scope limitation
Detection covers CBS, Windows Update, and SCCM. It does **not** check
`PendingFileRenameOperations` (Session Manager) or a pending computer-rename. A server
pending a reboot *only* for those reasons reports `False` and is not rebooted. This is
inherited from the original script and is appropriate for the patch/update use case;
extending it would be a separate, scoped change.

---

## 6. Reboot execution and verification

For each eligible, pending server, in `simpleMode`:

1. **(Optional) pre-reboot step** — if `runPreRebootScript = true`, run
   `ownership_w2k.ps1` on the server first (see §8). Off by default. A failure here is
   logged and the reboot still proceeds.
2. **Reboot** — `shutdown /r /t 2 /f /m \\server` (forced restart after 2 seconds).
   The command's exit code is checked; a rejected reboot is recorded as `RebootFailed`.
3. **Delay** — wait `delayBetweenServersSec` (default 10), then the next server.
4. **Verification pass (once, after all reboots are issued)** — each rebooted server is
   polled until its `LastBootUpTime` advances past the value captured before the
   reboot, within `verifyTimeoutSec` (default 600s), polling every `verifyPollSec`
   (default 30s). A server that returns is `Rebooted`; one that does not is
   `NotReturned` (a failure).

Verification is a **single batch pass** rather than a per-server blocking wait, so
total run time is approximately `(pending servers × delay) + one boot window` instead
of `servers × timeout`. This keeps the single synchronous PowerShell session within
the WinRM operation timeout.

### Per-server statuses in the report
`Rebooted`, `NotReturned`, `RebootFailed`, `Skipped-NoRebootRequired`,
`Skipped-StatusUnknown`, `Skipped-ReportOnly`.

---

## 7. Reporting and end states

- The script builds an **HTML per-server report** (computer, pending state,
  pre-reboot boot time, whether a reboot was issued, whether it came back, return
  time, status, detail) and emails it when `emailReport = true`. The report is built
  regardless; email is the delivery option.
- Orchestrator classifies the run via `parseScriptOutput`, which scans the transcript
  for `Error:` lines:
  - **no `Error:` lines → Completed Successfully** (`executionSuccess = true`).
  - **any `Error:` line → Completed with Errors** (`executionSuccess = false`). This
    is a *soft* failure: other servers still processed; the report was still produced.
    Per-server problems (unreachable status, failed reboot, no-return) land here.
- **Terminating failure → Failed.** A hard plug-in/script failure (PS host
  unreachable, or a terminating error such as the AD module missing) is caught by
  item2 and re-thrown by item9, ending the run in a **Failed** state. This is distinct
  from the *soft* "Completed with Errors" above.

---

## 8. Security considerations

- **`ownership_w2k.ps1` (pre-reboot step).** Takes ownership of and loosens ACLs on
  `usbstor.inf` (reverses documented USB-storage hardening) and `termsrv.dll`
  (precursor to concurrent-RDP patching, which violates the Windows EULA). It is
  **disabled by default** (`runPreRebootScript = false`) and must not be enabled
  without security review. It has historically never executed (a defect the transition
  fixed), so enabling it is a new posture change, not a restoration.
- **Never hard-boots.** The only power action is an OS-level graceful-then-forced
  `shutdown /r /f`; there is no hypervisor reset.
- **Credentials.** The PS host plug-in service account is the identity used for AD and
  target access; no per-server credentials are handled by Orchestrator.
- **Blast radius is the AD group.** Group membership is the control surface for what
  the scheduled job can reboot.

---

## 9. Assumptions, dependencies, and known limitations

### Dependencies
- A configured PS host reachable by Orchestrator (WinRM/HTTPS/Kerberos), with the
  ActiveDirectory module (RSAT) available, and Kerberos constrained delegation for the
  second hop.
- `cvs_functions.ps1` (with changes S-6…S-13) staged at `scriptPath`; `ownership_w2k.ps1`
  staged beside it **only if** the pre-reboot step will be used.
- The **logs module** providing `parseScriptOutput` (reused from the Event Log
  package). This package therefore depends on that module being present.

### Known limitations / recommended hardening
1. **Build-action input errors are not caught.** The *Invoke a PowerShell script*
   element now catches terminating plug-in/script failures (item2 → item9 → Failed),
   but `buildServerRebootInvocation` (item1) has no exception path. A validation
   `throw` in the build action (e.g. a required input missing, or `verifyPollSec` >
   `verifyTimeoutSec`) will still fault the workflow rather than route to a clean *Bad
   Inputs* end state. **Recommendation (optional):** add a *Bad Inputs* end state on
   item1's exception path.
2. **Terminating failures re-throw rather than reporting.** item9 (`throw err_0`) ends
   the run *Failed* — correct and visible — but does not populate `executionSuccess` /
   `executionOutput` the way a Move-style `handlePSFailure` handler would. This is a
   valid design choice (a hard failure *should* fail the workflow); noted only if you
   later want failed runs to still carry a structured output message.
3. **Detection scope** (CBS/WU/SCCM only) — see §5.

> Resolved during build (previously flagged): the `parseScriptOutput` module-name
> typo (`braodcom` → `broadcom`) is corrected, and terminating-error handling is now
> wired via item2's catch path (item9 → item10).

### Changes to `cvs_functions.ps1`
Documented in full in the Change Register (S-6…S-13), reproduced here as **Appendix
A**. Summary: fixed the script-dir defect that stopped the pre-reboot step from ever
running (S-6); added a direct, enabled, computer-only resolver (S-7); reboot only
servers with a readable `True` pending state (S-8); detect failed `shutdown` calls
(S-9); batch post-reboot verification (S-10); per-server HTML report + email (S-11); a
shared `Invoke-Module` fix (S-12); and the opt-in pre-reboot gate (S-13). Change S-12
touches shared code and the Event Log package should be re-tested before deployment.

---

## Appendix A — Change Register

> Reproduced from `Documentation/Change-Register.md`, the standalone, **authoritative**
> copy of the change history — the customer-facing record of every change to the
> existing automation and why. This appendix is a convenience copy; if the two ever
> diverge, the standalone Change Register is the source of truth.

### A.0 Overview

**Purpose:** A single, customer-facing record of *how the server reboot process works
today* and *every change* made to it during the Orchestrator transition — what
changed, and **why**.

- Continues the shared `S-` numbering. Changes **S-1 … S-5** were made by the **Move
  Windows Event Logs** project (recorded in that project's register). This deliverable
  adds **S-6 … S-13** and process changes **P-9 … P-13**.
- **Script under change (working copy):** `InProgress/psscript/files/cvs_functions.ps1`
- **Promoted to (on completion):** `Completed/_Shared References/psscript/files/cvs_functions.ps1`
- Only **two** working copies of the shared PowerShell exist (In-Progress and
  Completed); the `Ansible Playbooks and Files - Sanitized/…` originals are an
  as-received source archive, exempt from that rule.

### A.1 Current state — how the customer does it today

**Goal (unchanged):** reboot the Windows servers in a security group
(`Security-Reboot-Servers`) that are reporting a **pending reboot**, one at a time with
a delay between each.

**How it runs today (Ansible):** `servers_reboot.yml` stages the script to a Windows
host over WinRM, runs `cvs_functions.ps1 -Action Invoke-ServerReboot …`, then cleans
up. The playbook is only a delivery shell; all work happens in the script, on that one
host, reaching every target over RPC/WMI/SMB. The script resolves the group
(non-recursive, unfiltered), checks each server's pending-reboot state (CBS / Windows
Update / SCCM), and for pending servers runs `ownership_w2k.ps1` then
`shutdown /r /t 2 /f /m \\server` with a delay between each. Every step is OS-level, so
physical and virtual servers are handled identically.

**Behaviours preserved deliberately:** only pending servers are rebooted; sequential
with a delay; non-recursive membership; `RebootIt` remains the safety gate (only
`simpleMode` reboots).

### A.2 Changes to `cvs_functions.ps1`

> S-6, S-8, S-9 and S-12 are **defect fixes** found during the transition; S-7 tightens
> targeting; S-10 and S-11 are the **new capability** the customer asked for. Three are
> pre-existing defects that affect the automation as it runs today — S-6 (pre-reboot
> step never executed), S-8 (uninterrogable servers were force-rebooted) and S-9
> (failed reboots reported as successes).

| # | Function / Section | Change | Reason | Deployment impact |
|---|--------------------|--------|--------|-------------------|
| S-6 | `Get-ScriptDirectory` | `$global:PSScriptRoot` → `$PSScriptRoot` | **Defect.** `$global:PSScriptRoot` was always `$null`, so the function returned an empty string and every path built from it was rooted (`"/ownership_w2k.ps1"`). `Invoke-Command` failed non-terminating, so the pre-reboot step was silently skipped and the server rebooted anyway. Also affects `tls-fix`. | Redeploy. `ownership_w2k.ps1` will now actually run if enabled (see S-13). |
| S-7 | New `Get-ListOfServers-Direct` | Non-recursive `Get-ADGroupMember`, filtered to enabled computer objects, with per-object isolation and logged skips | `Invoke-ServerReboot` used `Get-ListOfServers`, which is unfiltered — a user, disabled account, or nested group would flow into `Get-RebootStatus`. New function so the shared `Get-ListOfServers` (4 other callers) does not regress. | Redeploy. No caller impact — used only by `Invoke-ServerReboot`. |
| S-8 | `Invoke-ServerReboot` case | Reboot test `!(PendingReboot -eq 'False')` → `PendingReboot -eq 'True'`; anything else skipped and logged `Error:` | **Defect.** The old test also matched `'Error Accessing Server'`, so a server that could not be interrogated was force-rebooted. Never reboot a machine whose state cannot be read. | Redeploy. **Behaviour change:** unreachable servers are no longer rebooted; run ends *Completed with Errors*. |
| S-9 | `Invoke-ServerReboot` function | Capture `shutdown.exe` output, test `$LASTEXITCODE`, return `$true`/`$false`; reworded broadcast message | **Defect.** `shutdown.exe` raises no PowerShell exception on failure, so the `try/catch` never fired and a failed reboot looked successful. Caller now records `RebootFailed`. | Redeploy. Failed reboots now visible. |
| S-10 | New `Wait-ServersBackOnline` + `-RebootIt_VerifyTimeoutSec` / `-RebootIt_VerifyPollSec` | Single post-reboot pass verifies each server's `LastBootUpTime` advanced within the timeout (default 600s) | **New capability.** The script never verified a server returned. Batch pass bounds run time to ≈ one boot window instead of *N × timeout*. | Redeploy. New optional params; run time now includes up to `VerifyTimeoutSec`. |
| S-11 | New `GenerateReportServerReboot` | Per-server HTML report (status, timing, reason), written to Debug and mailed when `-eMailReport 'yes'`; creates the Debug folder if absent | **New capability.** The reboot action produced no report or mail. Modelled on `GenerateReportServerPendingRebootStatus`. | Redeploy. Operators now get an emailed report. |
| S-12 | `Invoke-Module` | `-ErrorAction SilentlyContinue` → `Stop`; add missing `return $true`; log the exception message | **Defect (two, compounding).** On the not-yet-loaded branch the import failure was swallowed **and** the success path returned `$null`, so callers saw a working module as "unavailable". | Redeploy. **Shared-code change** — also used by `move-archived-logs-ByCN`; re-test the Event Log package. |
| S-13 | New `-RebootIt_RunPreRebootScript`; `Invoke-ServerReboot` case | Pre-reboot `ownership_w2k.ps1` step is **opt-in, default `'no'`** | **Consequence of fixing S-6.** The script `takeown`s / loosens ACLs on `usbstor.inf` (USB storage hardening) and `termsrv.dll` (Terminal Services). Since S-6 shows it never ran, fixing the path alone would silently begin applying those changes — a security-posture change, so it must be a deliberate opt-in. | Redeploy. **Default behaviour unchanged** (step does not run). Enable only after security review. |

**S-10 detail — why verification is a batch pass:** a per-server blocking wait (reboot →
wait ≤600s → next) would run up to ~200 minutes for 20 servers in one synchronous
WinRM session and exceed the operation timeout. Instead, all reboots are issued
sequentially with the delay, then all rebooted servers are polled in one pass, each
against its own `RebootIssuedAt + VerifyTimeoutSec` deadline. A server not yet down
reports its old `LastBootUpTime`, fails the "advanced past" test, and stays pending —
so early sampling cannot produce a false success.

### A.3 Changes to the automation process (Ansible → Orchestrator)

| # | Area | Current (Ansible) | New (Orchestrator) | Reason |
|---|------|-------------------|--------------------|--------|
| P-9 | Execution engine | Stage script + run over WinRM | Call the pre-staged script via the OOTB *Invoke a PowerShell script* from one PS host | Replace Ansible, reuse script logic, drop per-run staging |
| P-10 | Iteration & timing | Script iterates internally | **Unchanged** — script owns resolution, iteration, delay, verification; Orchestrator passes inputs and classifies the transcript | Keep looping/timing in the script |
| P-11 | Targeting | Unfiltered non-recursive membership | Direct + computer-only + enabled (S-7); input named `groupDN` | Rebooting is destructive; targets must be explicit |
| P-12 | Reporting | No report/mail | HTML per-server report emailed to a recipient array (S-11); outcome via end state | Closes the two Phase-2 items the Move project deferred |
| P-13 | Report header label | `var_HeaderNotesSubstr` as its own variable | Dropped as an input — derived from `groupDN` in the build action | Removes a redundant input; header can't name a different group than targeted |

**Net result:** 1 playbook → 1 workflow (`Invoke-ServerReboot`); 1 new build action;
`parseScriptOutput` reused from the Event Log package. Script changes limited to
S-6…S-13.

### A.4 Current vs new — quick mapping

| Today (Ansible) | New (Orchestrator) |
|---|---|
| `servers_reboot.yml` + `vars.txt` | `Invoke-ServerReboot` workflow |
| `var_ADGroupMember` | `groupDN` → `-ADGroupMember` |
| `var_DomainName` | `domainName` → `-DomainName` |
| `var_RebootIt` (`simpleMode`) | `rebootMode` → `-RebootIt` (default `no` = report only) |
| `var_RebootIt_DelayBetweenServer` | `delayBetweenServersSec` |
| *(new)* | `verifyTimeoutSec` / `verifyPollSec` (S-10) |
| `var_eMailReport` | `emailReport` (boolean) |
| `var_SMTPServer` | `smtpServer` |
| `var_MailToString` / `var_MailCcString` | `mailTo` / `mailCc` (arrays, joined to CSV) |
| `var_MailSubjectstring` | `mailSubject` |
| `var_HeaderNotesSubstr` | *(no input — derived from `groupDN`; see P-13)* |
| `var_OUPath` | *(dropped — not used by this action)* |
| `var_ps_folder` / `var_ps_script_file` / `var_parameter_action` / `var_cleanup_temporary_folder` | *(dropped — script is pre-staged)* |

### A.5 Open items / risks

| Item | Status |
|---|---|
| `ownership_w2k.ps1` — security review | **Handled via S-13 (opt-in, default OFF).** It `takeown`s/loosens ACLs on `usbstor.inf` and `termsrv.dll`; enabling it weakens two hardening controls. Recommend security review before ever setting `RebootIt_RunPreRebootScript='yes'`; the `w2k` naming suggests it may be obsolete and safe to retire. |
| Pre-reboot failure policy | **DECIDED: keep historic behaviour** — if enabled and the step fails, log `Error:` and still reboot. |
| `Invoke-Module` defect | **RESOLVED — S-12.** |
| Old `!(PendingReboot -eq 'False')` test elsewhere | Intentionally retained in `Get-ServerRebootReportStatus-ByCN` and `Get-ServerPendingRebootStatus` — report-only actions where it only feeds a mail-subject counter and never reboots. |
| `Get-RebootStatus` stale `$ComputerlastBootUptime` | Its catch block can emit the previous server's boot time. Harmless (status-unknown servers are never rebooted/verified); future tidy. |
| WinRM operation timeout | The synchronous run lasts `(N × delay) + up to VerifyTimeoutSec`; the PS host's WinRM/plug-in timeout must exceed the worst case. |
| Second hop (delegation) | PS host → AD and → each target; requires Kerberos constrained delegation (see *How to Build a PowerShell Host* §6). |
| Event Log package re-test | S-12 changes shared `Invoke-Module`; re-test the delivered Event Log package before deploying the updated script. |

### A.6 Revision history

| Date | Summary |
|---|---|
| 2026-07-17 | Initial register: S-6…S-11, P-9…P-12; open items logged. |
| 2026-07-17 | S-12 (`Invoke-Module` fix); pre-reboot failure policy decided; noted the retained report-only test. |
| 2026-07-17 | Canonical script location corrected after a folder reorganisation; changes reapplied and re-verified. |
| 2026-07-17 | Two-copy script policy adopted (In-Progress working / Completed shipped; sanitized archive exempt). |
| 2026-07-17 | S-13 (opt-in pre-reboot gate) added after reviewing `ownership_w2k.ps1`. |
| 2026-07-20 | P-13 (header note derived from `groupDN`). Register reproduced as Design Document Appendix A. |
