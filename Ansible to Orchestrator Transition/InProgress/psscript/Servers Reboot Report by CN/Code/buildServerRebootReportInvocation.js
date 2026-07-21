/**
 * Action: buildServerRebootReportInvocation
 * Module:  broadcom.pso.vc.vm.guestOps.windows.servers.reboot
 *
 * Purpose:
 *   Builds the PowerShell invocation string for the read-only pending-reboot
 *   REPORT action (Get-ServerRebootReportStatus-ByCN) in cvs_functions.ps1.
 *   AD group resolution, the remote pending-reboot check, the pending count and
 *   the HTML report/mail are ALL handled inside the script — Orchestrator only
 *   passes values through and classifies the resulting transcript.
 *
 *   THIS ACTION NEVER REBOOTS ANYTHING. It maps to the reporting sibling of
 *   Invoke-ServerReboot: every target server is queried (remote WMI / registry /
 *   SCCM) for its pending-reboot state and listed in the report; no shutdown is
 *   ever issued, so there is no safety gate, no per-server delay and no
 *   post-reboot verification. If you need to actually reboot, use the
 *   Invoke-ServerReboot workflow instead.
 *
 *   What the script does with these values (see Change-Register R-2…R-4):
 *     - Resolves the group with Get-ListOfServers-ByCN -SG_CN, which is
 *       RECURSIVE and returns only ENABLED COMPUTER objects, with per-object
 *       isolation (one unresolvable member is skipped and logged, not fatal).
 *       A group-level failure (group not found / domain unreachable) terminates.
 *     - Runs Get-RebootStatus (remote WMI/registry/SCCM) against each server.
 *     - Counts servers whose PendingReboot is not "False" and folds
 *       "N of M server might required reboot" into the mail subject.
 *     - Builds an HTML report and mails it when -eMailReport is 'yes'.
 *
 * Resolver note (why ByCN, and why recursive is correct HERE):
 *   The original Ansible had two report variants — Get-ServerRebootReportStatus-ByCN
 *   (lab, -SecurityGroup_CN, RECURSIVE) and Get-ServerPendingRebootStatus
 *   (customer prod, -ADGroupMember, LEGACY non-recursive/unfiltered). This vRO
 *   transition standardizes BOTH onto the hardened ByCN action (Change-Register
 *   R-1). Recursion is the right default for a REPORT: it is read-only, so the
 *   only effect of expanding a nested sub-group is a MORE COMPLETE picture of what
 *   needs rebooting — never an unintended action. (Contrast Invoke-ServerReboot,
 *   which deliberately uses a NON-recursive resolver because rebooting is
 *   destructive and targets must be explicit — Server Reboots change S-7 / P-11.)
 *   Both hardened resolvers apply the same computer-class + Enabled filter and
 *   per-object isolation; they differ ONLY on recursion.
 *
 * Group identity:
 *   Passed to the script as -SecurityGroup_CN, which hands it to
 *   Get-ADGroupMember -Identity. A distinguishedName (DN) is the preferred,
 *   unambiguous form — e.g. CN=Monitoring-Servers,OU=Groups,DC=corp,DC=local.
 *   CN / sAMAccountName / GUID / SID also resolve. Note: -SecurityGroup_CN is a
 *   PARAMETER NAME only; it does not require a bare CN — pass the full DN.
 *
 * Inputs:
 *   scriptPath   (string)        - Full path to cvs_functions.ps1 on the PS host
 *   groupDN      (string)        - AD group DN (preferred) or CN/sAMAccountName/GUID/SID → -SecurityGroup_CN
 *   domainName   (string)        - AD domain, used as -Server target                    → -DomainName
 *   emailReport  (boolean)       - Send the HTML report                                 → -eMailReport ('yes'/'no')
 *   smtpServer   (string)        - SMTP relay                                           → -SMTPServer
 *   mailTo       (Array/string)  - Recipients, joined with ','                          → -MailToString
 *   mailCc       (Array/string)  - CC recipients, joined with ','                       → -MailCcString
 *   mailSubject  (string)        - Subject stem (script appends the pending count)      → -MailSubjectstring
 *
 * Note: -HeaderNotesSubstr (the group name shown in the report header) is NOT a
 * separate input. The script only ever uses it as a display label ("The list of
 * servers were base on the security group called X"), so it is DERIVED from
 * groupDN here (the leftmost CN of a DN, or the identifier as-is if it is already
 * a plain name). This removes a redundant input and guarantees the header can
 * never name a different group than the one actually targeted.
 *
 * Return type: string
 */

// ── Input validation ──────────────────────────────────────────────────────────

if (!scriptPath || scriptPath.trim() === "") {
    throw new Error("buildServerRebootReportInvocation: scriptPath is required and must not be empty.");
}
if (!groupDN || groupDN.trim() === "") {
    throw new Error("buildServerRebootReportInvocation: groupDN is required and must not be empty.");
}
// domainName is required: Get-ListOfServers-ByCN always passes -Server $DomainName
// to Get-ADGroupMember/Get-ADComputer, so an empty value would fail resolution.
if (!domainName || domainName.trim() === "") {
    throw new Error("buildServerRebootReportInvocation: domainName is required and must not be empty.");
}

// Recipient inputs may arrive as an Array (input typed Array/string) OR as a
// single/CSV string (input typed string) depending on how the workflow was built.
// A string has no .join(), so normalize either form to a clean comma-separated
// string: split on commas, trim each address, drop blanks, rejoin. The script
// splits -MailToString / -MailCcString back on ','.
function toCsv(value) {
    if (value === null || value === undefined) { return ""; }
    var parts;
    if (typeof value === "string") {
        parts = value.split(",");
    } else if (typeof value.join === "function") {   // array-like (has join)
        parts = value;
    } else {
        parts = [String(value)];
    }
    var clean = [];
    for (var i = 0; i < parts.length; i++) {
        var p = String(parts[i]).trim();
        if (p !== "") { clean.push(p); }
    }
    return clean.join(",");
}

// Email is opt-in; when on, we must have somewhere to send it.
var wantsEmail = (emailReport === true);
var toList = toCsv(mailTo);
var ccList = toCsv(mailCc);

if (wantsEmail) {
    if (!smtpServer || smtpServer.trim() === "") {
        throw new Error("buildServerRebootReportInvocation: smtpServer is required when emailReport is true.");
    }
    if (toList === "") {
        throw new Error("buildServerRebootReportInvocation: mailTo must contain at least one recipient when emailReport is true.");
    }
    // Guard against the vRO "scalar string bound to an Array/string input" artifact,
    // which explodes one address into single characters (mailTo becomes
    // ['j','f','o',...] → -MailToString 'j,f,o,...'). Every real SMTP recipient
    // contains '@', so a token without one means the recipient list was char-split
    // or mistyped — fail loudly here rather than emailing garbage. Applies to To
    // (and Cc when present); fix by binding recipients as an Array of addresses
    // (one element each) or as a plain/CSV string, not a string fed to an Array.
    function assertAddresses(csv, inputName) {
        var tokens = csv.split(",");
        for (var i = 0; i < tokens.length; i++) {
            if (tokens[i].indexOf("@") === -1) {
                throw new Error("buildServerRebootReportInvocation: " + inputName +
                    " contains an entry with no '@' ('" + tokens[i] + "'). This usually means a single " +
                    "address string was bound to an Array/string input and vRO split it into characters. " +
                    "Bind " + inputName + " as an Array of addresses (one element per recipient), or as a " +
                    "plain/CSV string — not a string fed to an Array parameter.");
            }
        }
    }
    assertAddresses(toList, "mailTo");
    if (ccList !== "") { assertAddresses(ccList, "mailCc"); }
}

// DN nudge: warn (do not fail) when the identifier does not look like a DN, so
// CN / sAMAccountName still work but operators are steered toward the DN form.
if (groupDN.trim().toUpperCase().indexOf("DC=") === -1) {
    System.warn(
        "buildServerRebootReportInvocation | groupDN='" + groupDN.trim() +
        "' does not look like a distinguishedName (no 'DC=' component). It will be " +
        "passed to Get-ADGroupMember -Identity as-is, but a full DN is recommended " +
        "for unambiguous group resolution."
    );
}

// ── Build invocation string ───────────────────────────────────────────────────
//
// Script parameters confirmed from the cvs_functions.ps1 param block and the
// 'Get-ServerRebootReportStatus-ByCN' case in Main():
//   -Action              'Get-ServerRebootReportStatus-ByCN'  (member of the ValidateSet)
//   -SecurityGroup_CN    ← groupDN     (Main passes this to Get-ListOfServers-ByCN -SG_CN)
//   -DomainName          ← domainName
//   -eMailReport         ← 'yes' / 'no'
//   -SMTPServer          ← smtpServer
//   -MailToString        ← mailTo joined with ','  (script splits on ',')
//   -MailCcString        ← mailCc joined with ','
//   -MailSubjectstring   ← mailSubject             (script appends " - N of M ...")
//   -HeaderNotesSubstr   ← headerNote              (derived from groupDN below)
//
// Note: the script derives the FROM address itself
// ($Global:MailFrom = $env:COMPUTERNAME + '_Do_Not_Reply@corp.local'), so there is
// no from-address input to pass.
//
// Single-quote escaping: PowerShell escapes a single quote inside a single-quoted
// string by doubling it. A DN or subject containing an apostrophe (e.g.
// OU=O'Brien) would otherwise terminate the string early and corrupt the command.
function psQuote(value) {
    return "'" + String(value === null || value === undefined ? "" : value).replace(/'/g, "''") + "'";
}

// Derive the report-header group name from the group identifier. The script's
// -HeaderNotesSubstr is purely a display label ("the security group called X"), so
// there is no reason to ask for it separately.
//   - DN form  (CN=Monitoring-Servers,OU=Groups,DC=corp,DC=local) -> leftmost CN
//     value, with DN escaping (\,) unescaped.
//   - Plain form (CN / sAMAccountName / GUID / SID) -> used as-is.
function deriveGroupName(identifier) {
    var id = String(identifier === null || identifier === undefined ? "" : identifier).trim();
    if (id === "") { return ""; }
    // First RDN of a DN: CN=<value> up to the first UNescaped comma.
    var m = id.match(/CN=((?:[^,\\]|\\.)*)/i);
    if (m && m[1]) {
        return m[1].replace(/\\(.)/g, "$1"); // turn \, \+ etc. back into literals
    }
    return id;
}

var headerNote = deriveGroupName(groupDN);

// Stream capture ( *>&1 | Out-String -Width 4096 ):
//   cvs_functions.ps1 emits everything through Write-Log -> Write-Host and
//   Write-Warning. The vRO PowerShell plugin only returns the SUCCESS (pipeline)
//   stream via getRootObject(); Write-Host output is logged but NOT returned, so
//   without this redirect the OOTB "Invoke a PowerShell script" workflow hands back
//   a null output object and parseScriptOutput has nothing to parse. '*>&1' merges
//   all streams into the success stream and 'Out-String' collapses them to a single
//   multi-line string. '-Width 4096' prevents wrapping at the default ~80 cols,
//   which would split a long "Error:" line and truncate parseScriptOutput's scan.

var invocationString =
    "& \"" + scriptPath.trim() + "\"" +
    " -Action 'Get-ServerRebootReportStatus-ByCN'" +
    " -SecurityGroup_CN " + psQuote(groupDN.trim()) +
    " -DomainName " + psQuote(domainName.trim()) +
    " -eMailReport '" + (wantsEmail ? "yes" : "no") + "'" +
    " -SMTPServer " + psQuote(smtpServer ? smtpServer.trim() : "") +
    " -MailToString " + psQuote(toList) +
    " -MailCcString " + psQuote(ccList) +
    " -MailSubjectstring " + psQuote(mailSubject ? mailSubject.trim() : "") +
    " -HeaderNotesSubstr " + psQuote(headerNote) +   // derived from groupDN, not an input
    " *>&1 | Out-String -Width 4096";

System.log(
    "buildServerRebootReportInvocation | scriptPath=" + scriptPath +
    " | groupDN=" + groupDN +
    " | domainName=" + domainName +
    " | emailReport=" + wantsEmail +
    " | mailTo=" + toList +
    " | headerNote(derived)=" + headerNote
);
System.log("buildServerRebootReportInvocation | invocationString=" + invocationString);

return invocationString;
