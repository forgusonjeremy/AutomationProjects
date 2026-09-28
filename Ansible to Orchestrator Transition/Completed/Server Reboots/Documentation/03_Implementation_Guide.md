# Implementation Guide — Server Reboot Automation

This guide covers preparing the environment, importing the Orchestrator content,
re-pointing the environment-specific bindings (PowerShell host, script, timings),
and configuring the schedule. Steps assume VCF Automation 9.1.1 / VCF Operations
Orchestrator 9 (Orchestrator Client HTML UI).

What gets installed:

| Object | Type | Module / folder |
|---|---|---|
| `Reboot Servers in AD Group` | Workflow | — |
| `findAdHostForDn` | Action (shared) | `com.broadcom.pso.vcf.activedirectory` |
| `resolveAdGroup` | Action (shared) | `com.broadcom.pso.vcf.activedirectory` |
| `getADComputersGroupNonRecursive` | Action | `com.broadcom.pso.vcf.activedirectory` |
| `runPowerShellScript` | Action (shared) | `com.broadcom.pso.vcfa.vm.guestScripting` |
| `Invoke-ServerReboot.ps1` | Resource Element | — |
| `probeAdPlugin` | Action (shared, diagnostic only) | — |

Nothing is staged on the PowerShell host. The script is copied there for each run
and deleted afterwards.

---

## 1. Prerequisites

- [ ] **PowerShell host added to Orchestrator.** A Windows Server reachable over
      WinRM/HTTPS (5986) with Kerberos, added with the *Add a PowerShell host*
      workflow. See the cross-project *How to Build a PowerShell Host* reference.
- [ ] **PS host listener certificate is SHA-256.** VCF Automation 9.1.1 refuses a
      SHA-1-signed certificate and the only symptom is `document out [EMPTY]`. Check
      from any machine with curl:
      ```
      curl -vk https://<pshost>:5986/wsman 2>&1 | grep 'signed using'
      ```
      Hosts built with `Configure-vROPSHost.ps1` before 2026-09-22 must be re-checked.
- [ ] **Kerberos constrained delegation** configured for the PS host, so it can make
      the second hop to each target server.
- [ ] **PS host plug-in account rights on every target server:** local
      administrator (remote WMI/registry, `shutdown /m`, `query user`). If the
      pre-reboot step will ever be enabled, WinRM to the targets as well.
- [ ] **Network from the PS host to every target:** RPC/WMI (TCP 135 plus the
      dynamic RPC range) and SMB (445); WinRM (5985/5986) only for the pre-reboot step.
- [ ] **Orchestrator AD plug-in endpoint** registered for **every domain** whose groups
      will be targeted (*Add an Active Directory server*). The workflow picks the
      endpoint from the group DN's `DC=` parts, so an unregistered domain fails the run.
- [ ] **SMTP relay** that accepts unauthenticated mail from the PS host, if the report
      will be emailed.
- [ ] **WinRM timeout headroom** on the PS host — see §7.

The ActiveDirectory (RSAT) module is **not** needed on the PS host; the group is
resolved by the Orchestrator AD plug-in.

---

## 2. Import the Orchestrator package

1. In the **Orchestrator Client**, go to **Assets → Packages → Import**.
2. Select the package exported from the build environment
   (`com.broadcom.pso.servers.windows.reboots.package`).
3. On the import dialog:
   - Review the content list against the table at the top of this guide.
   - **Certificate:** trust the signing certificate if prompted.
   - **Shared actions:** `runPowerShellScript` is shared by every PowerShell-based
     Orchestrator workflow, so it **already exists** if any of them is installed.
     If the Move Archived Logs or Remove Old Archived Logs packages are installed,
     `findAdHostForDn`, `resolveAdGroup` and `probeAdPlugin` **already exist** too. Do not create a
     second copy under another name — let all workflows call the one copy. Only
     overwrite an existing action if this package carries the newer version.
4. Click **Import**, then confirm the workflow and actions appear in the library.

---

## 3. Load the script into the Resource Element

The workflow runs whatever is in the `Invoke-ServerReboot.ps1` Resource Element.

1. Go to **Assets → Resources**.
2. If the element came in with the package, open it; otherwise **Import** a new one.
3. Load the content from **`Code/Invoke-ServerReboot.deploy.ps1`** — the
   comment-stripped build. It starts roughly twice as fast as the commented source
   because `runPowerShellScript` sends the whole script text over WinRM on every run.
4. The element's **name must be exactly `Invoke-ServerReboot.ps1`**. The name becomes
   the file name on the host; a name containing `\`, `/` or `:` is refused.

> After **any** change to `Invoke-ServerReboot.ps1`, rebuild the deploy copy with
> `Completed/_Shared References/Tools/Build-ResourceElement.ps1` and re-import it.
> Importing the source directly works but costs ~35s more per run; forgetting to
> rebuild deploys a stale script.

---

## 4. Re-point the workflow attributes (most important step)

Four attributes are bound to objects or values from the build environment and must be
checked after import.

1. Open **`Reboot Servers in AD Group`** → **Edit** → **Variables**.
2. Set each of the following:

| Attribute | Type | Set to | Build-environment value |
|---|---|---|---|
| `psHost` | PowerShell:PowerShellHost | **Your PS host** from the plug-in inventory | id `0c675c7a-137b-40c3-af36-6f36223dfa59` |
| `script` | ResourceElement | The `Invoke-ServerReboot.ps1` element from §3 | id `1d91559a-f672-4a42-8ce3-297a9e59206b` |
| `delayBetweenServersSec` | number | Seconds between reboots | `10` |
| `verifyTimeoutSec` | number | Seconds each server has to come back | `600` |
| `verifyPollSec` | number | Seconds between verification polls (must not exceed the timeout) | `30` |

3. **Save**, and confirm `psHost` and `script` show your objects, not blank or the
   build-environment ids.

The timing values apply to **every** run of the workflow; they are not on the request
form.

> Symptom if `psHost` is not re-pointed: element 5 (*runPowerShellScript*) fails to
> connect. Symptom if `script` is not re-pointed: *"runPowerShellScript: no script was
> supplied"*.

---

## 5. Check the AD plug-in with `probeAdPlugin`

Run the `probeAdPlugin` action once (it changes nothing), passing any group. Confirm:

- every domain you will target has a registered AD endpoint, and
- under *Group membership*, `computerMembers`/`computers` (or `members`) is
  **present**. If none is present, element 3 will fail with *"this Active Directory
  plug-in did not report the membership"*.

---

## 6. Request form defaults (optional)

The request form shows: `adGroupDn`, **Reboot or Report Only**, **Run Allow USB and
Make TermSrv.dll Editable Script?**, `emailReport`, `mailTo`, `mailCc`, `mailSubject`,
`smtpServer`. None has a default except the pre-reboot checkbox (unchecked).

To save operators typing, you may set defaults under **Input Form** for:

| Field | Suggested default |
|---|---|
| `smtpServer` | Your relay, e.g. `mailrelay.<domain>` |
| `mailTo` | The team distribution list |
| `mailSubject` | `VCF Orchestrator: Server Reboot status` |
| `emailReport` | checked |

**Leave the pre-reboot checkbox unchecked** unless security has approved the step
(Design Document §9).

---

## 7. Size the WinRM timeout

Each run is one synchronous PowerShell invocation lasting roughly:

```
~40s start-up + (pending servers − 1) × delayBetweenServersSec + up to verifyTimeoutSec
```

With the default attributes, 20 pending servers is about 14 minutes. On the PS host:

```powershell
Get-Item WSMan:\localhost\MaxTimeoutms          # must exceed the worst case
Set-Item WSMan:\localhost\MaxTimeoutms 3600000  # example: 60 minutes
```

The PowerShell plug-in's own operation timeout must also exceed it. *Create Script
Parameters* logs a worst-case estimate on every run and warns above 30 minutes.

---

## 8. Configure the schedule

The workflow is designed to run on a schedule that **always attempts reboots**.

1. Complete the validation in §9 first.
2. On the workflow, choose **Schedule** and supply:

| Input | Value |
|---|---|
| `adGroupDn` | The group's full DN, e.g. `CN=Security-Reboot-Servers,OU=Groups,DC=vcf,DC=lab` |
| `rebootMode` | **`reboot`** — exactly, lower case. Any other value is report-only |
| `emailReport` | `true` |
| `smtpServer`, `mailTo`, `mailSubject` | Your values (`mailCc` optional) |
| `runPreRebootScript` | `false` |

3. Pick the recurrence (e.g. the post-patch window), allowing for the run time in §7.

---

## 9. Validate the deployment

Run in this order. Each step exercises something the previous one cannot.

1. **Report Only against the real group.** Expect the log to list the resolved
   servers and each server's pending state, and the run to finish with
   `executionSuccess = true` and *"REPORT ONLY — nothing was rebooted"*.
2. **Simulate a pending reboot** on one test server with the lab helper, then repeat
   Report Only — that server should now count as pending:
   ```powershell
   .\lab\Set-PendingRebootFlag.ps1 -ComputerName <testsrv> -Action Set
   ```
3. **Live run against a group containing only the test server** (`rebootMode =
   Reboot`). Confirm the server reboots, the log shows *"back online, returned Ns
   after its reboot was issued"*, and the emailed report arrives.
4. **Clean up** the simulated flag (it does not clear itself on reboot):
   ```powershell
   .\lab\Set-PendingRebootFlag.ps1 -ComputerName <testsrv> -Action Clear
   ```
5. **Negative check:** with a powered-off member in the group, the run should
   complete with `executionSuccess = false` and that server
   `Skipped-StatusUnknown` — not rebooted.
6. Only then run against the full production group.

---

## 10. Rollback

- Disabling or deleting the schedule stops all automated reboots immediately. The
  workflow keeps no state in Orchestrator.
- Removing a computer account from the target group (or disabling it) makes that
  server ineligible from the next run, with no workflow change.
- To return to a previous script version, re-import that version into the
  `Invoke-ServerReboot.ps1` Resource Element.
