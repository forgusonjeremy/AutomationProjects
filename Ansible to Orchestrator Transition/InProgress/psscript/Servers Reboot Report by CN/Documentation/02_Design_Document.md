# Design Document — Server Reboot Report (vRO)

## 1. Architecture overview
A single vRO workflow (**Get Server Reboot Report**)
orchestrates one synchronous PowerShell invocation on a PowerShell host. All logic —
AD resolution, the pending-reboot check, counting, HTML report and mail — lives in
`cvs_functions.ps1`. vRO builds the invocation, runs it, and classifies the transcript.

The workflow is **read-only**: it invokes `Get-ServerRebootReportStatus-ByCN` and never
issues a reboot. There is no `rebootMode` safety gate because there is nothing to gate.

## 2. Components
| Component | Role |
|---|---|
| Workflow **Get Server Reboot Report** | Orchestration + end-state classification |
| Action **buildServerRebootReportInvocation** (`com.broadcom.pso.vcf.vm.guestOps.windows.reboot`) | Builds the validated PowerShell invocation string |
| OOTB **Invoke a PowerShell script** | Runs the string on the PS host (linked sub-workflow) |
| Action **parseScriptOutput** (`com.broadcom.pso.vcf.vm.guestOps.files.windows.logs`) | Parses transcript → `success` / `outputText` / `errorText` |
| Script **cvs_functions.ps1** on the PS host | Does the actual work (resolver, WMI checks, report, mail) |
| PowerShell host | Runs the script; reaches targets over RPC/WMI |

## 3. Data flow (as built)
```
Set Log Marker (workflow.id)                          [root]
  → buildServerRebootReportInvocation                 → invocationString
  → Invoke a PowerShell script (host attr, script)    → psRawOutput
        catch(err_0) → Throw Error → End (FAILED)
  → Set Execution Context  (groupDN + "@" + domainName)→ executionContext
  → parseScriptOutput (psRawOutput, executionContext) → parsedResult
  → Decision: parsedResult.success
        true  → Log Success   → End
        false → Log Failures  → End (Completed with Errors)
```

The action emits this invocation (values illustrative):
```
& "C:\PSO\Scripts\cvs_functions.ps1" -Action 'Get-ServerRebootReportStatus-ByCN' `
  -SecurityGroup_CN '<groupDN>' -DomainName '<domain>' -eMailReport 'yes' `
  -SMTPServer '<relay>' -MailToString '<to>' -MailCcString '<cc>' `
  -MailSubjectstring '<subject>' -HeaderNotesSubstr '<derived group name>' `
  *>&1 | Out-String -Width 4096
```
`*>&1 | Out-String -Width 4096` merges all PowerShell streams into the success stream
so the vRO plug-in returns the transcript to `parseScriptOutput` (which only sees the
success stream) without wrapping long `Error:` lines.

## 4. Resolver design (why ByCN + recursive)
`Get-ServerRebootReportStatus-ByCN` uses `Get-ListOfServers-ByCN`:
- **Recursive** — nested AD sub-groups are expanded to their computer members.
- **Computer-class filtered** — user / group objects are excluded.
- **Enabled filtered** — disabled computer accounts are skipped and logged.
- **Per-object isolation** — one unresolvable member is skipped, not fatal; a
  group-level failure (group missing / domain unreachable) terminates the run.

Recursion is correct **because the run is read-only**: expanding a nested group only
yields a more complete picture of what needs rebooting — never an unintended action.
This is the deliberate opposite of **Invoke-ServerReboot**, which uses a
**non-recursive** resolver (Server Reboots change S-7) because rebooting is
destructive and targets must be explicit.

## 5. Input / recipient handling
- `mailTo` / `mailCc` are **Array/string** (one address per element). The action
  normalizes either an array or a CSV string to a clean comma-separated list.
- **Char-split guard:** if a scalar string is mis-bound to an Array input, vRO splits
  it into characters; the action detects a recipient token with no `@` and throws a
  clear error rather than emailing `j,f,o,...`.
- `-HeaderNotesSubstr` (report header label) is **derived from `groupDN`** inside the
  action, not a separate input — the header can never name a different group than the
  one targeted.
- The FROM address is derived by the script (`<PSHOST>_Do_Not_Reply@<domain>`); there
  is no from-address input.

## 6. Dependencies
- **parseScriptOutput** is reused from the Event Log package module
  `com.broadcom.pso.vcf.vm.guestOps.files.windows.logs` — that package must be installed.
- **cvs_functions.ps1** must be deployed on the PS host and must contain the
  optional-CC `SendMail` fix (Change-Register R-2) or emailed reports fail.
- **ActiveDirectory** PowerShell module on the PS host (group resolution).

## 7. Assumptions
- The PowerShell host is registered in vRO and bound to the workflow `host` attribute.
- The account running the script can query targets over RPC/WMI and resolve the group.
- SMTP relay accepts mail from the PS host.

## 8. Risks and mitigations
| Risk | Mitigation |
|---|---|
| Production report set changes (recursive vs legacy) | Documented in R-1; validate group membership before cutover |
| Stale host script breaks emailed report (CC bug) | Implementation Guide verifies the fix is present |
| Scalar string bound to `mailTo`/`mailCc` → char-split | Action throws a clear error; bind as Array elements |
| Long run on a large / slow group | Ensure PS host WinRM operation timeout exceeds total query time |

## 9. Security considerations
- Read-only: no state change on targets.
- Runs under the PS host credential; scope that account to least privilege needed for
  remote WMI/registry reads and AD group resolution.
- Report may list server names and logged-on sessions — treat the email distribution
  list as sensitive.

## 10. Operational considerations
- Runtime scales roughly linearly with group size and with unreachable servers (each
  waits out its RPC/WMI timeout).
- Every log line carries `Workflow:<name>-WorkflowRunId:<run id>` for correlation.
- **Report-file lifecycle (R-5):** the generated HTML report on the PS host
  (`$Global:DebugDir\ServerPendingRebootStatus_result.html`, plus the per-run
  `Report.html`) is written in **overwrite** mode and is **deleted after a confirmed
  email send**. A report-only run or a failed send leaves at most one run's file
  (overwritten next run). This bounds PS-host disk use without relying on an external
  scheduled cleanup.
- End states: **Completed Successfully**, **Completed with Errors** (some servers
  unqueryable; report still produced/mailed), **Failed** (PS host unreachable / script
  throws — AD module missing, group/domain unresolvable).
