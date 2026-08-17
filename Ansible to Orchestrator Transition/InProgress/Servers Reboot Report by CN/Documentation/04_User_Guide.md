# User Guide — Server Reboot Report (vRO)

## Purpose
**Get Server Reboot Report** tells you which Windows servers in an AD security group
currently have a **pending reboot**. It produces an HTML report and can email it. It is
**read-only** — it never reboots anything. To actually reboot, use the separate
**Invoke-ServerReboot** workflow.

## How to run
1. In Orchestrator, open **Get Server Reboot Report** and click **Run**.
2. Fill in the inputs (below). Most have defaults set by your administrator.
3. Submit. When it finishes, check the end state and — if you enabled email — your inbox.

## Inputs
| Input | What to enter |
|---|---|
| `scriptPath` | Path to `cvs_functions.ps1` on the PowerShell host (usually pre-filled). |
| `groupDN` | The AD group **distinguishedName**, e.g. `CN=Monitoring-Servers,OU=Groups,DC=vcf,DC=lab`. A plain group name / CN / SID also resolves, but a full DN is unambiguous. |
| `domainName` | Your AD domain, e.g. `vcf.lab`. |
| `emailReport` | Check to email the HTML report; uncheck for a log-only dry run. |
| `smtpServer` | SMTP relay (needed only when emailing). |
| `mailTo` | Recipients — **add one address per row** in the array field. |
| `mailCc` | CC recipients — one per row; may be left empty. |
| `mailSubject` | Subject stem. The script appends " - N of M server might required reboot". |

> Enter `mailTo` / `mailCc` as **array elements** (one address each). Do not paste a
> single string of addresses into one field.

## Outputs
- **HTML report** (emailed when `emailReport` is on): each server with its pending
  state — *Required Reboot* (orange), *No Action required* (green), or *Error Accessing
  Server* (red) — plus last boot time and logged-on sessions. The **subject** shows how
  many of the total might need a reboot.
- **Workflow log**: per-server status lines, each tagged with
  `Workflow:Get Server Reboot Report-WorkflowRunId:<run id>`.
- **End state** (see below).

## End states
| End state | Meaning |
|---|---|
| **Completed Successfully** | Every resolved server was queried; report produced/mailed. |
| **Completed with Errors** | One or more servers could not be queried (shown as *Error Accessing Server*). The report was still produced and mailed for the rest. |
| **Failed** | The run could not proceed — PS host unreachable, AD module missing, or the group/domain could not be resolved. |

## Common scenarios
- **Scheduled monitoring:** `emailReport = true`, a monitoring distribution list in
  `mailTo`. Schedule the workflow; each run emails the current pending picture.
- **Ad-hoc check before patching:** run once against the target group with
  `emailReport = false` and read the log.
- **Nested groups:** members of nested sub-groups **are** included (recursive) — expect
  a complete list.

## Report files on the host
The HTML report generated on the PowerShell host is cleaned up automatically:
- **Emailed run:** the report file is deleted from the host once the email is
  confirmed sent — nothing accumulates.
- **Report-only run (email off) or a failed send:** the file is kept for inspection,
  but it is written in overwrite mode, so at most **one** run's file ever exists (it is
  replaced on the next run). No scheduled external cleanup is required.

## Known limitations
- Read-only — it reports, it does not remediate.
- A server that cannot be reached over RPC/WMI shows as *Error Accessing Server* and
  moves the run to **Completed with Errors**; it is never assumed pending.
- Disabled computer accounts and non-computer group members are intentionally excluded.

## Troubleshooting
| Symptom | Likely cause / fix |
|---|---|
| Run **Failed** immediately | PS host unreachable, or AD module missing / group or domain not resolvable. Check `groupDN` and `domainName`. |
| Report email never arrives | `emailReport` off; wrong `smtpServer`; or the host script is stale (missing the optional-CC fix). |
| Error *"contains an entry with no '@'"* | `mailTo`/`mailCc` was given a single string instead of array elements — re-enter one address per row. |
| Subject/report shows more servers than expected | Recursive resolution is pulling in nested sub-group members — expected for a report. |
| Many *Error Accessing Server* rows | Targets unreachable over RPC/WMI, or the run account lacks remote query rights. |
