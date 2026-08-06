/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Workflow: Get Service Account Expiration Report
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
 *   READ-ONLY expiration report over service accounts. Sweeps every OU in every
 *   domain of a supplied scope, classifies each account against its
 *   AccountExpirationDate as Expired / Expiring / Active / Never expires, folds the
 *   expired and expiring counts into the mail subject, and emails an HTML report that
 *   leads with the accounts needing action and lists the full inventory beneath.
 *
 *   NOTHING IS EVER MODIFIED. This workflow only runs Get-ADUser. It does not renew,
 *   extend, disable or delete any account it reports on, so there is no whatIf/safety
 *   gate — there is nothing to gate.
 *
 *   All AD resolution, the expiry classification, the counts and the HTML report/mail
 *   happen inside cvs_functions.ps1. Orchestrator assembles the scope, builds the
 *   invocation, runs it on a pre-bound PowerShell host, and classifies the transcript.
 *
 * Script action invoked: Get-ServiceAccountExpiration
 *
 * Maps from (Ansible):
 *   - service_accounts_report.yml   x1 job template, via cvs_functions.ps1
 *                                   (-DomainName + a single -OUPath; vars.txt shows
 *                                   one domain and one OU)
 *
 *   Unlike the admin accounts report there is NO FORK here — one playbook, one
 *   template, invoking the mainline shared script. The transition is therefore a
 *   straight replacement plus the S-22/S-23 defect fixes.
 *
 *   SEPARATE ENVIRONMENTS: the PowerShell host this workflow targets is NOT the host
 *   the Ansible templates run against — in DEVELOPMENT or in PRODUCTION. The two
 *   estates never share a PowerShell host. Deploying the updated cvs_functions.ps1
 *   therefore cannot disturb any Ansible job; there is no deployment sequencing
 *   dependency between the two; and "parallel run" means the two systems running side
 *   by side on different hosts against the same directory, compared on their OUTPUT.
 *   See the Admin Accounts Report Change-Register §1A-i, which established this.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THE OUTPUT WILL NOT MATCH THE OLD REPORT — READ BEFORE PARALLEL RUN
 * ───────────────────────────────────────────────────────────────────────────
 *   A side-by-side comparison against the Ansible report WILL show differences, and
 *   every one of them is a defect fix rather than a regression. Expect:
 *
 *   1. MORE ACCOUNTS. The old run silently queried only accounts where
 *      SmartcardLogonRequired was False — an unintended filter caused by an omitted
 *      -SC argument binding to $false (Change-Register S-22, defect 1). Any service
 *      account requiring a smart card was missing from every previous report.
 *   2. AN EXPIRATION DATE COLUMN. The old report never rendered one at all
 *      (S-23, defect 1) — it showed password age only.
 *   3. "Never set" WHERE THE OLD REPORT SHOWED A PASSWORD AGE OF 0, and those rows
 *      now sort to the TOP of their group instead of the bottom (S-22 helper
 *      ConvertFrom-ADFileTime).
 *   4. NO BLANK ROW. The old report appended an unset $Result2 variable, rendering an
 *      empty row on every run (S-22, defect 4).
 *
 *   Brief the recipients before the first scheduled send. The account COUNT is
 *   expected to rise; that is previously-invisible scope becoming visible.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * PACKAGE DEPENDENCY
 * ───────────────────────────────────────────────────────────────────────────
 *   parseScriptOutput is REUSED from the Event Log package's module
 *   com.broadcom.pso.vcf.vm.guestOps.files.windows.logs — this package depends on that
 *   one being installed. buildServiceAccountExpirationInvocation lives in
 *   com.broadcom.pso.vcf.identity.ad.accounts.serviceAccountExpiry.
 *
 *   The shared PowerShell functions this action relies on (Resolve-DomainOUsMap,
 *   Get-ListOfUsers-MultiDomain, Remove-DuplicateAccounts, Get-ADFailureCategory,
 *   Format-HtmlTable) were introduced by the Admin Accounts Report deliverable
 *   (S-16 … S-20). Both workflows must run against the SAME staged cvs_functions.ps1.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WORKFLOW SCHEMA (as built)
 * ───────────────────────────────────────────────────────────────────────────
 *
 * [Start]
 *     ▼
 * (item10) [Scriptable: Set Log Marker]   ── root element
 *     ▼
 * (item1)  [Action: buildServiceAccountExpirationInvocation]
 *     module com.broadcom.pso.vcf.identity.ad.accounts.serviceAccountExpiry
 *     IN  scriptPath, domainOUs, expiringWithinDays, emailReport, smtpServer, mailTo, mailCc, mailSubject
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
 *   Schema is intentionally IDENTICAL to Get-AdminAccountsReport — same OOTB PS link,
 *   same catch path, same parse/decide/log tail. Only the build action and the inputs
 *   differ.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * INPUTS  (all optional in the form; none mandatory)
 * ───────────────────────────────────────────────────────────────────────────
 *   Name                Type           Form control   Notes
 *   ─────────────────── ────────────── ────────────── ──────────────────────────────
 *   scriptPath          string         textField      Full path to cvs_functions.ps1 on the PS host
 *   domainOUs           Array/string   array          OU distinguishedNames — the report SCOPE
 *   expiringWithinDays  number         textField      Look-ahead window in days (default 30)
 *   emailReport         boolean        checkbox       Send the HTML report → -eMailReport
 *   smtpServer          string         textField      SMTP relay → -SMTPServer
 *   mailTo              Array/string   array          Recipients (one address per element) → -MailToString
 *   mailCc              Array/string   array          CC recipients (optional) → -MailCcString
 *   mailSubject         string         textField      Subject stem → -MailSubjectstring
 *
 *   domainOUs — ONE OU distinguishedName PER ROW. Nothing else; no domain column:
 *
 *     OU=Service Accounts,DC=corp,DC=local
 *     ... (production default per vars.txt: this ONE row)
 *
 *   The DOMAIN IS DERIVED from each DN's own DC= components
 *   (DC=corp,DC=local → corp.local). The action groups the rows by derived domain and
 *   emits the JSON map the script expects. Supplying OUs from one domain or from seven
 *   is the same operation — the report sections itself by whatever was supplied.
 *
 *   ADVANCED OVERRIDE (rarely needed): a row may be written '<server>|<OU DN>' to force
 *   the directory server for that OU, overriding the derived domain — for a
 *   cross-forest search base, a domain alias, or a specific DC. Split on the FIRST '|'
 *   only; a DN never contains a pipe.
 *
 *   expiringWithinDays — THE LOOK-AHEAD WINDOW, in days. Default 30. It decides which
 *   accounts appear in the "Expiring" section and in the subject-line count; it does
 *   NOT filter the report — every account in scope is always listed in the inventory,
 *   and accounts that have ALREADY expired are reported regardless of this value.
 *   The window is inclusive at its edge, and rounds in the safe direction: an account
 *   29.6 days away IS flagged by a 29-day window. Set it to match the schedule — a
 *   report that runs monthly wants a window of at least a month, or an account can
 *   expire between two runs having never been flagged.
 *   The action REJECTS anything that is not a whole, non-negative number.
 *
 *   VALIDATION — the action FAILS the run on: an empty list; a row with no 'DC='
 *   component (neither the search base nor the domain could be resolved — this also
 *   catches the vRO character-split artifact); a non-integer or negative
 *   expiringWithinDays; a recipient with no '@' when emailReport is true. It WARNS but
 *   proceeds on: a duplicate OU (dropped); NESTED OUs in the same domain (Subtree scope
 *   returns the deeper OU's accounts twice — the script de-duplicates them, so the
 *   figures stay correct, but the report carries a notice); a DN with no 'OU='
 *   component (valid, but a domain root searches the ENTIRE domain and would report on
 *   every user in it); a server override that disagrees with its DN; a window longer
 *   than a year; emailReport=false.
 *
 *   mailTo / mailCc ARE Array/string (isMultiple). Enter ONE address per array element.
 *   Do NOT bind a scalar string into these — vRO would split it into characters. The
 *   action guards against this (throws on a token with no '@'), and applies the
 *   equivalent guard to domainOUs rows (throws on a row with no 'DC=').
 *
 *   There is NO psHost input. The PowerShell host is a pre-bound ATTRIBUTE (see below)
 *   — re-point it per environment in the workflow, not at run time.
 *
 *   There is NO domainName or ouPath input. Before S-22 this action searched one domain
 *   and one OU; it is now driven entirely by the domainOUs list, and the script accepts
 *   NO legacy fallback — supplying no list fails the run rather than producing a
 *   narrower report (the same reasoning as S-21 on the admin report: a silently
 *   narrowed scope means an account expires with nobody warned).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ATTRIBUTES
 * ───────────────────────────────────────────────────────────────────────────
 *   host              PowerShell:PowerShellHost  - PRE-BOUND to the target PS host
 *   invocationString  string                     - from buildServiceAccountExpirationInvocation
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
 *   This is a recurring report. Schedule it with the OOTB "Schedule a workflow" / a
 *   recurrent task rather than running it by hand. All inputs are static per
 *   environment, so the schedule carries the whole scope.
 *
 *   MATCH THE WINDOW TO THE SCHEDULE. expiringWithinDays must be at least as long as
 *   the gap between runs, or an account can expire in the gap having never appeared in
 *   an "Expiring" section — it would go straight from Active to Expired between two
 *   reports. A monthly schedule wants 30+; a weekly schedule is safe at 30 and gives
 *   four warnings before the date.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * FAILURE-HANDLING CONTRACT
 * ───────────────────────────────────────────────────────────────────────────
 *   Condition                                              End state
 *   ────────────────────────────────────────────────────── ─────────────────────────
 *   Bad inputs (malformed row, OU without DC=, bad          PS link never reached; action task
 *     recipient, no scope, bad expiringWithinDays)          faults the run
 *   PS host unreachable                                     catch → Throw Error → End (item4) = FAILED
 *   ActiveDirectory module missing on the PS host           script THROWS (S-22) → catch → FAILED
 *   Domain/OU map empty or not valid JSON                   script THROWS (S-22) → catch → FAILED
 *   ONE domain/OU cannot be queried                         "Error:" line → success=false →
 *     (bad DN, dead DC, broken trust)                       Log Failures → End (item7).
 *                                                           Remaining OUs ARE still queried and
 *                                                           the report IS still sent, marked
 *                                                           [INCOMPLETE] with the failure
 *                                                           CLASSIFIED (S-20).
 *   Scope valid but contains no accounts                    "Warn:" → success=true → Log Success.
 *                                                           Empty report sent WITH the OU footnote.
 *   Report file cannot be written to the Debug folder       "Warn:" → the report is still emailed.
 *
 *   Note the deliberate asymmetry, inherited from the admin report: a SCOPE problem
 *   fails the run outright (nothing can be trusted), whereas a PER-OU problem completes
 *   with errors and still delivers a report that says which OUs are missing.
 *
 *   WHY THE THROWS MATTER (S-22). The two FAILED rows above previously did not fail.
 *   A missing AD module logged an "Error:" line and fell through, sending nothing —
 *   indistinguishable from a report with no findings. For an expiration report the
 *   consequence is specific: "no accounts are expiring" and "the query never ran" look
 *   identical in an inbox, and the second one means somebody's service breaks without
 *   warning.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * SCRIPTABLE TASK CODE (as deployed)
 * ───────────────────────────────────────────────────────────────────────────
 */

// ── (item10) Set Log Marker — root element ───────────────────────────────────
// In: (none)  Out: (none)
// workflow.id is the RUN (token) id in vRO — confirmed by run logs showing a per-run
// GUID distinct from the workflow definition id. System.setLogMarker then prepends
// "Workflow:<name>-WorkflowRunId:<run id>" to every subsequent log line.
var logMarker = "Workflow:" + workflow.name + "-WorkflowRunId:" + workflow.id;
System.setLogMarker(logMarker);


// ── (item6) Set Execution Context ────────────────────────────────────────────
// In: domainOUs, expiringWithinDays   Out: executionContext  (string attribute)
//
// WHAT THIS IS: a HUMAN-READABLE LABEL, nothing more. parseScriptOutput takes it as an
// input and uses it in exactly one way — it interpolates it into its own System.log /
// System.warn / System.error lines ("parseScriptOutput | context=… | …"). NOTHING
// branches on it, it is not parsed, and it never affects success/failure or control
// flow. If it were empty the action would substitute "(unknown context)" and behave
// identically.
//
// WHAT IT IS FOR: making those parse lines identifiable when you are reading a log
// containing many runs, or several different report workflows. System.setLogMarker
// (item10) already stamps the workflow name and run id on every line, so this does NOT
// need to repeat either — its job is to say what this run was pointed AT.
//
// The WINDOW is included as well as the scope: two scheduled runs over the same OUs
// with different windows produce different "Expiring" counts, and the transcript should
// say which one this was.
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
    // treating a plain DN as though it were a domain name would report one "domain" per
    // OU and dump the whole DN into every log line.
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

// Bounded: name up to three domains, then a count.
var ctxNamed = ctxDomains.slice(0, 3).join(", ");
if (ctxDomains.length > 3) { ctxNamed += " +" + (ctxDomains.length - 3) + " more"; }
if (ctxDomains.length === 0) { ctxNamed = "(no scope supplied)"; }

var ctxWindow = (expiringWithinDays === null || expiringWithinDays === undefined ||
                 String(expiringWithinDays).trim() === "") ? "30" : String(expiringWithinDays).trim();

executionContext = ctxDomains.length + " domain(s), " + ctxOUCount + " OU(s): " + ctxNamed +
                   " | window " + ctxWindow + "d";

// Production example (one domain, one OU per vars.txt):
//   1 domain(s), 1 OU(s): corp.local | window 30d


// ── (item3) Throw Error — PS link catch path ─────────────────────────────────
// In: err_0   Out: (none) → routes to End (item4), a FAILED end state.
// Reached when the PS host is unreachable OR the script threw: missing ActiveDirectory
// module, or an empty/malformed domain/OU map (both S-22 throws).
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
//
// NOTE: success here means THE SWEEP COMPLETED — not that nothing is expiring. Expired
// and expiring accounts are findings ON the report, not run failures; the workflow must
// not treat "12 accounts expire next week" as an error state, or a scheduled run would
// alarm every time it did its job.
executionSuccess = true;
executionOutput  = parsedResult.get("outputText");

System.log(
    " | Get-ServiceAccountExpirationReport | Completed successfully." +
    " | scope=" + executionContext +
    " | output=" + executionOutput
);


// ── (item9) Log Failures ─────────────────────────────────────────────────────
// In: parsedResult, executionContext   Out: executionSuccess, executionOutput
// "Completed with errors" — NOT a hard failure. One or more OUs could not be queried
// (bad DN, unreachable DC, broken trust). Every OTHER OU was swept and the report was
// still produced and mailed, marked [INCOMPLETE].
//
// TREAT THIS AS UNDER-REPORTING, NOT AS NOISE: the accounts in a failed OU are absent
// from the report, which reads identically to that OU holding nothing that expires.
// An account about to expire in an unread OU is one nobody has been warned about. The
// failing OU is named in errorText below, in the transcript, and on the report itself.
executionSuccess = false;
executionOutput  = "Service account expiration report completed with errors — one or more OUs could not be " +
                   "queried and are MISSING from the report. Accounts in those OUs have NOT been checked for " +
                   "expiry and are not represented in the counts. See the workflow log and the emailed " +
                   "report's scope footnote for details. Error: " + parsedResult.get("errorText");

System.warn(
    " | Get-ServiceAccountExpirationReport | Completed with errors — report is INCOMPLETE." +
    " | scope=" + executionContext +
    " | errorText=" + parsedResult.get("errorText")
);
