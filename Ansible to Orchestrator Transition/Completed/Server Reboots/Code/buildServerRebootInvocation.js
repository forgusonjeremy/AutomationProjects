/**
 * Action: buildServerRebootInvocation
 * Module:  broadcom.pso.vc.vm.guestOps.windows.reboot
 *
 * Purpose:
 *   Builds the PowerShell invocation string for the Invoke-ServerReboot action in
 *   cvs_functions.ps1.  AD resolution, the pending-reboot check, per-server
 *   iteration, the inter-server delay, post-reboot verification and reporting are
 *   ALL handled inside the script — Orchestrator only passes information through
 *   and classifies the resulting transcript.
 *
 *   What the script does with these values (see Change-Register S-6…S-11):
 *     - Resolves the DIRECT (non-recursive) ENABLED COMPUTER members of the group
 *       via Get-ListOfServers-Direct.  Nested sub-groups are never expanded.
 *     - Runs Get-RebootStatus (remote WMI/registry/SCCM) against each server.
 *     - Reboots ONLY servers reporting PendingReboot = True.  A server whose
 *       pending state cannot be read is skipped and logged as an Error:, never
 *       force-rebooted.
 *     - Issues reboots sequentially with -RebootIt_DelayBetweenServer between each.
 *     - Verifies each rebooted server returns by confirming its LastBootUpTime
 *       advanced, within -RebootIt_VerifyTimeoutSec.
 *     - Builds an HTML report and mails it when -eMailReport is 'yes'.
 *
 * Safety gate:
 *   rebootMode maps to the script's -RebootIt parameter.  'simpleMode' actually
 *   reboots; ANY other value produces a report-only run (pending servers are
 *   detected and reported but NOT rebooted).  'no' is the script default and the
 *   recommended default for the workflow input.
 *
 * Group identity:
 *   Passed to the script as -ADGroupMember, which hands it to Get-ADGroupMember
 *   -Identity.  A distinguishedName (DN) is the preferred, unambiguous form —
 *   e.g. CN=Security-Reboot-Servers,OU=Groups,DC=vcf,DC=lab.  CN /
 *   sAMAccountName / GUID / SID also resolve.
 *
 * Inputs:
 *   scriptPath             (string)       - Full path to cvs_functions.ps1 on the PS host
 *   groupDN                (string)       - AD group DN (preferred) or CN/sAMAccountName/GUID/SID
 *   domainName             (string)       - AD domain, used as -Server target        → -DomainName
 *   rebootMode             (string)       - 'simpleMode' = reboot; anything else = report only → -RebootIt
 *   delayBetweenServersSec (number)       - Seconds between each reboot             → -RebootIt_DelayBetweenServer
 *   verifyTimeoutSec       (number)       - Per-server return budget, e.g. 600       → -RebootIt_VerifyTimeoutSec
 *   verifyPollSec          (number)       - Verification poll cadence, e.g. 15       → -RebootIt_VerifyPollSec
 *   runPreRebootScript     (boolean)      - Run ownership_w2k.ps1 before each reboot → -RebootIt_RunPreRebootScript ('yes'/'no')
 *   emailReport            (boolean)      - Send the HTML report                     → -eMailReport ('yes'/'no')
 *   smtpServer             (string)       - SMTP relay                               → -SMTPServer
 *   mailTo                 (Array/string) - Recipients, joined with ','              → -MailToString
 *   mailCc                 (Array/string) - CC recipients, joined with ','           → -MailCcString
 *   mailSubject            (string)       - Subject stem                             → -MailSubjectstring
 *
 * Note: -HeaderNotesSubstr (the group name shown in the report header) is NOT a
 * separate input. The script only ever uses it as a display label for "which group
 * this report is about", so it is DERIVED from groupDN here (the leftmost CN of a
 * DN, or the identifier as-is if it is already a plain name). This removes a
 * redundant input and guarantees the header can never name a different group than
 * the one actually targeted.
 *
 * Return type: string
 */

// ── Input validation ──────────────────────────────────────────────────────────

if (!scriptPath || scriptPath.trim() === "") {
    throw new Error("buildServerRebootInvocation: scriptPath is required and must not be empty.");
}
if (!groupDN || groupDN.trim() === "") {
    throw new Error("buildServerRebootInvocation: groupDN is required and must not be empty.");
}
if (!domainName || domainName.trim() === "") {
    throw new Error("buildServerRebootInvocation: domainName is required and must not be empty.");
}
if (!rebootMode || rebootMode.trim() === "") {
    throw new Error("buildServerRebootInvocation: rebootMode is required ('simpleMode' to reboot, 'no' for report-only).");
}

// Numeric inputs must be whole numbers — they are cast with [int] inside the script.
function requireWholeNumber(value, name, minimum) {
    if (value === null || value === undefined || String(value).trim() === "") {
        throw new Error("buildServerRebootInvocation: " + name + " is required.");
    }
    var n = parseInt(value, 10);
    if (isNaN(n) || String(n) !== String(value).trim()) {
        throw new Error("buildServerRebootInvocation: " + name +
            " must be a whole number. Received: " + value);
    }
    if (n < minimum) {
        throw new Error("buildServerRebootInvocation: " + name +
            " must be >= " + minimum + ". Received: " + n);
    }
    return n;
}

var delaySec   = requireWholeNumber(delayBetweenServersSec, "delayBetweenServersSec", 0);
var verifySec  = requireWholeNumber(verifyTimeoutSec, "verifyTimeoutSec", 1);
var pollSec    = requireWholeNumber(verifyPollSec, "verifyPollSec", 1);

if (pollSec > verifySec) {
    throw new Error("buildServerRebootInvocation: verifyPollSec (" + pollSec +
        ") must not exceed verifyTimeoutSec (" + verifySec + ") — the server would never be polled.");
}

// Email is opt-in; when on, we must have somewhere to send it.
var wantsEmail = (emailReport === true);
var toList = (mailTo && mailTo.length) ? mailTo.join(",") : "";
var ccList = (mailCc && mailCc.length) ? mailCc.join(",") : "";

if (wantsEmail) {
    if (!smtpServer || smtpServer.trim() === "") {
        throw new Error("buildServerRebootInvocation: smtpServer is required when emailReport is true.");
    }
    if (toList === "") {
        throw new Error("buildServerRebootInvocation: mailTo must contain at least one recipient when emailReport is true.");
    }
}

// Pre-reboot script gate (S-13). Defaults OFF. ownership_w2k.ps1 takes ownership of
// and loosens ACLs on usbstor.inf (USB mass-storage driver INF) and termsrv.dll
// (Terminal Services). Because of the S-6 defect this step never actually ran, so
// enabling it is a security-posture CHANGE — make it loud when it is on.
var runPreScript = (runPreRebootScript === true);
if (runPreScript) {
    System.warn(
        "buildServerRebootInvocation | runPreRebootScript=true — ownership_w2k.ps1 WILL run on every " +
        "server that is rebooted. It takes ownership of and loosens ACLs on usbstor.inf and " +
        "termsrv.dll. Confirm this is security-approved."
    );
}

// Safety-gate nudge: make an actual reboot run unmistakable in the log, and warn
// when the value is neither of the two expected forms (the script treats anything
// that is not 'simpleMode' as report-only, so a typo silently means "do nothing").
var mode = rebootMode.trim();
if (mode === "simpleMode") {
    System.warn(
        "buildServerRebootInvocation | rebootMode='simpleMode' — this run WILL REBOOT " +
        "every direct, enabled member of '" + groupDN.trim() + "' that reports a pending reboot."
    );
} else {
    if (mode !== "no") {
        System.warn(
            "buildServerRebootInvocation | rebootMode='" + mode + "' is not 'simpleMode' or 'no'. " +
            "The script treats any non-'simpleMode' value as report-only, so NO servers will be rebooted."
        );
    }
    System.log("buildServerRebootInvocation | rebootMode='" + mode + "' — report-only run; no servers will be rebooted.");
}

// DN nudge: warn (do not fail) when the identifier does not look like a DN, so
// CN / sAMAccountName still work but operators are steered toward the DN form.
if (groupDN.trim().toUpperCase().indexOf("DC=") === -1) {
    System.warn(
        "buildServerRebootInvocation | groupDN='" + groupDN.trim() +
        "' does not look like a distinguishedName (no 'DC=' component). It will be " +
        "passed to Get-ADGroupMember -Identity as-is, but a full DN is recommended " +
        "for unambiguous group resolution."
    );
}

// ── Build invocation string ───────────────────────────────────────────────────
//
// Script parameters confirmed from the cvs_functions.ps1 param block:
//   -Action                        'Invoke-ServerReboot'  (member of the ValidateSet)
//   -ADGroupMember                 ← groupDN
//   -DomainName                    ← domainName
//   -RebootIt                      ← rebootMode              (safety gate: only 'simpleMode' reboots)
//   -RebootIt_DelayBetweenServer   ← delayBetweenServersSec
//   -RebootIt_VerifyTimeoutSec     ← verifyTimeoutSec        (added by S-10)
//   -RebootIt_VerifyPollSec        ← verifyPollSec           (added by S-10)
//   -eMailReport                   ← 'yes' / 'no'
//   -SMTPServer                    ← smtpServer
//   -MailToString                  ← mailTo joined with ','  (script splits on ',')
//   -MailCcString                  ← mailCc joined with ','
//   -MailSubjectstring             ← mailSubject
//   -HeaderNotesSubstr             ← headerNote
//
// Note: the script derives the FROM address itself
// ($Global:MailFrom = $env:COMPUTERNAME + '_Do_Not_Reply@vcf.lab'), so there is
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
//   - DN form  (CN=Security-Reboot-Servers,OU=Groups,DC=vcf,DC=lab) -> leftmost
//     CN value, with DN escaping (\,) unescaped.
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
    " -Action 'Invoke-ServerReboot'" +
    " -ADGroupMember " + psQuote(groupDN.trim()) +
    " -DomainName " + psQuote(domainName.trim()) +
    " -RebootIt " + psQuote(mode) +
    " -RebootIt_DelayBetweenServer '" + delaySec + "'" +
    " -RebootIt_VerifyTimeoutSec '" + verifySec + "'" +
    " -RebootIt_VerifyPollSec '" + pollSec + "'" +
    " -RebootIt_RunPreRebootScript '" + (runPreScript ? "yes" : "no") + "'" +
    " -eMailReport '" + (wantsEmail ? "yes" : "no") + "'" +
    " -SMTPServer " + psQuote(smtpServer ? smtpServer.trim() : "") +
    " -MailToString " + psQuote(toList) +
    " -MailCcString " + psQuote(ccList) +
    " -MailSubjectstring " + psQuote(mailSubject ? mailSubject.trim() : "") +
    " -HeaderNotesSubstr " + psQuote(headerNote) +   // derived from groupDN, not an input
    " *>&1 | Out-String -Width 4096";

System.log(
    "buildServerRebootInvocation | scriptPath=" + scriptPath +
    " | groupDN=" + groupDN +
    " | domainName=" + domainName +
    " | rebootMode=" + mode +
    " | delayBetweenServersSec=" + delaySec +
    " | verifyTimeoutSec=" + verifySec +
    " | verifyPollSec=" + pollSec +
    " | runPreRebootScript=" + runPreScript +
    " | emailReport=" + wantsEmail +
    " | mailTo=" + toList +
    " | headerNote(derived)=" + headerNote
);
System.log("buildServerRebootInvocation | invocationString=" + invocationString);

return invocationString;
