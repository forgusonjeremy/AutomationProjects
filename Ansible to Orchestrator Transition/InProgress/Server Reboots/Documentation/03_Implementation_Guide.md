# Implementation Guide — Server Reboot Automation

**Project:** Ansible → VCF Orchestrator transition — "Server Reboots"
**Platform:** VCF Automation 9 / VCF Operations Orchestrator 9
**Workflow:** `Reboot Servers in AD Group` (`Invoke-ServerReboot`)

This guide covers importing the Orchestrator package, re-pointing the
environment-specific values (PS host, domain, script path, mail), and configuring the
custom form and schedule. Steps assume VCF Operations Orchestrator 9 (Orchestrator
Client HTML UI).

---

## 1. Prerequisites

Complete these before importing:

- [ ] **PowerShell host built and added to Orchestrator.** A Windows Server reachable
      over WinRM/HTTPS (5986) with Kerberos, added under *Library → PowerShell → hosts*
      (or the plug-in inventory). See the cross-project *How to Build a PowerShell
      Host* reference, including its Kerberos and certificate notes.
- [ ] **Kerberos constrained delegation** configured for the PS host so it can make the
      second hop to AD and to each target server (RPC/WMI/SMB).
- [ ] **ActiveDirectory module (RSAT)** installed on the PS host (the script resolves
      the group with `Get-ADGroupMember` / `Get-ADComputer`).
- [ ] **`cvs_functions.ps1` staged** on the PS host at the path you will pass as
      `scriptPath` (default `C:\PSO\Scripts\cvs_functions.ps1`). Use the current
      version containing changes **S-6…S-13** (from
      `InProgress/psscript/files/cvs_functions.ps1`).
- [ ] **`ownership_w2k.ps1` staged beside it — only if** you intend to enable the
      pre-reboot step. Leave it out otherwise (the step is off by default).
- [ ] **PS host service account permissions:** local admin on each target server
      (for `shutdown` and remote WMI), and read access to the AD group.
- [ ] **Logs module present** (provides `parseScriptOutput`) — module
      `com.broadcom.pso.vcf.vm.guestOps.files.windows.logs`, reused from the Move
      Windows Event Logs package. If that package is not installed, import it first, or
      include the shared actions in this package.

Verify the staged script on the PS host:
```powershell
Test-Path 'C:\PSO\Scripts\cvs_functions.ps1'
Select-String -Path 'C:\PSO\Scripts\cvs_functions.ps1' -Pattern `
  "Get-ListOfServers-Direct","Wait-ServersBackOnline","GenerateReportServerReboot","RebootIt_VerifyTimeoutSec"
# All four should match (confirms S-7, S-10, S-11 are present).
```

---

## 2. Import the Orchestrator package

1. In the **Orchestrator Client**, go to **Assets → Packages**.
2. Click **Import**, browse to the package file
   (`com.broadcom.pso.vcf.vm.guestOps.windows.reboot.package` or the delivered
   `.package`), and select it.
3. On the import dialog:
   - Review the content list (the workflow, the `buildServerRebootInvocation` action,
     and any bundled shared actions).
   - **Certificate:** accept/trust the signing certificate if prompted.
   - **Import options:** keep **"Import configuration attribute values"** *unchecked*
     if you do not want the lab PS host reference carried in (you will set your own in
     Step 3 regardless). Choose to overwrite server version only if you intend to
     replace an existing copy.
4. Click **Import**. Confirm the workflow **`Reboot Servers in AD Group`** and the
   action **`buildServerRebootInvocation`** appear in the library.

> If `parseScriptOutput` shows as missing after import, the logs module is not present
> — import the Event Log package (or the shared actions) first, then re-open the
> workflow. See §6.

---

## 3. Re-point the PowerShell host (most important step)

The workflow's `host` attribute is stored with a **specific PS host object from the
build environment** (lab: `vcfa.site-a.vcf.lab`, id `532644c5-678b-4314-91a0-d781b97e5f91`).
After import this reference will not match your environment and must be reset.

1. Open **`Reboot Servers in AD Group`** → **Edit**.
2. Go to the **Variables** (attributes) tab. Find the attribute **`host`**
   (type `PowerShell:PowerShellHost`).
3. Clear the imported value and **select your PS host** from the plug-in inventory.
4. **Save**. Confirm the value now shows your host's URL/id, not the lab one.

> Symptom if skipped: the *Invoke a PowerShell script* step fails to connect, or runs
> against the wrong/again a non-existent host.

---

## 4. Set environment-specific input defaults

These live on the **custom form** (workflow → **Version/Edit → Custom Form**) and/or as
input defaults. Update the following for your environment:

| Field | Change to | Notes |
|---|---|---|
| `scriptPath` | Your staged path | Default `C:\PSO\Scripts\cvs_functions.ps1`; change only if you staged it elsewhere |
| `domainName` | **Your AD domain** | Default is the lab value `vcf.lab` — **must** be changed |
| `groupDN` | (leave blank as a default; operators/schedule supply it) | The target group's DN, e.g. `CN=Server-Reboots,OU=Servers,DC=corp,DC=local` |
| `smtpServer` | Your SMTP relay | e.g. `mailrelay.corp.local` |
| `mailTo` | Default recipient list | Array of addresses |
| `mailCc` | Default CC list (optional) | Array of addresses |
| `mailSubject` | Your subject stem | e.g. `VCF Orchestrator: Server Reboot status` |
| `emailReport` | `true` for scheduled runs | So the report is delivered |

Leave these at their defaults unless you have a reason to change them:
`delayBetweenServersSec` (10), `verifyTimeoutSec` (600), `verifyPollSec` (30),
`runPreRebootScript` (**false — do not enable without security review**).

### Custom form notes (as delivered)
- **`rebootMode`** is a dropdown: **Reboot** (`simpleMode`) / **Report-Only** (`no`).
  For a **scheduled** job, set it to **Reboot**. For manual dry-runs, choose
  Report-Only.
- **`runPreRebootScript`** is a checkbox labelled *"Enable USB Mass Storage and make
  termsrv.dll writeable?"* — leave **unchecked** unless security has approved
  `ownership_w2k.ps1` (see Design Document §8). The mail fields are plain inputs; if you
  want them hidden until `emailReport` is checked, add a visibility condition on the
  form (optional).

The FROM address is derived by the script itself
(`<PSHOST>_Do_Not_Reply@corp.local`); if that domain is wrong for your environment,
adjust `$Global:MailFrom` in `cvs_functions.ps1` (`InitializeVariables`).

---

## 5. Configure the schedule

The workflow is designed to run on a schedule that **always attempts reboots**.

1. Run the workflow once manually in **Report-Only** first (see §7) to confirm
   resolution and connectivity.
2. Create the schedule: **workflow → Schedule** (or **Assets → Policies/Schedules**,
   depending on build). Provide the input values, with **`rebootMode = simpleMode`** and
   `emailReport = true`.
3. Choose the recurrence (e.g. a nightly or post-patch window). Remember the run can
   last up to `(pending servers × delayBetweenServersSec) + verifyTimeoutSec`; make sure
   the window and the PS host WinRM operation timeout accommodate the worst case.

---

## 6. Optional workflow hardening

The two issues flagged in earlier drafts are **resolved in the current build**:

- The `parseScriptOutput` module-name typo is corrected — both references now use
  `com.broadcom.pso.vcf.vm.guestOps.files.windows.logs`.
- Terminating-error handling is wired — the *Invoke a PowerShell script* element
  catches a hard failure into `err_0` and re-throws it (item9 → item10 *End
  workflow*), so a PS-host outage or an AD-module `throw` ends the run **Failed**
  instead of faulting uncontrolled.

One optional refinement remains (see Design Document §9): the build action
(`buildServerRebootInvocation`, item1) has no exception path, so a validation `throw`
(missing required input, or `verifyPollSec` > `verifyTimeoutSec`) still faults the
workflow. If you want a clean *Bad Inputs* end state, add an exception out-binding on
item1 to a dedicated end element. This is a nicety, not a blocker.

---

## 7. Validate the deployment

Run these in order (details and the lab tool are in the Validation section / User
Guide):

1. **Report-Only run** against the real group (`rebootMode = no`). Expect the transcript
   to list resolved members and their pending state, and the run to end *Completed
   Successfully* with **no** reboots.
2. **Simulate a pending reboot** on one test server using
   `lab/Set-PendingRebootFlag.ps1 -ComputerName <host> -Action Set` (or `-AdGroup`), then
   re-run Report-Only — that server should now show *required reboot*.
3. **Live run** (`rebootMode = simpleMode`) against the armed test server. Confirm it
   reboots, the verification pass reports it back online, and the emailed report is
   received.
4. **Clean up** the simulated flag:
   `lab/Set-PendingRebootFlag.ps1 -ComputerName <host> -Action Clear`.
5. **Negative checks:** a powered-off/unreachable member should report
   `Skipped-StatusUnknown` (not rebooted) and the run should end *Completed with
   Errors*.

---

## 8. Rollback

- The workflow performs no persistent change in Orchestrator; disabling/deleting the
  schedule stops all automated reboots immediately.
- To revert the PowerShell behaviour, restore the previously released
  `cvs_functions.ps1` on the PS host (the pre-S-6 baseline is preserved in source
  control — see the Change Register). Note this reintroduces the fixed defects.
- Removing a server from the target AD group (or disabling its account) makes it
  ineligible on the next run without any workflow change.
