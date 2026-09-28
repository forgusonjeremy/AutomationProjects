# Design Document — Server Reboot Automation

**Project:** Ansible → VCF Orchestrator transition — "Server Reboots"
**Platform:** VCF Automation 9.1.1 / VCF Operations Orchestrator 9
**Workflow:** `Reboot Servers in AD Group`, id `ca28572d-4aec-487b-97ea-ce19d2d871c2`
**Script:** `Invoke-ServerReboot.ps1` (held in Orchestrator as a Resource Element)
**Source of this document:** the deployed workflow definition
`Code/rebootServersWorkflow.yml` and the code in `Code/`.

---

## 1. Architecture

Orchestrator works out *which* servers to process; a purpose-built PowerShell script
works out *what to do* with them.

- **Orchestrator** resolves the Active Directory group through the **AD plug-in**
  (no PowerShell and no typed credentials involved), validates the request, and
  hands the script an explicit list of server names.
- **`Invoke-ServerReboot.ps1`**, stored in Orchestrator as a Resource Element, is
  copied to the **PowerShell (PS) host** for each run, executed, and deleted. It
  checks each server's pending-reboot state, reboots the pending ones one at a time,
  verifies each came back, and builds the per-server report.
- The script reports its outcome in **one machine-readable line**
  (`PSO_RESULT={json}`), which Orchestrator turns into workflow outputs.

Nothing touches vCenter, so physical and virtual servers are handled identically.

```
Operator / Schedule / API
        │  adGroupDn, rebootMode, email settings
        ▼
[Workflow: Reboot Servers in AD Group]  (VCF Orchestrator)
   1. findAdHostForDn          DN's DC= parts ──► AD endpoint             (AD plug-in)
   2. resolveAdGroup           DN ──► AD:UserGroup on that endpoint       (AD plug-in)
   3. Get Computers in AD      direct, enabled computer members ──► FQDN list
      Group – Non-Recursive
   4. Create Script Parameters validate request ──► Properties bag
   5. runPowerShellScript      copy + run + delete Invoke-ServerReboot.ps1 on the PS host
        │                         (PowerShell plug-in, WinRM/HTTPS/Kerberos)
        ▼
   [PS host] Invoke-ServerReboot.ps1 -ComputerNames … -RebootMode …
        │    • pending-reboot check per server (remote WMI/registry, SCCM)
        │    • reboot pending servers: shutdown /r /f, delay BETWEEN servers
        │    • one verification pass: LastBootUpTime must advance
        │    • per-server outcome to the log; HTML report emailed if asked
        │    • PSO_RESULT={counts, errors}
        ▼
   6. Parse Results            PSO_RESULT ──► workflow outputs + closing log line
        ▼
     [End]
```

### Second hop (delegation)
The PS host reaches each target server over RPC/WMI/SMB (and WinRM, if the
pre-reboot step is enabled) using the plug-in's Kerberos identity. This requires
Kerberos constrained delegation on the PS host — the same requirement as the Move
Windows Event Logs package (see the cross-project *How to Build a PowerShell Host*
§6). `runPowerShellScript` deliberately uses the host's own shared session
(`psHost.invokeScript()`), which is the session the delegated credential lives in.

The PS host does **not** talk to Active Directory. AD resolution happens entirely in
the Orchestrator AD plug-in, so the ActiveDirectory (RSAT) module is not required on
the PS host.

---

## 2. Components

| Component | Type | Module / location | Role |
|---|---|---|---|
| `Reboot Servers in AD Group` | Workflow | — | Six elements in a straight line (§3) |
| `findAdHostForDn` | Action (shared) | `com.broadcom.pso.vcf.activedirectory` | Picks the registered AD endpoint from the DN's `DC=` parts |
| `resolveAdGroup` | Action (shared) | `com.broadcom.pso.vcf.activedirectory` | Looks the group up **on that endpoint**, matching on the full DN |
| `getADComputersGroupNonRecursive` | Action | `com.broadcom.pso.vcf.activedirectory` | Direct, enabled computer members only; warns about nested groups. Source: `Code/getGroupComputersDirect.js` |
| `runPowerShellScript` | Action (shared by all PowerShell-based workflows) | `com.broadcom.pso.vcfa.vm.guestScripting` | Copies the Resource Element to the host, runs it with the parameters, deletes it, parses `PSO_RESULT`. Source: `_Shared References/psscript/files/runPowerShellScript.js` |
| `Invoke-ServerReboot.ps1` | Resource Element | Orchestrator | The reboot script. Content is the comment-stripped build `Invoke-ServerReboot.deploy.ps1`; element **name** must be `Invoke-ServerReboot.ps1` |
| `probeAdPlugin` | Action (shared, diagnostic) | — | Read-only report of AD endpoints, membership properties, PS hosts. Not called by the workflow |
| `Test-PSHostWinRM.ps1` | Diagnostic script | `Code/` | Run on the PS host when the plug-in cannot open a shell (`document out [EMPTY]`) |
| PS host | Windows Server + PowerShell plug-in | — | Executes the script; reaches the targets |

"Shared" actions are also used by other packages: the AD actions by the Move Archived
Logs / Remove Old Archived Logs packages, and `runPowerShellScript` by every
PowerShell-based Orchestrator workflow. Create each **once** per Orchestrator.

The PS host is fixed by the workflow's `psHost` attribute; there is no host selection
at run time.

---

## 3. Workflow schema

| # | Canvas name | Item | Type | IN | OUT | Next |
|---|---|---|---|---|---|---|
| 1 | **findAdHostForDn** | item2 (root) | action | `distinguishedName` ← input `adGroupDn` | → attr `adHost` | 2 |
| 2 | **resolveAdGroup** | item1 | action | `adGroupDn` ← input `adGroupDn`; `adHost` ← attr `adHost` | → attr `adGroup` | 3 |
| 3 | **Get Computers in AD Group - Non-Recursive Search** | item3 | action `getADComputersGroupNonRecursive` | `adGroup` ← attr `adGroup` | → attr `computerNames` | 4 |
| 4 | **Create Script Parameters** | item4 | scriptable task | `computerNames`, `adGroup`, `rebootMode`, `delayBetweenServersSec`, `verifyTimeoutSec`, `verifyPollSec`, `runPreRebootScript`, `emailReport`, `smtpServer`, `mailTo`, `mailCc`, `mailSubject` | → attr `scriptParameters` | 5 |
| 5 | **runPowerShellScript** | item6 | action | `psHost` ← attr `psHost`; `script` ← attr `script`; `parameters` ← attr `scriptParameters` | → attr `scriptRunResult` | 6 |
| 6 | **Parse Results** | item5 | scriptable task | `scriptRunResult`, `adGroup`, `rebootMode` | → the six workflow outputs | End |
| — | End | item0 | end | — | — | — |

**There are no exception bindings and no decision element.** An error thrown by any
element ends the run in Orchestrator's standard **Failed** state with that error's
message. Everything that reaches element 6 ends normally; whether the script hit
per-server problems is carried by the `executionSuccess` output (§7).

### Attributes

| Name | Type | Set by | Value (lab) |
|---|---|---|---|
| `adHost` | AD:AdHost | element 1 | — |
| `adGroup` | AD:UserGroup | element 2 | — |
| `computerNames` | Array/string | element 3 | — |
| `scriptParameters` | Properties | element 4 | — |
| `psHost` | PowerShell:PowerShellHost | **fixed at build** | host id `0c675c7a-137b-40c3-af36-6f36223dfa59` |
| `script` | ResourceElement | **fixed at build** | element id `1d91559a-f672-4a42-8ce3-297a9e59206b` (`Invoke-ServerReboot.ps1`) |
| `scriptRunResult` | Properties | element 5 | — |
| `delayBetweenServersSec` | number | **fixed at build** | `10` |
| `verifyTimeoutSec` | number | **fixed at build** | `600` |
| `verifyPollSec` | number | **fixed at build** | `30` |

The last three are attributes, not inputs: operators and schedules cannot change the
reboot cadence per run. To change them, edit the attribute values on the workflow.
The four "fixed at build" attributes must be re-pointed after import into any other
Orchestrator (Implementation Guide §4).

### Outputs

| Output | Type | Meaning |
|---|---|---|
| `executionSuccess` | boolean | `true` when the script logged **no** `ERROR` lines |
| `executionOutput` | string | One-line summary, e.g. `2 of 2 pending server(s) rebooted and verified, across 5 server(s) checked.` |
| `serversChecked` | number | Servers interrogated |
| `serversPending` | number | Servers that reported a pending reboot |
| `serversRebooted` | number | Rebooted **and** verified back online |
| `transcript` | string | Everything the script printed |

---

## 4. Inputs

| Input | Type | Form control / label | Default | Required on form | Maps to script parameter |
|---|---|---|---|---|---|
| `adGroupDn` | string | text, "adGroupDn" | — | No* | (resolved to `-ComputerNames`, `-HeaderNote`) |
| `rebootMode` | string | dropdown "Reboot or Report Only": **Reboot** = `reboot`, **Report Only** = `report-only` | — | No* | `-RebootMode` |
| `runPreRebootScript` | boolean | checkbox "Run Allow USB and Make TermSrv.dll Editable Script?" | `false` | No | `-RunPreRebootScript` (`yes`/`no`) |
| `emailReport` | boolean | checkbox | — (unset = no) | No | `-EmailReport` (`yes`/`no`) |
| `mailTo` | Array/string | array | — | when emailing | `-MailToString` (joined with `,`) |
| `mailCc` | Array/string | array | — | No | `-MailCcString` (joined with `,`) |
| `mailSubject` | string | text | — | No | `-MailSubject` |
| `smtpServer` | string | text | — | when emailing | `-SMTPServer` |

\* Not marked required on the form, but the run fails without them: an empty
`adGroupDn` fails element 1, and an empty `rebootMode` fails element 4.

**Not inputs:**

- **Domain.** There is no domain field. The domain is read from the `DC=` parts of
  `adGroupDn`, so the endpoint and the group cannot disagree.
- **Report header label** (`-HeaderNote`). Taken from the name of the group that was
  actually resolved, so the report can never name a different group than the one
  targeted.
- **Script path.** Nothing is pre-staged; the script is the `script` attribute.
- **Delay / verify timings.** Attributes — see §3.

---

## 5. Targeting — which servers are checked

Element 3 builds the target list from the group's **direct** membership:

- **Direct members only.** Nested sub-groups are **not** expanded. Each nested group
  is named in a warning on the run ("Their members were NOT included and will NOT be
  rebooted"), so the omission is visible where it happens.
- **Computer objects only.** Users, contacts and anything else are ignored.
- **Enabled accounts only.** Disabled computer accounts (the `disabled` property, or
  bit 2 of `userAccountControl`) are skipped and listed in the log.
- **FQDNs from each computer's own DN**, not the group's — a group in one domain can
  hold computers from another. Duplicates are removed.

If the plug-in does not report the group's membership at all, element 3 fails the
run rather than treating the group as empty. If the group has **no** enabled direct
computer members, element 4 fails the run ("no servers were resolved") — so picking
the wrong group can never look like a clean run with nothing to do.

This action is deliberately **not** the recursive `getGroupComputers` used by the Move
Archived Logs package. The two must not be merged: moving a log off an out-of-scope
machine costs a little time; rebooting one takes a service down.

---

## 6. Reboot eligibility — what makes a system get rebooted

A server on the target list is rebooted only when **both gates** are satisfied.

### Gate 1 — the run is in reboot mode
`rebootMode = reboot` (form: **Reboot**). The script tests
`$RebootMode -eq 'reboot'`; **any other value**, including `report-only`, a blank or a
typo, is a **report-only** run: pending state is detected and reported, nothing is
rebooted. The gate fails safe. Scheduled production runs must pass exactly `reboot`
(lower case).

### Gate 2 — the server reports a pending reboot
`Get-RebootStatus` reads each server remotely and sets `PendingReboot = True` when
**any one** of these is present:

| Source | Exact signal | Typical cause |
|---|---|---|
| **Component Based Servicing (CBS)** | subkey `RebootPending` under `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\` | DISM feature changes, component install/removal, servicing-stack or some cumulative updates |
| **Windows Update** | subkey `RebootRequired` under `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\` | Windows Update installed patches needing a reboot |
| **SCCM / ConfigMgr** | `CCM_ClientUtilities.DetermineIfRebootPending().RebootPending -eq $true` (only when the `ROOT\CCM\ClientSDK` namespace exists) | Updates/apps deployed by ConfigMgr |

The check also records the server's `LastBootUpTime`, who is logged on (`query user`)
and whether `crashonauditfail` is set.

### What is NOT rebooted (safety behaviour)

- **No pending reboot** → `Skipped-NoRebootRequired`.
- **Pending state unreadable** (WMI/RPC failure) → `Skipped-StatusUnknown`, logged as
  an `ERROR`, **never rebooted**. Only an explicit `True` is a reboot target (S-8).
- **Report-only run** → pending servers are `Skipped-ReportOnly`.
- **Nested-group, disabled and non-computer members** → never reach the script (§5).

### Detection scope limitation
Detection covers CBS, Windows Update and SCCM. It does **not** check
`PendingFileRenameOperations` or a pending computer rename. A server pending a reboot
*only* for those reasons reports `False` and is not rebooted. This is inherited from
the original script and suits the patching use case; extending it would be a
separate, scoped change.

---

## 7. Reboot execution and verification

For each pending server, in `reboot` mode:

1. **(Optional) pre-reboot step** — only if `runPreRebootScript = true`. The step is
   embedded in the script (`$PreRebootStep`) and sent to the server with
   `Invoke-Command`. Each `takeown`/`icacls` exit code is checked; a failure is logged
   as an `ERROR` and **the server is still rebooted** (decided policy). See §9.
2. **Reboot** — `shutdown /r /t 2 /f /m \\server` with a VCF Orchestrator message.
   The exit code is checked; a rejected command is `RebootFailed` (S-9).
3. **Delay** — wait `delayBetweenServersSec` (10s) **between** servers. There is no
   delay after the last server (S-15a).
4. **Verification pass** — once, after all reboots are issued. Each rebooted server is
   polled every `verifyPollSec` (30s) until its `LastBootUpTime` advances past the
   value captured before the reboot, within `verifyTimeoutSec` (600s) of **its own**
   reboot being issued. Back → `Rebooted`; not back in time → `NotReturned` (an
   `ERROR`). "Return time" is measured to the server's own new boot time, not to when
   the pass happened to poll it (S-15b).

A server that has not gone down yet still reports its old boot time, fails the
"advanced past" test and stays pending — early polling cannot produce a false success.

### Run time and the WinRM timeout
The whole run is **one synchronous PowerShell invocation** lasting roughly:

```
~40s script start-up  +  (pending servers − 1) × delayBetweenServersSec  +  up to verifyTimeoutSec
```

With the deployed values, 20 pending servers ≈ 40s + 190s + ≤600s ≈ 14 minutes. The PS
host's WinRM `MaxTimeoutms` and the PowerShell plug-in timeout must both exceed the
worst case. Element 4 logs a conservative worst-case figure
(`servers × delay + verifyTimeoutSec`) and warns above 30 minutes. If runs are cut off, **raise the
timeouts**; do not shorten `verifyTimeoutSec`, which only gives up on servers that
were going to come back.

The start-up cost exists because `runPowerShellScript` embeds the whole script in the
command it sends over WinRM (≈ 5s + 1.7s per KB). The deployed Resource Element is
therefore the comment-stripped `Invoke-ServerReboot.deploy.ps1` (20.8 KB, ≈ 38s)
rather than the 39 KB source (≈ 73s) — change P-18.

### Per-server statuses
`Rebooted`, `NotReturned`, `RebootFailed`, `Skipped-NoRebootRequired`,
`Skipped-StatusUnknown`, `Skipped-ReportOnly`.

---

## 8. Reporting and end states

**Per-server outcome.** Every run writes a per-server table (name, status, detail)
and a summary block into the transcript, whether or not email is on. The transcript
appears in the `runPowerShellScript` element's log and in the `transcript` output.

**Email report.** When `emailReport = true`, the script builds an HTML report (inline
styles, so it renders in Outlook) with ComputerName, PendingReboot, LastBootUpTime
(before), RebootIssued, BackOnline, Return time (s), Status and Detail, and sends it
via `smtpServer` to `mailTo` (and `mailCc` if given). The subject is
`<mailSubject> - <n> of <m> pending server(s) rebooted and verified`. The sender is
`<PSHOST>_Do_Not_Reply@<domain>`, where the domain is the PS host account's DNS
domain, or the first recipient's domain if that is empty. A failed send is logged as
an `ERROR`; it does not stop the run.

**End states.**

| Outcome | How it shows | Typical causes |
|---|---|---|
| **Completed, `executionSuccess = true`** | Run completes; closing log line `Invoke Server Reboot \| group=… \| rebootMode=… \| …` | Every server handled cleanly (including "nothing pending") |
| **Completed, `executionSuccess = false`** | Run completes; *Parse Results* writes warnings broken down by cause, lists up to 10 errors, and ends `Completed WITH ERRORS` | Unreadable server, rejected shutdown, server not back in time, pre-reboot step failure, report not sent |
| **Failed** | Run in Failed state with the thrown message | AD endpoint/group not found, no direct members, bad email settings, empty `rebootMode`, PS host unreachable, script did not finish (no `PSO_RESULT` line) |

Per-server problems deliberately do **not** fail the workflow: the work that could be
done was done and the report was produced. A schedule or parent workflow branches on
`executionSuccess`.

---

## 9. Security considerations

- **Pre-reboot step (former `ownership_w2k.ps1`).** Takes ownership of and loosens
  ACLs on `usbstor.inf` (reverses a common USB-storage hardening control) and
  `termsrv.dll` (a known precursor to concurrent-RDP patching, which violates the
  Windows EULA). **Off by default** and must not be enabled without security review.
  Because of defect S-6 it has never executed, so enabling it is a new posture, not a
  restoration. It is embedded in the script (S-14), so a review reads one place. Both
  Orchestrator and the script log a loud warning when it is on.
- **Never hard-boots.** The only power action is an OS-level forced restart
  (`shutdown /r /f`); there is no hypervisor reset.
- **Credentials.** AD is read with the account stored against the Orchestrator AD
  endpoint; the targets are reached with the PS host plug-in's account. No credential
  is typed into the workflow.
- **Blast radius is the AD group's direct membership.** Adding a computer account
  directly to the group enrols it; nesting a group does not.
- **PS host certificate must be SHA-256.** VCF Automation 9.1.1 runs Orchestrator in
  FIPS approved-only mode and refuses a SHA-1-signed WinRM listener certificate — the
  failure shows only as `document out [EMPTY]`. See the Change Register open items.

---

## 10. Assumptions, dependencies and known limitations

### Dependencies
- A PS host registered in Orchestrator (WinRM/HTTPS 5986, Kerberos), with a
  **SHA-256** listener certificate and Kerberos constrained delegation for the hop to
  each target.
- The PS host plug-in account has local-admin rights on each target (remote
  WMI/registry, `shutdown /m`, `query user`, and WinRM if the pre-reboot step is
  used).
- An Orchestrator **AD plug-in endpoint** for every domain whose groups will be
  targeted.
- The four shared/AD actions and `runPowerShellScript` present in the modules in §2,
  and the `Invoke-ServerReboot.ps1` Resource Element.
- An SMTP relay that accepts mail from the PS host, if email is used.

### Known limitations
1. **Detection scope** — CBS/WU/SCCM only (§6).
2. **Single synchronous session** — run length is bounded by the WinRM/plug-in
   timeout (§7). Very large groups should be split.
3. **Timings fixed per workflow** — a different cadence needs a workflow edit or a
   copy of the workflow.

---

## Appendix A — Change summary

The standalone `Documentation/Change-Register.md` is the **authoritative** record of
every change and why; this is an index only.

| # | Change | Status |
|---|---|---|
| S-6 | `$PSScriptRoot` fix — the pre-reboot step had never run | Carried into `Invoke-ServerReboot.ps1` (then superseded by S-14) |
| S-7 | Targeting: direct, computer-only, enabled-only | Now enforced by the AD action (element 3) |
| S-8 | Never reboot a server whose state could not be read | In script |
| S-9 | `shutdown.exe` exit code checked | In script |
| S-10 | Batch verification via `LastBootUpTime` | In script |
| S-11 | Per-server HTML report + email | In script |
| S-12 | `Invoke-Module` fix | `cvs_functions.ps1` only; not on this workflow's path |
| S-13 | Pre-reboot step opt-in, default off | In script and workflow |
| S-14 | Pre-reboot step embedded in the script; exit codes checked | In script |
| S-15a/b | No delay after the last server; return time measured to the server's own boot | In script |
| P-9, P-10, P-13 | Pre-staged `cvs_functions.ps1` design | **Superseded** by P-14 … P-17 |
| P-11 | Direct, enabled, computer-only targeting | In effect |
| P-12 | Emailed per-server report; outcome via outputs | In effect |
| P-14 | Script held as a Resource Element, copied per run | In effect |
| P-15 | Shared `runPowerShellScript`, parameters as a Properties bag | In effect |
| P-16 | AD resolution moved into Orchestrator | In effect |
| P-17 | `PSO_RESULT` result contract | In effect |
| P-18 | Deploy a comment-stripped build of the script | In effect |
