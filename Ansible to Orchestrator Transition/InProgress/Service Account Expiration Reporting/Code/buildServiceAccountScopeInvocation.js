/**
 * Action: buildServiceAccountScopeInvocation
 * Module:  com.broadcom.pso.vcf.identity.ad.accounts.serviceAccountExpiry
 *
 * vRO input-parameter order (positional call from the workflow):
 *   (scriptPath, domain, ouPath, adGroup, emailReport, smtpServer, mailTo, mailCc, mailSubject)
 *
 * Purpose:
 *   Builds the PowerShell invocation for ONE scope of the Service Account Expiration
 *   report. The workflow calls this once per scope, each against the psHost object whose
 *   identity belongs to that scope's domain.
 *
 *   ONE workflow replaces BOTH job templates:
 *
 *     service_accounts_report.yml          -Action Get-ServiceAccountExpiration
 *                                          -DomainName subdom6.company.net
 *                                          -OUPath 'OU=Service Accounts,DC=subdom6,...'
 *     service_accounts_reports_connect.yml -Action Get-ServiceAccountExpiration-ByGroup
 *                                          -DomainName subdomain8.net
 *                                          -ADGroupMember SVC-Accounts
 *
 * ── NO POWERSHELL CHANGES ARE REQUIRED ────────────────────────────────────────
 *   This is the whole point of the design. cvs_function_formatted_email.ps1 - the script
 *   the customer already runs - implements BOTH actions:
 *
 *     'Get-ServiceAccountExpiration'          -> Get-ListOfUsers      (line 1036)
 *     'Get-ServiceAccountExpiration-ByGroup'  -> Get-ListOfUsers-ByGroup (line 1054)
 *
 *   So the consolidation needs no new script, no scope map and no credential injection: one
 *   Resource Element, one psHost per domain identity, two invocations. Nothing to refactor
 *   and nothing new for the team taking this on to learn beyond Orchestrator itself.
 *
 *   S-30 (cvs_svcaccounts.ps1) is therefore NOT a prerequisite. It remains specified in
 *   06_Consolidation-Design.md as the way to get ONE email instead of two, if that is
 *   wanted later. The trade is stated there; nothing in this action blocks it.
 *
 *   The duplicate script retires. cvs_function_formatted_email_washdc.ps1 differs from
 *   cvs_function_formatted_email.ps1 in three lines - an -Action ValidateSet missing
 *   '-ByGroup', and two default mail addresses both templates override anyway - so the
 *   connect copy covers both scopes and the washdc copy is not staged at all.
 *
 *   THIS ACTION IS READ-ONLY. The script queries Active Directory and emails a report; it
 *   does not renew, extend, unlock or disable anything it reports on.
 *
 * ── One scope, one identity, one psHost ───────────────────────────────────────
 *   cvs_function_formatted_email.ps1 contains NO uses of -Credential: every Get-ADUser and
 *   Get-ADGroupMember runs as the ambient identity of the PowerShell session. AAP varied
 *   that identity per job template - the two templates authenticate as accounts in
 *   different domains - which is precisely what P-52 restores by binding one
 *   PowerShellHost object per domain identity and resolving it per scope.
 *
 *   That is why this action takes ONE domain. A scope is one domain, one selector, one
 *   identity, one invocation.
 *
 * Inputs:
 *   scriptPath  (string)        - cvs_function_formatted_email.ps1 on the PS host, as staged
 *   domain      (string)        - the domain to query          -> -DomainName
 *   ouPath      (string)        - OU distinguishedName          -> -OUPath          (OU form)
 *   adGroup     (string)        - group sAMAccountName/CN/DN    -> -ADGroupMember   (group form)
 *   emailReport (boolean)       -> -eMailReport
 *   smtpServer  (string)        -> -SMTPServer
 *   mailTo      (Array/string)  -> -MailToString (joined with ',')
 *   mailCc      (Array/string)  -> -MailCcString
 *   mailSubject (string)        -> -MailSubjectstring
 *
 * Return type: string
 */

if (!scriptPath || String(scriptPath).trim() === "") {
    throw new Error("buildServiceAccountScopeInvocation: scriptPath is required and must not be empty.");
}
if (!domain || String(domain).trim() === "") {
    throw new Error(
        "buildServiceAccountScopeInvocation: domain is required. It becomes -DomainName, which every AD call " +
        "in the script passes as -Server."
    );
}

var dom = String(domain).trim();
if (dom.indexOf(".") === -1) {
    System.warn(
        "buildServiceAccountScopeInvocation | domain '" + dom + "' is not a dotted DNS domain name. It is " +
        "passed to -Server as written; confirm this is the domain you meant."
    );
}

function toTokens(value, splitOn) {
    if (value === null || value === undefined) { return []; }
    var parts;
    if (typeof value === "string") { parts = value.split(splitOn); }
    else if (typeof value.join === "function") { parts = value; }
    else { parts = [String(value)]; }
    var clean = [];
    for (var i = 0; i < parts.length; i++) {
        var p = String(parts[i]).trim();
        if (p !== "") { clean.push(p); }
    }
    return clean;
}

function deriveDomain(dn) {
    var parts = [];
    var re = /DC=((?:[^,\\]|\\.)*)/gi;
    var m;
    while ((m = re.exec(dn)) !== null) { parts.push(m[1].replace(/\\(.)/g, "$1")); }
    return parts.join(".");
}

// ── Selector: exactly one ─────────────────────────────────────────────────────
//
// The two selectors are two different -Action values, not two filters that combine. Passing
// both would mean one of them is silently ignored - and since each names a completely
// different population, the report would cover an estate nobody asked for.

var ou    = (ouPath  === null || ouPath  === undefined) ? "" : String(ouPath).trim();
var group = (adGroup === null || adGroup === undefined) ? "" : String(adGroup).trim();

if (ou === "" && group === "") {
    throw new Error(
        "buildServiceAccountScopeInvocation: give either ouPath or adGroup for '" + dom + "'. With neither, " +
        "the script has nothing to search and this scope would contribute nothing to the report."
    );
}
if (ou !== "" && group !== "") {
    throw new Error(
        "buildServiceAccountScopeInvocation: ouPath ('" + ou + "') and adGroup ('" + group + "') were both " +
        "supplied for '" + dom + "'. They select the script's -Action, not a combined filter, so one would be " +
        "ignored. Split them into two scopes - the workflow runs one invocation per scope."
    );
}

var action;
if (ou !== "") {
    action = "Get-ServiceAccountExpiration";

    if (ou.toUpperCase().indexOf("DC=") === -1) {
        throw new Error(
            "buildServiceAccountScopeInvocation: ouPath '" + ou + "' is not a distinguishedName - it has no " +
            "'DC=' component, so it cannot be used as a Get-ADUser -SearchBase. Expected the full DN form, " +
            "e.g. 'OU=Service Accounts,DC=subdom6,DC=company,DC=net'."
        );
    }

    // The DN must live in the domain it is queried against. Get-ListOfUsers calls
    // 'Get-ADUser -Server $DomainName -SearchBase $OUPath', so a DN whose DC= components
    // name a different domain is a search base that server cannot resolve: the query fails
    // and the scope is silently missing from the report. The script has no error-row model
    // and the playbook never checked rc, so nothing else catches this.
    var dnDomain = deriveDomain(ou);
    if (dnDomain !== "" && dnDomain.toLowerCase() !== dom.toLowerCase()) {
        throw new Error(
            "buildServiceAccountScopeInvocation: domain is '" + dom + "' but ouPath belongs to '" + dnDomain +
            "' ('" + ou + "'). The OU is searched with '-Server " + dom + " -SearchBase <DN>', so that server " +
            "cannot resolve this search base: the query fails and this scope is missing from the report. " +
            "Correct whichever of the two is wrong - they must name the same domain."
        );
    }
    if (ou.toUpperCase().indexOf("OU=") === -1) {
        System.warn(
            "buildServiceAccountScopeInvocation | ouPath '" + ou + "' has no 'OU=' component. Valid as a " +
            "search base if it is a container or the domain root, but a domain root reports on EVERY user " +
            "account in the domain, not just service accounts."
        );
    }
} else {
    action = "Get-ServiceAccountExpiration-ByGroup";

    // Only cvs_function_formatted_email.ps1 has this action in its ValidateSet; the washdc
    // copy does not. Staging the wrong copy fails inside PowerShell with a parameter
    // validation error rather than doing something subtle - but say so here, because the
    // message PowerShell produces does not mention which file it came from.
    System.log(
        "buildServiceAccountScopeInvocation | group form requires cvs_function_formatted_email.ps1 - the " +
        "'_washdc' copy omits 'Get-ServiceAccountExpiration-ByGroup' from its -Action ValidateSet and will " +
        "reject this invocation."
    );

    if (group.toUpperCase().indexOf("DC=") !== -1) {
        var gDomain = deriveDomain(group);
        if (gDomain !== "" && gDomain.toLowerCase() !== dom.toLowerCase()) {
            throw new Error(
                "buildServiceAccountScopeInvocation: domain is '" + dom + "' but adGroup DN belongs to '" +
                gDomain + "' ('" + group + "'). Get-ADGroupMember runs with '-Server " + dom + "' and cannot " +
                "resolve a group in another domain. Give this group its own scope, under its own domain."
            );
        }
    }
}

// ── Mail validation ───────────────────────────────────────────────────────────

var wantsEmail = (emailReport === true);
var toList = toTokens(mailTo, ",").join(",");
var ccList = toTokens(mailCc, ",").join(",");

if (wantsEmail) {
    if (!smtpServer || String(smtpServer).trim() === "") {
        throw new Error("buildServiceAccountScopeInvocation: smtpServer is required when emailReport is true.");
    }
    if (toList === "") {
        throw new Error("buildServiceAccountScopeInvocation: mailTo must contain at least one recipient when emailReport is true.");
    }
    // Guard against the vRO "scalar string bound to an Array/string input" artifact, which
    // explodes one address into single characters. Every real recipient contains '@'.
    function assertAddresses(csv, inputName) {
        var tokens = csv.split(",");
        for (var k = 0; k < tokens.length; k++) {
            if (tokens[k].indexOf("@") === -1) {
                throw new Error("buildServiceAccountScopeInvocation: " + inputName + " contains an entry with " +
                    "no '@' ('" + tokens[k] + "'). This usually means a single address string was bound to an " +
                    "Array/string input and vRO split it into characters. Bind " + inputName + " as an Array " +
                    "of addresses, or as a plain/CSV string - not a string fed to an Array parameter.");
            }
        }
    }
    assertAddresses(toList, "mailTo");
    if (ccList !== "") { assertAddresses(ccList, "mailCc"); }
} else {
    System.warn(
        "buildServiceAccountScopeInvocation | emailReport=false - this scope's report will NOT be emailed. It " +
        "is still written to ServiceAccountExpiration_result.html in the script's debug folder and summarised " +
        "in the workflow log. Nobody will be warned about an expiring account by this run."
    );
}

// One email per scope, so the subject must say which scope it covers. Both templates
// currently send the identical subject 'Ansible-Report: Service Account Expiration Report',
// which is why the two reports are indistinguishable in an inbox today. Appending the scope
// costs nothing and fixes that without touching the script.
var subject = mailSubject ? String(mailSubject).trim() : "Service Account Expiration Report";
subject = subject + " (" + dom + ")";

// ── Build the invocation string ───────────────────────────────────────────────
//
// Parameters confirmed against the cvs_function_formatted_email.ps1 param block (lines
// 1-52) and the two Main() cases. Every one already exists - nothing here asks the script
// to change.
//
// -HeaderNotesSubstr is not passed: it is commented out in both job templates and never set.

function psQuote(value) {
    return "'" + String(value === null || value === undefined ? "" : value).replace(/'/g, "''") + "'";
}

var invocationString =
    "& \"" + String(scriptPath).trim() + "\"" +
    " -Action '" + action + "'" +
    " -DomainName " + psQuote(dom) +
    (ou !== "" ? " -OUPath " + psQuote(ou) : " -ADGroupMember " + psQuote(group)) +
    " -eMailReport '" + (wantsEmail ? "yes" : "no") + "'" +
    " -SMTPServer " + psQuote(smtpServer ? String(smtpServer).trim() : "") +
    " -MailToString " + psQuote(toList) +
    " -MailCcString " + psQuote(ccList) +
    " -MailSubjectstring " + psQuote(subject) +
    // Stream capture: the script reports through Write-Log -> Write-Host. The vRO PowerShell
    // plug-in returns only the SUCCESS stream, so without '*>&1' the transcript comes back
    // empty and parseScriptOutput has nothing to classify. '-Width 4096' stops the default
    // ~80-column wrap splitting a long 'Error:' line mid-scan.
    " *>&1 | Out-String -Width 4096";

System.log(
    "buildServiceAccountScopeInvocation | scriptPath=" + scriptPath +
    " | domain=" + dom +
    " | action=" + action +
    " | selector=" + (ou !== "" ? "ou=" + ou : "group=" + group) +
    " | emailReport=" + wantsEmail +
    " | mailTo=" + toList +
    " | subject=" + subject
);
System.log("buildServiceAccountScopeInvocation | invocationString=" + invocationString);

return invocationString;
