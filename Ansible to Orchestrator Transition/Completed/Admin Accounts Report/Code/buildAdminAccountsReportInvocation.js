/**
 * Action: buildAdminAccountsReportInvocation
 * Module:  com.broadcom.pso.vcf.identity.ad.accounts.adminReport
 *
 * vRO input-parameter order (positional call from the workflow):
 *   (scriptPath, domainOUs, emailReport, smtpServer, mailTo, mailCc, mailSubject)
 *
 * Purpose:
 *   Builds the PowerShell invocation string for the MULTI-DOMAIN admin-account
 *   PKI/smartcard compliance REPORT (Get-AllAdmin-Accounts) in cvs_functions.ps1.
 *   The AD queries, the compliant/non-compliant split, the counts folded into the
 *   mail subject, the HTML table and the OU footnote are ALL handled inside the
 *   script - Orchestrator only assembles the scope, passes values through, and
 *   classifies the resulting transcript.
 *
 *   THIS ACTION IS READ-ONLY. It queries Active Directory and emails a report.
 *   Nothing is created, modified or deleted, so there is no whatIf/safety gate.
 *   (Contrast the 'Set-L3-Admin-Accounts' case in the same script, which WRITES
 *   SmartcardLogonRequired - that action is deliberately NOT exposed here.)
 *
 *   What the script does with these values (see Change-Register S-16):
 *     - Parses -DomainOUs into a domain -> OU-list map (Resolve-DomainOUsMap).
 *     - For EVERY OU in EVERY domain, runs two Get-ADUser sweeps at SearchScope
 *       Subtree: SmartcardLogonRequired -eq $true (compliant) and -eq $false
 *       (non-compliant), via Get-ListOfUsers-MultiDomain.
 *     - A domain or OU that cannot be queried is logged as an "Error:" line and the
 *       sweep continues - so the run ends "Completed with Errors" rather than
 *       silently under-reporting.
 *     - Sets the subject to "<mailSubject> ( N Non-Compliance - M Compliance )".
 *     - Emails the HTML table plus a footnote listing every domain/OU queried.
 *
 * ── Input: a flat list of OU distinguishedNames ───────────────────────────────
 *   The operator supplies ONE OU DN PER ROW. Nothing else - no domain column.
 *
 *     OU=Admin Accounts,OU=Servers,DC=domain1,DC=corp,DC=local
 *     OU=Admin Accounts,OU=Workstations,DC=domain1,DC=corp,DC=local
 *     OU=Admin Accounts,OU=Servers,DC=domain2,DC=corp,DC=local
 *
 *   The DOMAIN IS DERIVED from the DN's own DC= components
 *   (DC=domain1,DC=corp,DC=local -> domain1.corp.local), which is the domain the DN
 *   already belongs to by definition. Asking for it separately would be redundant
 *   data entry and, worse, something that can disagree with the DN it sits next to.
 *
 *   Rows are grouped by derived domain, in first-seen order, and encoded as the
 *   JSON map the script expects. Whether the list spans one domain or seven is
 *   therefore not a mode the operator selects - it falls out of the DNs supplied,
 *   and the report sections itself by domain accordingly.
 *
 *   ADVANCED OVERRIDE (rarely needed): a row may be written as
 *   '<server>|<OU DN>' to force the directory server used for that OU, overriding
 *   the derived domain. Use only for a cross-forest search base, a domain alias, or
 *   when a specific DC must be targeted. The pipe form is checked first; everything
 *   after the FIRST '|' is the DN, which never contains a pipe.
 *
 *   The script speaks JSON, matching the Ansible playbook, which used
 *   `{{ var_DomainOUs | to_json }}` to write domain_ous.json to a temp dir and
 *   passed -DomainOUsFile. Orchestrator has NO equivalent staging step - it invokes
 *   a PRE-STAGED script - so the map is built here and passed INLINE via -DomainOUs.
 *   Keeping the form a list of DNs (rather than raw JSON in a text box) means the
 *   scope stays reviewable row-by-row in the request form and the run history, and a
 *   malformed entry is rejected here with a pointed message instead of failing
 *   inside PowerShell.
 *
 * Inputs:
 *   scriptPath   (string)        - Full path to cvs_functions.ps1 on the PS host
 *   domainOUs    (Array/string)  - OU distinguishedNames, one per row (see above) -> -DomainOUs (JSON)
 *   emailReport  (boolean)       - Send the HTML report              -> -eMailReport ('yes'/'no')
 *   smtpServer   (string)        - SMTP relay                        -> -SMTPServer
 *   mailTo       (Array/string)  - Recipients, joined with ','       -> -MailToString
 *   mailCc       (Array/string)  - CC recipients, joined with ','    -> -MailCcString
 *   mailSubject  (string)        - Subject stem; the script appends the counts -> -MailSubjectstring
 *
 * Note: there is no domainName / OUPath input. Before S-16 this action searched ONE
 * domain and ONE OU (-DomainName / -OUPath); it is now driven entirely by the map.
 * The script derives the FROM address itself
 * ($Global:MailFrom = $env:COMPUTERNAME + '_Do_Not_Reply@vcf.lab'), so there is no
 * from-address input either.
 *
 * Return type: string
 */

// ── Input validation ──────────────────────────────────────────────────────────

if (!scriptPath || scriptPath.trim() === "") {
    throw new Error("buildAdminAccountsReportInvocation: scriptPath is required and must not be empty.");
}

// Normalize an Array/string OR a plain/CSV string into an array of trimmed,
// non-empty tokens. Recipient and scope inputs may arrive either way depending on
// how the workflow was built, and a string has no .join()/.length semantics we can
// rely on.
function toTokens(value, splitOn) {
    if (value === null || value === undefined) { return []; }
    var parts;
    if (typeof value === "string") {
        parts = value.split(splitOn);
    } else if (typeof value.join === "function") {   // array-like
        parts = value;
    } else {
        parts = [String(value)];
    }
    var clean = [];
    for (var i = 0; i < parts.length; i++) {
        var p = String(parts[i]).trim();
        if (p !== "") { clean.push(p); }
    }
    return clean;
}

// ── Parse the OU list into an ordered domain -> OU-list map ───────────────────
//
// The scope is the whole point of this report: an OU that is silently dropped is
// indistinguishable from an OU with no non-compliant accounts. Every row is
// therefore validated and a bad row FAILS the run rather than being skipped.

// Derive the DNS domain from a DN's DC= components:
//   OU=Admin Accounts,OU=Servers,DC=domain1,DC=corp,DC=local -> domain1.corp.local
// Handles DN escaping (\, \+ \= etc.) so an escaped character inside a component
// does not truncate it.
function deriveDomain(dn) {
    var parts = [];
    var re = /DC=((?:[^,\\]|\\.)*)/gi;
    var m;
    while ((m = re.exec(dn)) !== null) {
        parts.push(m[1].replace(/\\(.)/g, "$1"));
    }
    return parts.join(".");
}

var scopeRows = toTokens(domainOUs, "\n");
if (scopeRows.length === 0) {
    throw new Error(
        "buildAdminAccountsReportInvocation: domainOUs is required - supply at least one OU " +
        "distinguishedName, e.g. 'OU=Admin Accounts,OU=Servers,DC=domain1,DC=corp,DC=local'."
    );
}

var domainOrder = [];   // preserves first-seen domain order
var ouByDomain  = {};   // domain -> [OU DN, ...]
var totalOUs    = 0;

for (var r = 0; r < scopeRows.length; r++) {
    var row = scopeRows[r];
    var ou, dom, explicitServer = false;

    // Advanced override form '<server>|<OU DN>'. Split on the FIRST '|' only - a DN
    // contains commas and '=' but never a pipe.
    var bar = row.indexOf("|");
    if (bar !== -1) {
        dom = row.substring(0, bar).trim();
        ou  = row.substring(bar + 1).trim();
        explicitServer = true;
        if (dom === "") {
            throw new Error("buildAdminAccountsReportInvocation: domainOUs row " + (r + 1) +
                " uses the '<server>|<OU>' override form but the server is empty ('" + row + "').");
        }
    } else {
        ou = row;
    }

    if (ou === "") {
        throw new Error("buildAdminAccountsReportInvocation: domainOUs row " + (r + 1) + " is empty.");
    }

    // The OU is handed to Get-ADUser -SearchBase, which requires a distinguishedName,
    // and the domain is derived from the same DN - so a DN without DC= components is
    // unusable twice over. This is an error, not a nudge.
    if (ou.toUpperCase().indexOf("DC=") === -1) {
        throw new Error(
            "buildAdminAccountsReportInvocation: domainOUs row " + (r + 1) + " ('" + ou + "') is not an OU " +
            "distinguishedName - it has no 'DC=' component, so neither the search base nor the domain can " +
            "be resolved. Expected the full DN form, e.g. " +
            "'OU=Admin Accounts,OU=Servers,DC=domain1,DC=corp,DC=local'. " +
            "A row consisting of a single character usually means a plain string was bound to an " +
            "Array/string input and vRO split it into characters - bind domainOUs as an Array with one " +
            "DN per element."
        );
    }

    // Sanity-check that it looks like an OU/container DN rather than, say, a user DN
    // pasted by mistake. Warn only - CN= containers and bare domain roots are valid
    // search bases even though they are unusual here.
    if (ou.toUpperCase().indexOf("OU=") === -1) {
        System.warn(
            "buildAdminAccountsReportInvocation | domainOUs row " + (r + 1) + " ('" + ou + "') has no 'OU=' " +
            "component. It is still a valid search base if it is a container or a domain root, but check " +
            "this is the scope you meant - a domain root searches the ENTIRE domain."
        );
    }

    var derived = deriveDomain(ou);
    if (!explicitServer) {
        dom = derived;
    } else if (derived !== "" && derived.toLowerCase() !== dom.toLowerCase()) {
        // The override is being used to point at a different server than the DN's own
        // domain. Legitimate for cross-forest/alias cases, but far more often a slip.
        System.warn(
            "buildAdminAccountsReportInvocation | domainOUs row " + (r + 1) + ": server override '" + dom +
            "' does not match the DN's own domain ('" + derived + "'). The OU will be searched on '" + dom +
            "' as written - confirm this is intended."
        );
    }

    // Group case-insensitively (AD domains are case-insensitive) but keep the first
    // spelling seen, so the report headings read as the operator typed them.
    var key = dom.toLowerCase();
    var bucket = null;
    for (var g = 0; g < domainOrder.length; g++) {
        if (domainOrder[g].toLowerCase() === key) { bucket = domainOrder[g]; break; }
    }
    if (bucket === null) {
        bucket = dom;
        ouByDomain[bucket] = [];
        domainOrder.push(bucket);
    }

    // Drop exact duplicates: a repeated OU would be queried, and reported, twice.
    var dup = false;
    for (var d = 0; d < ouByDomain[bucket].length; d++) {
        if (ouByDomain[bucket][d].toLowerCase() === ou.toLowerCase()) { dup = true; break; }
    }
    if (dup) {
        System.warn(
            "buildAdminAccountsReportInvocation | domainOUs row " + (r + 1) + ": duplicate OU '" + ou +
            "' - ignored (it would otherwise be queried and reported twice)."
        );
        continue;
    }

    // Nested-scope nudge: SearchScope is Subtree, so listing both a parent OU and its
    // child means the child's accounts are returned twice and double-counted in the
    // compliance figures. Cheap to detect here, invisible in the report otherwise.
    for (var n = 0; n < ouByDomain[bucket].length; n++) {
        var other = ouByDomain[bucket][n];
        var a = ou.toLowerCase(), b = other.toLowerCase();
        if (a.length !== b.length && (a.indexOf("," + b) === a.length - b.length - 1 ||
                                      b.indexOf("," + a) === b.length - a.length - 1)) {
            System.warn(
                "buildAdminAccountsReportInvocation | domainOUs row " + (r + 1) + ": '" + ou + "' and '" +
                other + "' are nested. Searches run at Subtree scope, so accounts under the deeper OU will " +
                "be returned TWICE and double-counted. Remove whichever is redundant."
            );
        }
    }

    ouByDomain[bucket].push(ou);
    totalOUs++;
}

// ── Encode the map as JSON ────────────────────────────────────────────────────
//
// Hand-built rather than via JSON.stringify: this string is embedded in a shell
// command and then re-parsed by ConvertFrom-Json on the far side, so the escaping is
// worth making explicit and engine-independent.
//
// Escaping chain, end to end:
//   backslash -> \\ and double-quote -> \"  here (JSON rules);
//   the whole JSON is then wrapped in PowerShell SINGLE quotes by psQuote below,
//   which is a literal string in PowerShell (no backslash or $ expansion), so the
//   JSON reaches ConvertFrom-Json byte-for-byte. A single quote inside a DN (e.g.
//   OU=O'Brien) needs no JSON escape but IS doubled by psQuote for PowerShell.

function jsonQuote(value) {
    var s = String(value === null || value === undefined ? "" : value);
    var out = "";
    for (var i = 0; i < s.length; i++) {
        var c = s.charAt(i);
        var code = s.charCodeAt(i);
        if (c === "\\")      { out += "\\\\"; }
        else if (c === "\"") { out += "\\\""; }
        else if (c === "\n") { out += "\\n"; }
        else if (c === "\r") { out += "\\r"; }
        else if (c === "\t") { out += "\\t"; }
        else if (code < 0x20) {
            var hex = code.toString(16);
            while (hex.length < 4) { hex = "0" + hex; }
            out += "\\u" + hex;
        }
        else { out += c; }
    }
    return "\"" + out + "\"";
}

var jsonParts = [];
for (var i2 = 0; i2 < domainOrder.length; i2++) {
    var dName = domainOrder[i2];
    var ous   = ouByDomain[dName];
    var ouJson = [];
    for (var j = 0; j < ous.length; j++) {
        ouJson.push(jsonQuote(ous[j]));
    }
    jsonParts.push(jsonQuote(dName) + ":[" + ouJson.join(",") + "]");
}
var domainOUsJson = "{" + jsonParts.join(",") + "}";

// ── Mail validation ───────────────────────────────────────────────────────────

var wantsEmail = (emailReport === true);
var toList = toTokens(mailTo, ",").join(",");
var ccList = toTokens(mailCc, ",").join(",");

if (wantsEmail) {
    if (!smtpServer || smtpServer.trim() === "") {
        throw new Error("buildAdminAccountsReportInvocation: smtpServer is required when emailReport is true.");
    }
    if (toList === "") {
        throw new Error("buildAdminAccountsReportInvocation: mailTo must contain at least one recipient when emailReport is true.");
    }
    // Guard against the vRO "scalar string bound to an Array/string input" artifact,
    // which explodes one address into single characters. Every real SMTP recipient
    // contains '@', so a token without one means the list was char-split or mistyped
    // - fail loudly rather than emailing garbage.
    function assertAddresses(csv, inputName) {
        var tokens = csv.split(",");
        for (var k = 0; k < tokens.length; k++) {
            if (tokens[k].indexOf("@") === -1) {
                throw new Error("buildAdminAccountsReportInvocation: " + inputName +
                    " contains an entry with no '@' ('" + tokens[k] + "'). This usually means a single " +
                    "address string was bound to an Array/string input and vRO split it into characters. " +
                    "Bind " + inputName + " as an Array of addresses (one element per recipient), or as a " +
                    "plain/CSV string - not a string fed to an Array parameter.");
            }
        }
    }
    assertAddresses(toList, "mailTo");
    if (ccList !== "") { assertAddresses(ccList, "mailCc"); }
} else {
    // The report has no other delivery channel: with email off the only record is
    // the workflow transcript and PKI_result.html on the PS host.
    System.warn(
        "buildAdminAccountsReportInvocation | emailReport=false - the compliance report will NOT be " +
        "emailed. It is still written to the Debug folder on the PS host and appears in the workflow log."
    );
}

// ── Build invocation string ───────────────────────────────────────────────────
//
// Script parameters confirmed from the cvs_functions.ps1 param block and the
// 'Get-AllAdmin-Accounts' case in Main():
//   -Action             'Get-AllAdmin-Accounts'  (member of the ValidateSet)
//   -DomainOUs          <- domainOUsJson   (Resolve-DomainOUsMap -Json)
//   -eMailReport        <- 'yes' / 'no'
//   -SMTPServer         <- smtpServer
//   -MailToString       <- mailTo joined with ','  (script splits on ',')
//   -MailCcString       <- mailCc joined with ','
//   -MailSubjectstring  <- mailSubject             (script appends " ( N Non-Compliance - M Compliance )")
//
// -DomainOUsFile is deliberately NOT used: it is the legacy Ansible path, where
// win_copy staged domain_ous.json into a temp dir. Orchestrator invokes a pre-staged
// script and has nowhere to write that file, so the map goes inline.

function psQuote(value) {
    return "'" + String(value === null || value === undefined ? "" : value).replace(/'/g, "''") + "'";
}

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
    " -Action 'Get-AllAdmin-Accounts'" +
    " -DomainOUs " + psQuote(domainOUsJson) +
    " -eMailReport '" + (wantsEmail ? "yes" : "no") + "'" +
    " -SMTPServer " + psQuote(smtpServer ? smtpServer.trim() : "") +
    " -MailToString " + psQuote(toList) +
    " -MailCcString " + psQuote(ccList) +
    " -MailSubjectstring " + psQuote(mailSubject ? mailSubject.trim() : "") +
    " *>&1 | Out-String -Width 4096";

System.log(
    "buildAdminAccountsReportInvocation | scriptPath=" + scriptPath +
    " | domains=" + domainOrder.length +
    " | OUs=" + totalOUs +
    " | scope=" + domainOrder.join(", ") +
    " | emailReport=" + wantsEmail +
    " | mailTo=" + toList
);
System.log("buildAdminAccountsReportInvocation | invocationString=" + invocationString);

return invocationString;
