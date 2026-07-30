/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Workflow: Get Admin Accounts Report
 *   Workflow ID : (TBD — assign on first save in vRO, then record it here)
 *   Folder      : Production >> Identity >> Active Directory >> Reporting
 *                 (lab/dev: Workflows >> Customer >> <Customer Name> >> ...)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THIS FILE DOCUMENTS THE AS-BUILT WORKFLOW. It mirrors the exported workflow
 * definition so the design and the appliance stay in sync. Each scriptable task's
 * code below is the exact code deployed in the corresponding schema element.
 *
 * Purpose:
 *   READ-ONLY PKI/smartcard compliance report over privileged ("admin") accounts.
 *   Sweeps every OU in every domain of a supplied scope, splits the accounts into
 *   smartcard-enforced (compliant) and not-enforced (non-compliant), folds the two
 *   counts into the mail subject, and emails an HTML table with a footnote listing
 *   exactly which domains and OUs were searched.
 *
 *   NOTHING IS EVER MODIFIED. This workflow only runs Get-ADUser. The sibling
 *   'Set-L3-Admin-Accounts' case in cvs_functions.ps1 — which WRITES
 *   SmartcardLogonRequired on every matching account — is deliberately NOT exposed
 *   by this package. There is consequently no whatIf/safety gate: there is nothing
 *   to gate.
 *
 *   All AD resolution, the compliance split, the counts and the HTML report/mail
 *   happen inside cvs_functions.ps1. Orchestrator assembles the scope, builds the
 *   invocation, runs it on a pre-bound PowerShell host, and classifies the
 *   transcript.
 *
 * Script action invoked: Get-AllAdmin-Accounts
 *
 * Maps from (Ansible) — THREE job templates consolidate onto this ONE workflow
 * (Change-Register P-26):
 *   - admin_accounts_report-v2.yml   x2 templates, multi-domain, via cvs_functions-v2.ps1
 *                                    (vars.txt: var_DomainOUs — 7 domains x 2 OUs)
 *   - admin_accounts_report.yml      x1 template, SINGLE OU, via cvs_functions.ps1
 *                                    (-DomainName + -OUPath)
 *
 *   The single-OU template is not a special case here — it is a domainOUs list with
 *   one row.
 *
 *   SEPARATE ENVIRONMENTS: the PowerShell host this workflow targets is NOT the host
 *   the Ansible templates run against — in DEVELOPMENT or in PRODUCTION. The two
 *   estates never share a PowerShell host. Deploying the merged cvs_functions.ps1
 *   therefore cannot disturb any Ansible job; there is no deployment sequencing
 *   dependency between the two; and "parallel run" means the two systems running side
 *   by side on different hosts against the same directory, compared on their OUTPUT.
 *   See Change-Register §1A-i.
 *
 *   NOTE ON SOURCE LINEAGE — this one is different from the other transitions.
 *   The playbook invoked cvs_functions-v2.ps1, a SEPARATE FORK of the shared
 *   toolbox. That fork was the only place multi-domain support existed
 *   (-DomainOUsFile, Get-ListOfUsers-MultiDomain, GenerateReportPKI-v2), but it
 *   predated and therefore lacked every hardening change S-1 … S-15 and the
 *   ByCN/UNC actions. The mainline cvs_functions.ps1 meanwhile still carried the
 *   OLD single-domain Get-AllAdmin-Accounts (-DomainName + -OUPath).
 *
 *   Change-Register S-16 MERGES the fork's multi-domain capability into the
 *   hardened mainline script and retires the fork, preserving the project's
 *   one-shared-toolbox rule. Three defects in the fork were fixed as part of that
 *   merge — see the FAILURE-HANDLING CONTRACT below and the Change Register.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * PACKAGE DEPENDENCY
 * ───────────────────────────────────────────────────────────────────────────
 *   parseScriptOutput is REUSED from the Event Log package's module
 *   com.broadcom.pso.vcf.vm.guestOps.files.windows.logs — this package depends on
 *   that one being installed. buildAdminAccountsReportInvocation lives in
 *   com.broadcom.pso.vcf.identity.ad.accounts.adminReport.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WORKFLOW SCHEMA (as built)
 * ───────────────────────────────────────────────────────────────────────────
 *
 * [Start]
 *     ▼
 * (item10) [Scriptable: Set Log Marker]   ── root element
 *     ▼
 * (item1)  [Action: buildAdminAccountsReportInvocation]
 *     module com.broadcom.pso.vcf.identity.ad.accounts.adminReport
 *     IN  scriptPath, domainOUs, emailReport, smtpServer, mailTo, mailCc, mailSubject
 *     OUT actionResult → invocationString
 *     ▼
 * (item2)  [Workflow link: Invoke a PowerShell script]
 *     IN  host ← attribute host (PRE-BOUND);  script ← invocationString
 *     OUT output → psRawOutput
 *     ├─[catch → err_0]→ (item3)[Scriptable: Throw Error  (throw err_0)] → (item4)[End]
 *     ▼
 * (item6)  [Scriptable: Set Execution Context]  executionContext = scope summary
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
 *   Schema is intentionally IDENTICAL to Get-ServerRebootReport — same OOTB PS link,
 *   same catch path, same parse/decide/log tail. Only the build action and the
 *   inputs differ.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * INPUTS  (all optional in the form; none mandatory)
 * ───────────────────────────────────────────────────────────────────────────
 *   Name         Type           Form control   Notes
 *   ──────────── ────────────── ────────────── ─────────────────────────────────
 *   scriptPath   string         textField      Full path to cvs_functions.ps1 on the PS host
 *   domainOUs    Array/string   array          OU distinguishedNames — the report SCOPE
 *   emailReport  boolean        checkbox       Send the HTML report → -eMailReport
 *   smtpServer   string         textField      SMTP relay → -SMTPServer
 *   mailTo       Array/string   array          Recipients (one address per element) → -MailToString
 *   mailCc       Array/string   array          CC recipients (optional) → -MailCcString
 *   mailSubject  string         textField      Subject stem → -MailSubjectstring
 *
 *   domainOUs — ONE OU distinguishedName PER ROW. Nothing else; no domain column:
 *
 *     OU=Admin Accounts,OU=Servers,DC=domain1,DC=corp,DC=local
 *     OU=Admin Accounts,OU=Workstations,DC=domain1,DC=corp,DC=local
 *     OU=Admin Accounts,OU=Servers,DC=domain2,DC=corp,DC=local
 *     ... (production default: 7 domains x 2 OUs = 14 rows, per vars.txt)
 *
 *   The DOMAIN IS DERIVED from each DN's own DC= components
 *   (DC=domain1,DC=corp,DC=local → domain1.corp.local). The action groups the rows by
 *   derived domain and emits the JSON map the script expects.
 *
 *   ONE WORKFLOW COVERS BOTH SHAPES. Supplying OUs from a single domain and OUs from
 *   seven is the same operation — whether the report is sectioned across domains
 *   falls out of the DNs supplied, not out of a mode the operator selects. This is
 *   what lets the three Ansible job templates collapse onto one workflow
 *   (Change-Register P-26).
 *
 *   ADVANCED OVERRIDE (rarely needed): a row may be written '<server>|<OU DN>' to
 *   force the directory server for that OU, overriding the derived domain — for a
 *   cross-forest search base, a domain alias, or a specific DC. Split on the FIRST
 *   '|' only; a DN never contains a pipe.
 *
 *   WHY A LIST AND NOT A FILE: the Ansible playbook wrote the map to a temp file with
 *   win_copy and passed -DomainOUsFile. Orchestrator invokes a PRE-STAGED script and
 *   has no staging step, so the map is passed INLINE via -DomainOUs. Keeping it as
 *   form rows (rather than raw JSON in a text box) means the scope is reviewable
 *   row-by-row in the request form and in the run history, and a malformed entry is
 *   rejected by the action with a pointed message instead of failing in PowerShell.
 *
 *   VALIDATION — the action FAILS the run on: an empty list; a row with no 'DC='
 *   component (neither the search base nor the domain could be resolved — this also
 *   catches the vRO character-split artifact). It WARNS but proceeds on: a duplicate
 *   OU (dropped); NESTED OUs in the same domain (Subtree scope would return the
 *   deeper OU's accounts twice and double-count them); a DN with no 'OU=' component
 *   (valid, but a domain root searches the ENTIRE domain); a server override that
 *   disagrees with its DN.
 *
 *   mailTo / mailCc ARE Array/string (isMultiple). Enter ONE address per array
 *   element. Do NOT bind a scalar string into these — vRO would split it into
 *   characters. The action guards against this (throws on a token with no '@'),
 *   and applies the same guard to domainOUs rows (throws on a row with no '|').
 *
 *   There is NO psHost input. The PowerShell host is a pre-bound ATTRIBUTE (see
 *   below) — re-point it per environment in the workflow, not at run time.
 *
 *   There is NO domainName or ouPath input. Before S-16 this action searched one
 *   domain and one OU; it is now driven entirely by the domainOUs list. The script
 *   no longer accepts -DomainName/-OUPath for THIS action either (S-21 removed the
 *   legacy fallback). The OU list is the only way to scope the report; supplying no
 *   list fails the run rather than producing a narrower report. The parameters still
 *   exist in the script for Get-ServiceAccountExpiration, which genuinely uses them.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ATTRIBUTES
 * ───────────────────────────────────────────────────────────────────────────
 *   host              PowerShell:PowerShellHost  - PRE-BOUND to the target PS host
 *   invocationString  string                     - from buildAdminAccountsReportInvocation
 *   psRawOutput       PowerShell:PowerShellRemotePSObject - from Invoke a PowerShell script
 *   executionContext  string                     - scope summary (set by item6)
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
 * ───────────────────────────────────────────────────────────────────────────
 * SCHEDULING
 * ───────────────────────────────────────────────────────────────────────────
 *   This is a recurring compliance report. Schedule it with the OOTB
 *   "Schedule a workflow" / a recurrent task rather than running it by hand.
 *   All inputs are static per environment, so the schedule carries the whole scope.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * FAILURE-HANDLING CONTRACT
 * ───────────────────────────────────────────────────────────────────────────
 *   Condition                                              End state
 *   ────────────────────────────────────────────────────── ─────────────────────────
 *   Bad inputs (malformed row, OU without DC=, bad         PS link never reached; action task
 *     recipient, no scope)                                 faults the run
 *   PS host unreachable                                    catch → Throw Error → End (item4) = FAILED
 *   ActiveDirectory module missing on the PS host          script THROWS (S-16) → catch → FAILED
 *   Domain/OU map empty or not valid JSON                  script THROWS (S-16) → catch → FAILED
 *   ONE domain/OU cannot be queried                        "Error:" line → success=false →
 *     (bad DN, dead DC, broken trust)                      Log Failures → End (item7).
 *                                                          Remaining OUs ARE still queried and
 *                                                          the report IS still sent.
 *   Scope valid but contains no accounts                   "Warn:" → success=true → Log Success.
 *                                                          Empty report sent WITH the OU footnote.
 *
 *   WHY THE THROWS MATTER (S-16). The three FAILED rows above previously did not
 *   fail. The old code logged an "Error:" line and carried on, and the fork silently
 *   accepted an unparsed map — so a run with no AD module, or an unusable scope,
 *   emailed an EMPTY compliance report. For a compliance deliverable that is the
 *   worst possible outcome: "no non-compliant accounts found" and "the query never
 *   ran" looked identical. They are now distinguishable — a scope problem fails the
 *   run outright, and a PARTIAL sweep ends "Completed with Errors" with the failing
 *   OU named in the transcript and called out in the report footnote.
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
// In: domainOUs   Out: executionContext  (string attribute)
//
// WHAT THIS IS: a HUMAN-READABLE LABEL, nothing more. parseScriptOutput takes it as
// an input and uses it in exactly one way — it interpolates it into its own
// System.log / System.warn / System.error lines ("parseScriptOutput | context=… | …").
// NOTHING branches on it, it is not parsed, and it never affects success/failure or
// control flow. If it were empty the action would substitute "(unknown context)" and
// behave identically.
//
// WHAT IT IS FOR: making those parse lines identifiable when you are reading a log
// containing many runs, or several different report workflows. System.setLogMarker
// (item10) already stamps the workflow name and run id on every line, so this does
// NOT need to repeat either — its job is to say what this run was pointed AT.
//
// SO: build it from whatever identifies the TARGET in one short line, and keep it
// BOUNDED — it is prepended to several lines, and the full scope is already recorded
// in the invocation string and in the report's own scope footnote.
//
// For this workflow the target is the OU scope. The DOMAIN is derived from each DN's
// DC= components exactly as buildAdminAccountsReportInvocation does, so the context
// names the same domains the script will actually query.
var ctxRows = (domainOUs === null || domainOUs === undefined) ? [] :
              ((typeof domainOUs === "string") ? domainOUs.split("\n") : domainOUs);

var ctxDomains = [];
var ctxOUCount = 0;

for (var c = 0; c < ctxRows.length; c++) {
    var ctxRow = String(ctxRows[c]).trim();
    if (ctxRow === "") { continue; }
    ctxOUCount++;

    // Mirror the action's own logic: '<server>|<DN>' overrides the derived domain,
    // otherwise derive from the DN's DC= components. Deriving is the normal path —
    // treating a plain DN as though it were a domain name would report one "domain"
    // per OU and dump the whole DN into every log line.
    var ctxBar = ctxRow.indexOf("|");
    var ctxDom;
    if (ctxBar !== -1) {
        ctxDom = ctxRow.substring(0, ctxBar).trim();
    } else {
        var ctxParts = [];
        var ctxRe = /DC=((?:[^,\\]|\\.)*)/gi;
        var ctxM;
        while ((ctxM = ctxRe.exec(ctxRow)) !== null) {
            ctxParts.push(ctxM[1].replace(/\\(.)/g, "$1"));
        }
        ctxDom = ctxParts.join(".");
    }
    if (ctxDom === "") { ctxDom = "(undetermined)"; }

    var ctxSeen = false;
    for (var c2 = 0; c2 < ctxDomains.length; c2++) {
        if (ctxDomains[c2].toLowerCase() === ctxDom.toLowerCase()) { ctxSeen = true; break; }
    }
    if (!ctxSeen) { ctxDomains.push(ctxDom); }
}

// Bounded: name up to three domains, then a count. Production scope is 7 domains —
// listing all of them on every parse line adds noise without adding meaning.
var ctxNamed = ctxDomains.slice(0, 3).join(", ");
if (ctxDomains.length > 3) { ctxNamed += " +" + (ctxDomains.length - 3) + " more"; }
if (ctxDomains.length === 0) { ctxNamed = "(no scope supplied)"; }

executionContext = ctxDomains.length + " domain(s), " + ctxOUCount + " OU(s): " + ctxNamed;

// Production example (7 domains x 2 OUs):
//   7 domain(s), 14 OU(s): domain1.corp.local, domain2.corp.local, domain3.corp.local +4 more
// Single-OU example:
//   1 domain(s), 1 OU(s): vcf.lab


// ── (item3) Throw Error — PS link catch path ─────────────────────────────────
// In: err_0   Out: (none) → routes to End (item4), a FAILED end state.
// Reached when the PS host is unreachable OR the script threw: missing
// ActiveDirectory module, or an empty/malformed domain/OU map (all S-16 throws).
throw err_0;


// ── (item8) Decision: Script Succeeded? ──────────────────────────────────────
// In: parsedResult   true → Log Success, false → Log Failures.
// Deployed decision body (shown here as a comment; a bare top-level `return` is not
// valid module code):
//     return parsedResult.success;


// ── (item11) Log Success ─────────────────────────────────────────────────────
// In: parsedResult, executionContext   Out: executionSuccess, executionOutput
// Every OU in scope was queried successfully. The report has been emailed (when
// emailReport is true) and written to the Debug folder on the PS host.
executionSuccess = true;
executionOutput  = parsedResult.get("outputText");

System.log(
    " | Get-AdminAccountsReport | Completed successfully." +
    " | scope=" + executionContext +
    " | output=" + executionOutput
);


// ── (item9) Log Failures ─────────────────────────────────────────────────────
// In: parsedResult, executionContext   Out: executionSuccess, executionOutput
// "Completed with errors" — NOT a hard failure. One or more OUs could not be
// queried (bad DN, unreachable DC, broken trust). Every OTHER OU was swept and the
// report was still produced and mailed.
//
// TREAT THIS AS UNDER-REPORTING, NOT AS NOISE: the accounts in a failed OU are
// absent from the table, which reads identically to that OU being fully compliant.
// The failing OU is named in errorText below and in the transcript.
executionSuccess = false;
executionOutput  = "Compliance report completed with errors — one or more OUs could not be queried and are " +
                   "MISSING from the report. Accounts in those OUs are NOT represented in the compliance " +
                   "counts. See the workflow log and the emailed report footnote for details. Error: " +
                   parsedResult.get("errorText");

System.warn(
    " | Get-AdminAccountsReport | Completed with errors — report is INCOMPLETE." +
    " | scope=" + executionContext +
    " | errorText=" + parsedResult.get("errorText")
);
