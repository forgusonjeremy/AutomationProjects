# Implementation Guide — Windows Server Disk Cleans

This guide covers preparing the environment, importing the Orchestrator content, loading
the script, pointing the workflow at your PowerShell host and mail relay, and scheduling
the production templates. Steps assume VCF Automation 9 / VCF Operations Orchestrator 9
(Orchestrator Client HTML UI).

What gets installed:

| Object | Type | Module / folder |
|---|---|---|
| `Windows Server Disk Cleans` | Workflow | — |
| `findAdHostForDn` | Action (shared) | `com.broadcom.pso.vcf.activedirectory` |
| `resolveAdGroup` | Action (shared) | `com.broadcom.pso.vcf.activedirectory` |
| `getADComputersGroupDirectMembers` | Action (shared) | `com.broadcom.pso.vcf.activedirectory` |
| `selectPowerShellHost` | Action (shared) | `com.broadcom.pso.powershell` |
| `stageScriptOnHost` | Action (shared) | `com.broadcom.pso.powershell` |
| `invokeStagedScript` | Action (shared) | `com.broadcom.pso.powershell` |
| `Invoke-ServerDiskClean.ps1` | Resource Element | — |
| *Send notification (TLSv1.2)* | Workflow (OOTB, already present) | Library > Mail |

The script is **not** installed on the PowerShell host by hand. The workflow copies it
there on the first run and re-copies it only when the Resource Element changes.

---

## 1. Prerequisites

- [ ] **PowerShell host(s) added to Orchestrator.** Windows Server reachable over
      WinRM/HTTPS (5986) with Kerberos, added with *Add a PowerShell host*. See *How to
      Build a PowerShell Host* (`_Shared/Documentation/PowerShell Host Build Guide`).
- [ ] **Listener certificate is SHA-256.** A SHA-1-signed WinRM certificate is refused
      and the only symptom is an empty result:
      ```
      curl -vk https://<pshost>:5986/wsman 2>&1 | grep 'signed using'
      ```
- [ ] **Kerberos constrained delegation** for the PowerShell host, so its remote session
      can open `\\server\c$` on the targets (the second hop).
- [ ] **Host account rights:** the account the PowerShell host object connects as is a
      **local administrator on every target** (the admin share requires it).
- [ ] **Network, PowerShell host → targets:** SMB, TCP 445.
- [ ] **AD plug-in endpoint** registered for **every domain** whose groups will be
      targeted. The endpoint is chosen from the group DN's `DC=` parts.
- [ ] **Network, every Orchestrator appliance → SMTP relay** on the port the relay
      listens on (25 today), DNS resolution of the relay name, and the appliance
      addresses on the relay's allow-list. The PowerShell host's relay access **does not
      cover** Orchestrator.
- [ ] **If the relay uses TLS:** its certificate imported into Orchestrator (§7).
- [ ] **WinRM timeout headroom** on the PowerShell host (§8).

The ActiveDirectory (RSAT) module is **not** needed on the PowerShell host.

---

## 2. Import the Orchestrator package

1. **Assets → Packages → Import**, and select
   `com.broadcom.pso.servers.windows.serverDiskClean.package` (re-exported after §3).
2. Trust the signing certificate if prompted.
3. **Shared actions:** the actions in the table above are shared with other transitioned
   workflows and may **already exist**. Do not create second copies under other names.
   Overwrite an existing action only if this package carries a newer version.
4. Confirm the workflow and actions appear in the library.

---

## 3. Workflow changes to complete (as of 2026-09-30)

The deployed workflow (`Code/serverDiskCleansWorkflow.yml`, exported 2026-09-30) is up to
date except for the items below. Make them, test (§10), then re-export the package and
the `.yml`.

**3.1 Fix two output names.** In *Parse Results* the script sets `executionOutput` and
`serversProcessed`, but the task's OUT bindings and the workflow outputs are named
`executionOuput` and `ServersProcessed`, so both outputs are always empty. Rename the
workflow outputs **and** the task's OUT binding names to `executionOutput` and
`serversProcessed`.

**3.2 Send one email, synchronously.** Replace the per-recipient loop (*Set Mail Loop
Counter*, *More Emails to Send?*, *Select Email Address*, the asynchronous *Send
notification (TLSv1.2)*, *Increase counter*, and the attributes `mailLoopCounter` /
`emailAddress`) with:

1. **Create Script Parameters:** add an OUT binding `mailToString` (string) to a new
   attribute `mailToString`. The task already builds it: all recipients, comma-separated.
2. **Send notification (TLSv1.2)** as a **Workflow element** (drag the workflow itself onto
   the canvas, *not* "Start an asynchronous workflow"), bound:

   | OOTB input | Bind to |
   |---|---|
   | `smtpHost`, `smtpPort`, `username`, `password`, `fromName`, `fromAddress`, `useStartTls` | the attributes of the same names |
   | `toAddress` | attribute `mailToString` |
   | `subject` | attribute `reportSubject` (subject stem plus the outcome) |
   | `content` | attribute `reportHtml` |

   **Exception handling:** bind the exception to a new string attribute `emailError`
   (default empty), and route it to *Closing Summary*, **not** to an error end.
3. **Closing Summary**, a new scriptable task with the code in `Code/task_ClosingSummary.js`.
   IN: `executionSuccess`, `executionOutput`, `emailReport`, `emailError`, `adGroup`,
   `reportOnly`, `stagedScript`. OUT: `executionSuccess`.
4. **Wiring:** *Email Report?* true → Send notification → Closing Summary; false →
   Closing Summary; Send notification exception → Closing Summary. Closing Summary →
   one **End**.

**3.3 Parse Results report text.** In the Report Only banner, replace `(whatIf = no)`
with `(Report and Delete)` to match the form.

**3.4 Request form.**

| Field | Change |
|---|---|
| `targetPath` | Label: *Script directory on the PowerShell host (local path)*. Input description: *Local directory, e.g. C:\PSO\Scripts*. It is not a UNC path or a file name |
| `olderThanDays` | Display type **Integer** (fractions are refused at run time) |
| `fileFilter` | Label: *Delete files matching (wildcards supported)*. Help: *Applies to files only. Folders are deleted only with `*` or `*.*` and "Delete read-only items".* |
| `folderIncluded` | Label: *Delete folders as well?*. Help: the folder rule, as above |
| `distinguishedName`, `folderTarget`, `fileFilter`, `reportOnly`, `olderThanDays`, `targetPath` | Mark **required** |
| Defaults | See §6 |

---

## 4. Load the script into the Resource Element

1. **Assets → Resources**, and open (or import) the element bound to `scriptElement`.
2. Load **`Code/Invoke-ServerDiskClean.ps1`**, the fully commented source. No stripped
   build is needed: the script crosses WinRM only when it changes.
3. The element's **name must be exactly `Invoke-ServerDiskClean.ps1`.** The name becomes the
   file name on the host. A name that is not a plain `.ps1` file name is refused.
4. Keep the file **ASCII-only** and saved as UTF-8.

> After **any** change to the script, re-import it. The next run logs
> `stageScriptOnHost | ... does NOT match ... Overwriting it`, then `updated`.

---

## 5. Re-point the workflow attributes (most important step)

Open **Windows Server Disk Cleans → Edit → Variables** and set:

| Attribute | Set to | Build-environment value |
|---|---|---|
| `psHosts` | **Your PowerShell host object(s)** | one host, id `0c675c7a-137b-40c3-af36-6f36223dfa59` |
| `scriptElement` | The `Invoke-ServerDiskClean.ps1` element from §4 | id `5fc71d56-a5c4-4dd3-8489-72f91b38e845` |
| `maxItemsListed` | Items named per folder per server in the log | `25` |
| `smtpHost` | Your relay (blank = *Configure mail* default) | `mail.vcf.lab` |
| `smtpPort` | Relay port (`0` = default) | `587` (lab) — production today is **25** |
| `useStartTls` | Must match the relay port's security mode | `true` (lab) — production today is **false** |
| `username`, `password` | Only if the relay requires SMTP AUTH | empty |
| `fromName` | Display name, e.g. `Infrastructure Monitoring` | `no-reply-infmonitoring@vcf.lab` |
| `fromAddress` | Sender address the relay accepts | `no-reply-infmonitoring@vcf.lab` |

List in `psHosts` only hosts whose account can reach **these** targets (local admin +
delegation). The workflow picks the least busy of them and does not check domains.

---

## 6. Request form defaults

| Field | Default |
|---|---|
| `folderTarget` | `c:\Windows\ccmcache` |
| `fileFilter` | `*.*` |
| `reportOnly` | `yes` (Report Only) |
| `olderThanDays` | `1` |
| `folderIncluded` | unchecked |
| `forceEnable` | unchecked |
| `emailReport` | checked |
| `mailTo` | The team distribution list |
| `mailSubject` | `VCF Orchestrator: Windows Server Disk Clean` |
| `targetPath` | `C:\PSO\Scripts` |

### Production template values

| Template | `folderTarget` | `fileFilter` | `olderThanDays` | `folderIncluded` | `forceEnable` |
|---|---|---|---|---|---|
| Cache cleanup (6) | `c:\Windows\ccmcache` | `*.*` | `1` | checked | **decision** |
| Profile cleanup (2) | `c:\users` | `*.*` | `0` | checked | checked |

> **Cache templates:** with `forceEnable` unchecked, folder deletion is declined and only
> files are cleaned; the cache's package folders stay. Tick `forceEnable` to keep removing
> them, as the Ansible templates effectively did.

---

## 7. Mail relay

1. **Configure mail** (*Library > Mail > Configuration*) once, or rely on the workflow's
   SMTP attributes. Leave its username/password **empty** for an anonymous relay. Any
   credentials stored there are used even when the workflow passes none.
2. **Match the security mode.** Plain SMTP on 25 → `useStartTls = false`. STARTTLS on 587 →
   the relay port must be set to **STARTTLS**, not "SSL/TLS". A mismatch does not fail;
   **the send hangs indefinitely**.
3. **Pre-flight** from a machine on the same network path:
   ```
   telnet <relay> <port>
   ```
   A `220 ... ESMTP` banner is good, and `EHLO test` should list `250-STARTTLS` if TLS is
   used. A blank screen means implicit TLS, which will hang.
4. **If TLS is used:** import the relay's certificate with *Library > Configuration > SSL
   Trust Manager > Import a certificate from URL*, and confirm TLS 1.2 is enabled on the
   relay (the OOTB workflow pins it).

Full detail: `_Shared/Documentation/Email-Notification-Standard.md`.

---

## 8. Size the WinRM timeout

The clean is one synchronous PowerShell call; deleting over SMB costs time per item. On
the PowerShell host:

```powershell
Get-Item WSMan:\localhost\MaxTimeoutms          # must exceed the longest run
Set-Item WSMan:\localhost\MaxTimeoutms 3600000  # example: 60 minutes
```

The PowerShell plug-in's operation timeout must also exceed it. Time a Report Only run
against the largest group first; the live run takes at least as long.

---

## 9. Configure the schedules

After §10 passes, schedule one run per production template (**Schedule** on the workflow)
with the §6 values, `reportOnly = no`, `emailReport = true`, and the template's group DN.
Allow for the run time measured in §8.

---

## 10. Validate the deployment

Run in this order; each step proves something the previous one cannot. Full test cases:
`05_Validation_and_Testing_Plan.md`.

1. **Report Only against a lab group** seeded with `lab\New-DiskCleanTestData.ps1`. Expect:
   the resolved servers listed, `stageScriptOnHost ... first copy` (then `unchanged` on
   the next run), a would-delete list per server, the email received, and
   `executionSuccess = true`.
2. **Report Only against the real group.** Check the would-delete counts are plausible, and
   look for any `Unreachable` servers. "Access ... denied" points to rights or delegation.
3. **Report and Delete against a group holding one test server.** Confirm the files are
   gone, the preserved items are still there, and the email shows the space freed.
4. **Mail failure path:** point `smtpHost` at a non-existent host for one Report Only run.
   It should complete with `executionSuccess = false` and "report NOT emailed".
5. Only then schedule the production templates.

---

## 11. Rollback

- Disabling or deleting a schedule stops that template immediately. The workflow keeps no
  state in Orchestrator.
- Removing a computer account from the group (or disabling it) excludes that server from
  the next run.
- To return to a previous script version, re-import it into the Resource Element. The next
  run overwrites the host copy.
- Deleted files are not recoverable by the workflow. Rely on Report Only runs before any
  new target or template goes live.
