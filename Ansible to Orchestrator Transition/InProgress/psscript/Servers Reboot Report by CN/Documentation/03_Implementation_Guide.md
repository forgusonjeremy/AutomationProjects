# Implementation Guide — Server Reboot Report (vRO)

Covers deploying the **Get Server Reboot Report** workflow: prerequisites, staging the
PowerShell script, importing the package, re-pointing the PS host, setting input
defaults, validation, and rollback.

## 1. Prerequisites
- [ ] **VCF Orchestrator** reachable; permission to import packages and edit workflows.
- [ ] **PowerShell host** registered in vRO and reachable over WinRM/PSRP.
- [ ] **ActiveDirectory** PowerShell module present on the PS host.
- [ ] **Event Log package** installed (provides
      `com.broadcom.pso.vcf.vm.guestOps.files.windows.logs/parseScriptOutput`, reused here).
- [ ] **`cvs_functions.ps1` staged** on the PS host at the path you will pass as
      `scriptPath` (default `C:\PSO\Scripts\cvs_functions.ps1`).

### Verify the staged script has the required fix
The emailed report depends on the optional-CC fix in `SendMail` (Change-Register R-2).
On the PS host:
```powershell
Test-Path 'C:\PSO\Scripts\cvs_functions.ps1'
Select-String -Path 'C:\PSO\Scripts\cvs_functions.ps1' -Pattern 'mailParams','ccList','Send-MailMessage @mailParams'
```
All three patterns must be found. If instead you see `Send-MailMessage ... -cc $MailCc`,
the host script is **stale** — redeploy it, or an empty CC will fail every emailed
report with *"Cannot validate argument on parameter 'Cc'."*

Also confirm the report action is present:
```powershell
Select-String -Path 'C:\PSO\Scripts\cvs_functions.ps1' -Pattern 'Get-ServerRebootReportStatus-ByCN','Get-ListOfServers-ByCN'
```

## 2. Set the mail domain to yours
`cvs_functions.ps1` hardcodes an email domain: the FROM address is derived as
`<PSHOST>_Do_Not_Reply@<domain>` in `$Global:MailFrom`, and the default
`-MailToString` / `-MailCcString` are `admin@<domain>`. The delivered copy uses
`vcf.lab`. **If your environment is a different domain, update the `@<domain>` in
`cvs_functions.ps1` (`$Global:MailFrom`) and the workflow's mail inputs before running.**

## 3. Import the Orchestrator package
- Import the package containing the workflow and `buildServerRebootReportInvocation`.
- Confirm the Event Log package (parseScriptOutput) is present; if not, install it first.

## 4. Re-point the PowerShell host (most important step)
The `host` **attribute** is bound to a specific PowerShell host. There is **no `psHost` input** — the host is
selected in the workflow, not at run time.
- Edit the workflow → attribute **`host`** → set its value to **your** registered
  PowerShell host.
- Save. Every run now targets your host.

## 5. Set environment-specific input defaults
Open the workflow presentation / input defaults:

| Input | Set to | Notes |
|---|---|---|
| `scriptPath` | Your staged path | Default `C:\PSO\Scripts\cvs_functions.ps1` |
| `groupDN` | Your AD group **distinguishedName** | e.g. `CN=Monitoring-Servers,OU=Groups,DC=vcf,DC=lab` |
| `domainName` | Your AD domain | e.g. `vcf.lab` |
| `emailReport` | `true` for scheduled runs | Checkbox |
| `smtpServer` | Your SMTP relay | e.g. `mailrelay.vcf.lab` |
| `mailTo` | Recipient list | **Array — one address per element** |
| `mailCc` | CC list (optional) | **Array — one address per element**; may be empty |
| `mailSubject` | Subject stem | Script appends " - N of M server might required reboot" |

> **`mailTo` / `mailCc` are Array/string.** Add each address as its own array element.
> Do **not** bind a single scalar string into these inputs — vRO splits a scalar
> string into characters and the report would be addressed to `j,f,o,...`. The action
> guards against this and will throw *"contains an entry with no '@'"* if it happens.

## 6. Validate the deployment
1. Pick a small AD group with 2–3 known servers; set `groupDN` to its DN.
2. Run with `emailReport = false` first. Expect **Completed Successfully** and per-server
   `Status: NO reboot require` / `required reboot` lines in the log, each prefixed with
   `Workflow:Get Server Reboot Report-WorkflowRunId:<id>`.
3. Re-run with `emailReport = true` and a valid `mailTo`. Confirm the HTML report
   arrives; the subject carries the pending count.
4. Negative check: point `groupDN` at a group with an unreachable server. Expect
   **Completed with Errors** (an `Error:` line for that server; the report still sends).

## 7. Version-specific considerations
- `workflow.id` returns the **run (token) id** in this vRO version — used by **Set Log
  Marker**. Confirmed by run logs showing a per-run GUID distinct from the workflow
  definition id.
- Ensure the PS host WinRM/PSRP **operation timeout** exceeds the worst-case run time
  for a large or partly-unreachable group (each unreachable server waits out its own
  RPC/WMI timeout).

## 8. Rollback
- **Workflow:** delete/disable the imported workflow; the Ansible playbooks remain the
  fallback until decommissioned.
- **PS host script:** the report action and `SendMail` fix are additive; to revert,
  redeploy the prior `cvs_functions.ps1`. Note this re-introduces the empty-CC email
  defect (R-2).
