/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Workflow: Get Server Reboot Report
 *   Workflow ID : 9fe2e6c5-0186-45a8-94c2-575c926836e9
 *   Folder      : Production >> Servers >> Windows >> Server Reboot Management
 *                 (lab/dev: Workflows >> Customer >> <Customer Name> >> ...)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THIS FILE DOCUMENTS THE AS-BUILT WORKFLOW. It mirrors the exported workflow
 * definition so the design and the appliance stay in sync. Each scriptable task's
 * code below is the exact code deployed in the corresponding schema element.
 *
 * Purpose:
 *   REPORT-ONLY companion to Invoke-ServerReboot. Resolves an AD security group,
 *   queries every member server for its pending-reboot state (remote
 *   WMI/registry/SCCM), and produces an HTML report (optionally emailed). NOTHING
 *   is ever rebooted. Physical and virtual servers are treated identically (the
 *   pending check is OS-level; nothing touches vCenter).
 *
 *   All resolution, the pending check, the count and the HTML report/mail happen
 *   inside cvs_functions.ps1. Orchestrator builds the invocation, runs it on a
 *   pre-bound PowerShell host, and classifies the transcript.
 *
 * Script action invoked: Get-ServerRebootReportStatus-ByCN
 *
 * Maps from (Ansible):
 *   - servers_reboot_report-ByCN.yml     (variables.txt: var_SecurityGroup_CN) → Get-ServerRebootReportStatus-ByCN
 *   - servers_pending_reboot_report.yml  (vars.txt: var_ADGroupMember)         → Get-ServerPendingRebootStatus (LEGACY)
 *   Both variants are CONSOLIDATED onto the single hardened ByCN action (Change-Register R-1).
 *   The customer's former -ADGroupMember report now runs through the recursive,
 *   Enabled-filtered, per-object-isolated ByCN resolver — a strict improvement for a
 *   read-only report (more complete, less noise).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * PACKAGE DEPENDENCY
 * ───────────────────────────────────────────────────────────────────────────
 *   parseScriptOutput is REUSED from the Event Log package's module
 *   com.broadcom.pso.vcf.vm.guestOps.files.windows.logs — this package depends on
 *   that one being installed. buildServerRebootReportInvocation lives in
 *   com.broadcom.pso.vcf.vm.guestOps.windows.reboot.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WORKFLOW SCHEMA (as built)
 * ───────────────────────────────────────────────────────────────────────────
 *
 * [Start]
 *     ▼
 * (item10) [Scriptable: Set Log Marker]   ── root element
 *     ▼
 * (item1)  [Action: buildServerRebootReportInvocation]
 *     module com.broadcom.pso.vcf.vm.guestOps.windows.reboot
 *     IN  scriptPath, groupDN, domainName, emailReport, smtpServer, mailTo, mailCc, mailSubject
 *     OUT actionResult → invocationString
 *     ▼
 * (item2)  [Workflow link: Invoke a PowerShell script]
 *     IN  host ← attribute host (PRE-BOUND);  script ← invocationString
 *     OUT output → psRawOutput
 *     ├─[catch → err_0]→ (item3)[Scriptable: Throw Error  (throw err_0)] → (item4)[End]
 *     ▼
 * (item6)  [Scriptable: Set Execution Context]  executionContext = groupDN + "@" + domainName
 *     ▼
 * (item5)  [Action: parseScriptOutput]
 *     module com.broadcom.pso.vcf.vm.guestOps.files.windows.logs
 *     IN  psOutput ← psRawOutput;  executionContext ← executionContext
 *     OUT actionResult → parsedResult
 *     ▼
 * (item8)  [Decision: Script Succeeded?  return parsedResult.success]
 *     ├─ true  → (item11)[Scriptable: Log Success]  → (item0)[End]
 *     └─ false → (item9) [Scriptable: Log Failures] → (item7)[End]
 *
 * ───────────────────────────────────────────────────────────────────────────
 * INPUTS  (all optional in the form; none mandatory)
 * ───────────────────────────────────────────────────────────────────────────
 *   Name         Type           Form control   Notes
 *   ──────────── ────────────── ────────────── ─────────────────────────────────
 *   scriptPath   string         textField      Full path to cvs_functions.ps1 on the PS host
 *   groupDN      string         textField      AD group DN (preferred) → -SecurityGroup_CN
 *   domainName   string         textField      AD domain → -DomainName
 *   emailReport  boolean        checkbox       Send the HTML report → -eMailReport
 *   smtpServer   string         textField      SMTP relay → -SMTPServer
 *   mailTo       Array/string   array          Recipients (one address per element) → -MailToString
 *   mailCc       Array/string   array          CC recipients (optional) → -MailCcString
 *   mailSubject  string         textField      Subject stem → -MailSubjectstring
 *
 *   mailTo / mailCc ARE Array/string (isMultiple). Enter ONE address per array
 *   element. Do NOT bind a scalar string into these — vRO would split it into
 *   characters. The action guards against this (throws on a token with no '@').
 *
 *   There is NO psHost input. The PowerShell host is a pre-bound ATTRIBUTE (see
 *   below) — re-point it per environment in the workflow, not at run time.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ATTRIBUTES
 * ───────────────────────────────────────────────────────────────────────────
 *   host              PowerShell:PowerShellHost  - PRE-BOUND to the target PS host
 *                                                  (as built: id 532644c5-…, vcfa.site-a.vcf.lab)
 *   invocationString  string                     - from buildServerRebootReportInvocation
 *   psRawOutput       PowerShell:PowerShellRemotePSObject - from Invoke a PowerShell script
 *   executionContext  string                     - groupDN + "@" + domainName (set by item6)
 *   parsedResult      Properties                 - from parseScriptOutput
 *   err_0             string                     - catch binding from the PS link
 *   executionSuccess  boolean                    - set by Log Success / Log Failures
 *   executionOutput   string                     - set by Log Success / Log Failures
 *
 *   NOTE: the workflow defines NO formal outputs. executionSuccess / executionOutput
 *   are attributes set for logging; the operator-facing result is the emailed HTML
 *   report and the end state reached. Promote them to workflow OUTPUTS if a calling
 *   workflow needs to branch on the result.
 *
 *   NO SAFETY GATE, no rebootMode, no delay/verify inputs — this workflow only reads
 *   and reports; it can never reboot a server.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * FAILURE-HANDLING CONTRACT
 * ───────────────────────────────────────────────────────────────────────────
 *   Condition                                              End state
 *   ────────────────────────────────────────────────────── ─────────────────────────
 *   Bad inputs (action throws)                             PS link never reached; action task faults the run
 *   PS host unreachable / script throws (AD module, group) catch → Throw Error → End (item4) = FAILED
 *   Server whose pending state cannot be read              "Error:" line → parsedResult.success=false → Log Failures → End (item7)
 *   Nested sub-group                                       expanded (recursive) → continues
 *   Disabled / non-computer member                         skipped + logged → continues
 *   Zero members                                           empty report → success → Log Success → End (item0)
 *
 * ───────────────────────────────────────────────────────────────────────────
 * SCRIPTABLE TASK CODE (as deployed)
 * ───────────────────────────────────────────────────────────────────────────
 */

// ── (item10) Set Log Marker — root element ───────────────────────────────────
// In: (none)  Out: (none)
// workflow.id is the RUN (token) id in vRO — confirmed by run logs showing a
// per-run GUID distinct from the workflow definition id. System.setLogMarker then
// prepends "Workflow:<name>-WorkflowRunId:<run id>" to every subsequent log line.
var logMarker = "Workflow:" + workflow.name + "-WorkflowRunId:" + workflow.id;
System.setLogMarker(logMarker);


// ── (item6) Set Execution Context ────────────────────────────────────────────
// In: groupDN, domainName   Out: executionContext
// Passed to parseScriptOutput so its log lines identify the target group/domain.
executionContext = groupDN + "@" + domainName;


// ── (item3) Throw Error — PS link catch path ─────────────────────────────────
// In: err_0   Out: (none) → routes to End (item4), a FAILED end state.
throw err_0;


// ── (item8) Decision: Script Succeeded? ──────────────────────────────────────
// In: parsedResult   true → Log Success, false → Log Failures.
// Deployed decision body (shown here as a comment; a bare top-level `return` is not
// valid module code):
//     return parsedResult.success;


// ── (item11) Log Success ─────────────────────────────────────────────────────
// In: parsedResult, groupDN, domainName   Out: executionSuccess, executionOutput
// The run's setLogMarker token is applied to this line by vRO.
executionSuccess = true;
executionOutput  = parsedResult.get("outputText");

System.log(
    " | Get-ServerRebootReport | Completed successfully." +
    " | groupDN=" + groupDN + " | domain=" + domainName +
    " | output=" + executionOutput
);


// ── (item9) Log Failures ─────────────────────────────────────────────────────
// In: parsedResult, groupDN, domainName   Out: executionSuccess, executionOutput
// "Completed with errors" — NOT a hard failure. One or more servers could not be
// queried (reported "Error Accessing Server" → "Error:" line → success=false). All
// other servers were queried and the HTML report was still produced and mailed.
executionSuccess = false;
executionOutput  = "Report completed with errors — one or more servers could not be queried. " +
                   "See workflow log and the emailed report for details. Error: " +
                   parsedResult.get("errorText");

System.warn(
    " | Get-ServerRebootReport | Completed with errors." +
    " | groupDN=" + groupDN + " | domain=" + domainName +
    " | errorText=" + parsedResult.get("errorText")
);
