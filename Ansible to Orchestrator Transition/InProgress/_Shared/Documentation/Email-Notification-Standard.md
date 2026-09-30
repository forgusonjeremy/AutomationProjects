# Email notification: programme standard

**Applies to:** every Ansible → Orchestrator workflow that emails a report.
**Adopted:** 2026-09-29 (change P-69; first used by Windows Server Clean Disks).

## 1. The rule

**Orchestrator sends the email.** The PowerShell script does not.

| | Old (Ansible / `cvs_functions.ps1`) | Standard (Orchestrator) |
|---|---|---|
| Who sends | The script on the PS host (`Send-MailMessage`) | Orchestrator, through the **Mail plug-in** |
| How | `SendMail` / `Send-ReportMail` inside the script | The **OOTB workflow** *Library > Mail > Send notification (TLSv1.2)*, dropped onto the canvas as a Workflow element |
| Report content | HTML built in PowerShell | HTML built by a workflow scriptable task from the script's `PSO_RESULT` |
| Script parameters | `-eMailReport`, `-SMTPServer`, `-MailToString`, `-MailCcString`, `-MailSubject…` | None; the script knows nothing about mail |
| Network path to the relay | PS host → relay | **Orchestrator appliance → relay** (see §3) |

No custom mail action is used. A shared `sendHtmlEmail` action was written on 2026-09-28 and
deleted on 2026-09-29 in favour of the OOTB workflow; it is in git history if ever needed.

## 2. Wiring the OOTB workflow

| OOTB input | Bind to | Notes |
|---|---|---|
| `smtpHost` | workflow input `smtpHost` | Blank means the plug-in default is used |
| `smtpPort` | workflow input `smtpPort` | `0` means the plug-in default is used |
| `username` | *(not bound)* | The relay is anonymous today |
| `password` | *(not bound)* | The relay is anonymous today |
| `fromName` | *(not bound)* | |
| `fromAddress` | workflow input `fromAddress` | Blank means the plug-in default is used |
| `toAddress` | attribute `mailToString` | **One string.** The parameter task joins the `mailTo` array with `,` |
| `subject` | attribute built by the report task | |
| `content` | attribute holding the HTML report | Sent as `text/html; charset=UTF-8` |
| `useStartTls` | *(not bound, so false)* | |

**Exception binding: required.** The OOTB workflow **throws** if the relay rejects the mail or
can't be reached. Bind its exception to a string attribute (e.g. `emailError`) and route it to
the workflow's closing task, **not** to a Failed end state. By the time mail is sent the work
(deletes, reboots) has already happened, and a Failed end would make a completed run look as if
nothing was done. The closing task sets `executionSuccess = false` and logs "report NOT emailed".

**No CC.** The OOTB workflow has no CC input. Put every recipient in `mailTo`.

**How blank inputs behave.** `new EmailMessage("TLSv1.2")` starts from the Mail plug-in's
defaults (*Library > Mail > Configuration > Configure mail*). The workflow overrides a default
only when the input is non-empty. So:

- Leave username and password **empty in *Configure mail*** for an anonymous relay. Any
  credentials stored there are used even when the workflow binds none.
- The workflow logs `sending mail to host: <h>:<p> with user: <u>, from: …, to: …`, so one test
  run shows exactly which settings were used.

## 3. Deployment requirement: Orchestrator → SMTP relay connectivity

Mail leaves from the **Orchestrator appliance**, so this network path is a prerequisite for
every workflow that emails a report:

| | |
|---|---|
| **Source** | Every Orchestrator node. In a cluster a run can land on any appliance, so request the rule for all of them |
| **Destination** | The SMTP relay: the `smtpHost` input, or the host set in *Configure mail* |
| **Port** | TCP 25, or the configured port |
| **Name resolution** | The appliance must resolve the relay's DNS name |
| **Relay policy** | The relay must accept (relay) mail from the appliance addresses for the From domain used |

The PowerShell host's existing relay access **does not cover this.** Firewall rules and relay
allow-lists written for the PS host (or for the Ansible controller) must be extended to the
Orchestrator appliance addresses explicitly.

**Symptom when it is missing:** the workflow's work completes, the *Send Report Email* element
throws (connection timed out / refused / relay access denied), and the run ends normally with
`executionSuccess = false` and "report NOT emailed" in the closing line.

**Verify before go-live:** run the workflow in report-only mode with email on, and confirm the
mail arrives and the log line shows the expected host, user (none) and sender.

Every project's `02_Design_Document` (dependencies) and `03_Implementation_Guide`
(pre-deployment checklist) must list this requirement.

## 3a. If the relay uses TLS (e.g. STARTTLS on 587)

The customer's current scripts send **plain SMTP on TCP 25, unauthenticated** (`Send-MailMessage`
with no `-Port`, `-UseSsl` or `-Credential`; this is true of both the original `cvs_functions.ps1`
`SendMail` and `Invoke-ServerReboot.ps1`). If the Orchestrator path is to use TLS instead, all
four of these must line up, or the send fails. In one case it **hangs**:

| Check | Why |
|---|---|
| **The server's security mode for that port matches the client's.** STARTTLS on the client (`useStartTls = true`) needs the server port set to **STARTTLS** (hMailServer: *Connection security: STARTTLS (Required/Optional)*), **not** "SSL/TLS" | "SSL/TLS" means *implicit* TLS: the server waits silently for a TLS handshake while a STARTTLS client waits for the `220` greeting. Neither side speaks, and with no socket timeout **the element never completes or fails**. The run then never reaches its closing task. (Seen in the lab 2026-09-29.) Implicit TLS conventionally lives on **465**, and the OOTB workflow does not expose the SSL-on-connect option |
| **Orchestrator trusts the relay's certificate** | A self-signed or internal-CA certificate fails the handshake with a PKIX / "unable to find valid certification path" error. Import it with *Library > Configuration > SSL Trust Manager > Import a certificate from URL* (host and port of the relay) |
| **TLS 1.2 is enabled on the relay** | The OOTB workflow pins it: `new EmailMessage("TLSv1.2")` |
| **Authentication, if the relay requires it on that port** | Mail servers often require SMTP AUTH on 587. Then `username` / `password` must be bound on the OOTB workflow, or set in *Configure mail*. They are left unbound only for an anonymous relay |

**Pre-flight test (do this before the first run):** `telnet <relay> <port>` from a machine on
the same network path. A **`220 ... ESMTP` banner** means the port speaks plain SMTP/STARTTLS, and
`EHLO test` should then list `250-STARTTLS`. A **blank screen** means implicit TLS, which will
hang a STARTTLS client.

## 4. Projects

| Project | Status |
|---|---|
| Windows Server Clean Disks | Uses this standard (build sheet elements 8–11) |
| Server Reboots, Move Windows Event Logs, Remove Log Files from File Share | Still email from PowerShell. **Conversion is on the retrofit list** for after Clean Disks |
| Report projects (Admin Accounts, Service Account Expiration, Servers Reboot Report by CN) | Email via `cvs_functions.ps1` `SendMail` today; convert when those projects are next worked on |
