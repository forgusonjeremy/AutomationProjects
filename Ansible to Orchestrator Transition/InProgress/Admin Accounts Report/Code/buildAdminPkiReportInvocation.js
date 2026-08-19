/**
 * Action: buildAdminPkiReportInvocation
 * Module:  com.broadcom.pso.vcf.identity.ad.accounts.adminReport
 *
 * vRO input-parameter order (positional call from the workflow):
 *   (scriptPath, domains, ouTemplates, defaultCredentialKey, includeDisabled,
 *    failOnQueryError, reportTitle, emailReport, smtpServer, mailTo, mailCc, mailSubject)
 *
 * Purpose:
 *   Builds the PowerShell invocation for the consolidated Admin Account PKI/smartcard
 *   compliance report. ONE workflow replaces BOTH job templates:
 *
 *     admin_accounts_report-v2.yml -> cvs_functions-v2.ps1 -Action Get-AllAdmin-Accounts
 *     cvs_admin.yml                -> cvs_admin.ps1        -Action Get-AllAdmin-Accounts
 *
 *   REPLACES buildAdminAccountsReportInvocation (P-55, P-57), which targeted
 *   cvs_functions.ps1 carrying proposed changes S-16..S-21 - a script generation the
 *   customer had already moved past.
 *
 *   NO POWERSHELL CHANGES ARE REQUIRED. Every parameter below already exists in
 *   cvs_admin.ps1 as the customer runs it today. The script is copied to the host from a
 *   Resource Element by stageScriptOnHost and invoked unmodified. That is deliberate: the
 *   team taking this on maintains the Ansible estate, and they should have to learn
 *   Orchestrator, not Orchestrator plus a refactored script.
 *
 * ── Why v3 (cvs_admin.ps1) is the baseline ────────────────────────────────────
 *   Not a preference - a consequence of consolidating. Both templates run the same scope
 *   for subdom1-7 with the same recipients and the same subject, so the distribution list
 *   currently receives two near-duplicate reports. v3 additionally covers rootdomain.net,
 *   and rootdomain.net is the one domain carrying a per-domain credential. v2 has NO
 *   credential handling of any kind, so a single workflow built on v2 could not reach it.
 *   v3 is otherwise a strict superset: department filters, -IncludeDisabled,
 *   -FailOnQueryError, -ReportTitle, per-OU error rows, de-duplication across overlapping
 *   search bases, and a report that separates compliant from non-compliant.
 *
 *   v2 retires with this workflow (P-57).
 *
 *   THIS ACTION IS READ-ONLY. It queries Active Directory and emails a report. Nothing is
 *   created, modified or deleted, so there is no whatIf gate. (The 'Set-L3-Admin-Accounts'
 *   case in cvs_functions*.ps1 WRITES SmartcardLogonRequired; cvs_admin.ps1 does not
 *   implement it, and it is deliberately not exposed here.)
 *
 * ── The scope model ───────────────────────────────────────────────────────────
 *   ONE ROW PER DOMAIN. Everything about a domain sits on its own row, so the scope stays
 *   reviewable line-by-line in the request form and the run history:
 *
 *     subdom1.company.net
 *     subdom6.company.net | ou=OU=GITM VG,OU=Admin Accounts,...,DC=subdom6,DC=company,DC=net
 *                         | ou=OU=Admin Accounts,OU=ESOC,OU=M,OU=IRM,DC=subdom6,DC=company,DC=net
 *     rootdomain.net      | ou=OU=Administrators,OU=T1,...,DC=rootdomain,DC=net
 *                         | dept=DT/EI/IM/CVS | cred=rootdomain
 *
 *     ou=<DN>     Explicit search base. REPEATABLE. Any ou= on a row means ouTemplates is
 *                 not applied to that domain.
 *     dept=<val>  Department filter. REPEATABLE, matched with -like so wildcards work. An
 *                 account with an empty Department never matches.
 *     cred=<key>  Credential key -> AD_CRED_<KEY>_USER / _PASS in the host's environment.
 *                 Omit to use the psHost identity for that domain.
 *
 *   A DN contains ',' and '=' but never '|', which is why '|' separates modifiers and only
 *   the FIRST '=' in a modifier is the delimiter.
 *
 *   ouTemplates supplies the OUs for every domain with no explicit ou=, __DC__ replaced by
 *   that domain's own DC= components - the mechanism of var_ou_templates
 *   (cvs_admin.yml:19-30), and why 7 domains x 2 OUs is 2 rows rather than 14 DNs.
 *
 * Inputs:
 *   scriptPath           (string)        - cvs_admin.ps1 on the PS host, as staged
 *   domains              (Array/string)  - one row per domain          -> -DomainOUs (JSON)
 *   ouTemplates          (Array/string)  - __DC__ templates
 *   defaultCredentialKey (string)        -> -DefaultCredentialKey
 *   includeDisabled      (boolean)       -> -IncludeDisabled
 *   failOnQueryError     (boolean)       -> -FailOnQueryError
 *   reportTitle          (string)        -> -ReportTitle
 *   emailReport          (boolean)       -> -eMailReport
 *   smtpServer           (string)        -> -SMTPServer
 *   mailTo               (Array/string)  -> -MailToString (joined with ',')
 *   mailCc               (Array/string)  -> -MailCcString
 *   mailSubject          (string)        -> -MailSubjectstring; the script appends the counts
 *
 * Return type: string
 */

if (!scriptPath || String(scriptPath).trim() === "") {
    throw new Error("buildAdminPkiReportInvocation: scriptPath is required and must not be empty.");
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

// Derive the DNS domain from a DN's DC= components, honouring DN escaping (\, \+ \=).
function deriveDomain(dn) {
    var parts = [];
    var re = /DC=((?:[^,\\]|\\.)*)/gi;
    var m;
    while ((m = re.exec(dn)) !== null) { parts.push(m[1].replace(/\\(.)/g, "$1")); }
    return parts.join(".");
}

function domainToDC(domain) {
    var labels = domain.split(".");
    var out = [];
    for (var i = 0; i < labels.length; i++) { out.push("DC=" + labels[i]); }
    return out.join(",");
}

// ── OU templates ──────────────────────────────────────────────────────────────

var templates = toTokens(ouTemplates, "\n");
for (var t = 0; t < templates.length; t++) {
    if (templates[t].indexOf("__DC__") === -1) {
        throw new Error(
            "buildAdminPkiReportInvocation: ouTemplates row " + (t + 1) + " ('" + templates[t] + "') contains " +
            "no '__DC__' placeholder, so it would be applied to every domain as the SAME literal DN - which " +
            "can belong to at most one of them. End the template with '__DC__', e.g. " +
            "'OU=Admin Accounts,OU=Data Offshoring,OU=GITM-U,__DC__'."
        );
    }
}

// ── Parse the domain rows ─────────────────────────────────────────────────────
//
// The scope IS the report: an OU silently dropped is indistinguishable from an OU with no
// non-compliant accounts, and a domain silently dropped is a whole population nobody hears
// about. Every row is validated; a bad row fails the run rather than being skipped.

var domainRows = toTokens(domains, "\n");
if (domainRows.length === 0) {
    throw new Error(
        "buildAdminPkiReportInvocation: domains is required - supply at least one row, e.g. " +
        "'subdom1.company.net' or 'rootdomain.net | ou=OU=Administrators,DC=rootdomain,DC=net | cred=rootdomain'."
    );
}

var domainOrder = [];
var scope       = {};
var totalOUs    = 0;

for (var r = 0; r < domainRows.length; r++) {
    var segments = domainRows[r].split("|");
    var domain   = segments[0].trim();

    if (domain === "") {
        throw new Error("buildAdminPkiReportInvocation: domains row " + (r + 1) + " has no domain name before the first '|'.");
    }
    // A single-character row is the signature of a plain string bound to an Array/string
    // input, which vRO splits into characters.
    if (domain.length === 1) {
        throw new Error(
            "buildAdminPkiReportInvocation: domains row " + (r + 1) + " is the single character '" + domain +
            "'. This means a plain string was bound to an Array/string input and vRO split it into " +
            "characters. Bind domains as an Array with one DOMAIN ROW per element."
        );
    }
    if (domain.indexOf(".") === -1) {
        System.warn(
            "buildAdminPkiReportInvocation | domains row " + (r + 1) + ": '" + domain + "' is not a dotted DNS " +
            "domain name. It is passed to Get-ADUser -Server as written; confirm this is the domain you meant."
        );
    }

    var key = domain.toLowerCase();
    for (var seen = 0; seen < domainOrder.length; seen++) {
        if (domainOrder[seen].toLowerCase() === key) {
            throw new Error(
                "buildAdminPkiReportInvocation: domain '" + domain + "' is listed twice (rows " + (seen + 1) +
                " and " + (r + 1) + "). The scope is a map keyed by domain, so the second entry would replace " +
                "the first and its OUs would never be queried. Combine them into one row: '" + domain +
                " | ou=<DN> | ou=<DN>'."
            );
        }
    }

    var entry = { ous: [], departments: [], credential: "" };

    for (var s = 1; s < segments.length; s++) {
        var mod = segments[s].trim();
        if (mod === "") { continue; }

        var eq = mod.indexOf("=");   // FIRST '=' only - DNs are full of them
        if (eq === -1) {
            throw new Error(
                "buildAdminPkiReportInvocation: domains row " + (r + 1) + " modifier '" + mod + "' is not in " +
                "'key=value' form. Valid keys: ou=, dept=, cred=."
            );
        }
        var mk = mod.substring(0, eq).trim().toLowerCase();
        var mv = mod.substring(eq + 1).trim();
        if (mv === "") {
            throw new Error("buildAdminPkiReportInvocation: domains row " + (r + 1) + " modifier '" + mk + "=' has an empty value.");
        }

        if (mk === "ou") {
            if (mv.toUpperCase().indexOf("DC=") === -1) {
                throw new Error(
                    "buildAdminPkiReportInvocation: domains row " + (r + 1) + " ou='" + mv + "' is not a " +
                    "distinguishedName - it has no 'DC=' component, so it cannot be used as a Get-ADUser " +
                    "-SearchBase. Expected the full DN form, e.g. " +
                    "'OU=Admin Accounts,OU=Data Offshoring,OU=GITM-U,DC=subdom1,DC=company,DC=net'."
                );
            }

            // The DN must live in the domain it is filed under. The query runs as
            // '-Server <domain> -SearchBase <DN>', so a DN whose DC= components name a
            // DIFFERENT domain is not a narrower search - it is a search base that server
            // cannot resolve. The query fails, cvs_admin.ps1 records an error row, and with
            // -FailOnQueryError 'no' the report is mailed looking complete.
            //
            // Kept after P-60 was resolved (.net is correct; .com was a transcription
            // artefact) because v3 GENERATES the DN from the domain name for any domain
            // without an explicit ou=, so this mismatch mis-targets silently. It is the one
            // error here that produces a plausible-looking report rather than a failure.
            var dnDomain = deriveDomain(mv);
            if (dnDomain !== "" && dnDomain.toLowerCase() !== key) {
                throw new Error(
                    "buildAdminPkiReportInvocation: domains row " + (r + 1) + " is filed under domain '" +
                    domain + "' but its ou= DN belongs to '" + dnDomain + "' ('" + mv + "'). The OU is " +
                    "searched with '-Server " + domain + " -SearchBase <DN>', so that server cannot resolve " +
                    "this search base: the query fails and the domain is missing from the report. Correct " +
                    "whichever of the two is wrong - they must name the same domain."
                );
            }
            if (mv.toUpperCase().indexOf("OU=") === -1) {
                System.warn(
                    "buildAdminPkiReportInvocation | domains row " + (r + 1) + " ou='" + mv + "' has no 'OU=' " +
                    "component. Valid as a search base if it is a container or the domain root, but a domain " +
                    "root searches the ENTIRE domain, not just admin accounts."
                );
            }

            var dup = false;
            for (var d = 0; d < entry.ous.length; d++) {
                if (entry.ous[d].toLowerCase() === mv.toLowerCase()) { dup = true; break; }
            }
            if (dup) {
                System.warn("buildAdminPkiReportInvocation | domains row " + (r + 1) + ": duplicate ou='" + mv + "' ignored.");
            } else {
                // SearchScope is Subtree, so a parent and its child both listed means the
                // child's accounts come back from both searches. cvs_admin.ps1 de-duplicates
                // on Domain+SamAccountName before counting, so the figures stay right - the
                // redundant row is just work nobody needs.
                for (var nn = 0; nn < entry.ous.length; nn++) {
                    var a = mv.toLowerCase(), b = entry.ous[nn].toLowerCase();
                    if (a.length !== b.length && (a.indexOf("," + b) === a.length - b.length - 1 ||
                                                  b.indexOf("," + a) === b.length - a.length - 1)) {
                        System.warn(
                            "buildAdminPkiReportInvocation | domains row " + (r + 1) + ": '" + mv + "' and '" +
                            entry.ous[nn] + "' are nested. Searches run at Subtree scope, so the deeper OU is " +
                            "queried twice. Accounts are de-duplicated before counting, so the compliance " +
                            "figures stay correct - remove whichever entry is redundant."
                        );
                    }
                }
                entry.ous.push(mv);
            }
        }
        else if (mk === "dept") { entry.departments.push(mv); }
        else if (mk === "cred") {
            if (entry.credential !== "") {
                throw new Error(
                    "buildAdminPkiReportInvocation: domains row " + (r + 1) + " sets cred= twice ('" +
                    entry.credential + "' then '" + mv + "'). A domain is queried with one identity."
                );
            }
            entry.credential = mv;
        }
        else {
            throw new Error(
                "buildAdminPkiReportInvocation: domains row " + (r + 1) + " has unknown modifier '" + mk +
                "='. Valid keys: ou=, dept=, cred=."
            );
        }
    }

    if (entry.ous.length === 0) {
        if (templates.length === 0) {
            throw new Error(
                "buildAdminPkiReportInvocation: domain '" + domain + "' (row " + (r + 1) + ") has no ou= " +
                "modifier and ouTemplates is empty, so it has no search base and would contribute nothing to " +
                "the report. Give it an explicit 'ou=<DN>' or supply ouTemplates."
            );
        }
        var dc = domainToDC(domain);
        for (var tt = 0; tt < templates.length; tt++) {
            entry.ous.push(templates[tt].split("__DC__").join(dc));
        }
    }

    domainOrder.push(domain);
    scope[domain] = entry;
    totalOUs += entry.ous.length;
}

// ── Credentials ───────────────────────────────────────────────────────────────
//
// cvs_admin.ps1 resolves a credential key from the PROCESS ENVIRONMENT
// (cvs_admin.ps1:115-134). Ansible injected them per job under no_log; over WinRM they are
// machine-level environment variables staged during host build
// (Multi-Domain-Remediation-Plan §5.2 option 1), so no secret crosses from Orchestrator and
// the invocation string stays fully loggable. NOTE the operational catch documented in the
// build guide: a machine-level variable is not visible to wsmprovhost until the WinRM
// service is restarted.
//
// A key whose variables are absent is a per-domain failure inside the script, recorded as an
// error row - which is why the run should not also be told to ignore query errors.

var defaultCred = (defaultCredentialKey === null || defaultCredentialKey === undefined) ? "" : String(defaultCredentialKey).trim();

var credKeys = [];
for (var dk = 0; dk < domainOrder.length; dk++) {
    var ck = scope[domainOrder[dk]].credential;
    if (ck !== "") {
        var known = false;
        for (var kk = 0; kk < credKeys.length; kk++) { if (credKeys[kk] === ck) { known = true; break; } }
        if (!known) { credKeys.push(ck); }
    }
}
if (credKeys.length === 0 && defaultCred === "") {
    System.log(
        "buildAdminPkiReportInvocation | no credential keys in scope - every domain is queried as the identity " +
        "of the bound psHost. This matches the retired v2 template's behaviour and is correct wherever that " +
        "identity already has read rights."
    );
}

// ── Mail validation ───────────────────────────────────────────────────────────

var wantsEmail = (emailReport === true);
var toList = toTokens(mailTo, ",").join(",");
var ccList = toTokens(mailCc, ",").join(",");

if (wantsEmail) {
    if (!smtpServer || String(smtpServer).trim() === "") {
        throw new Error("buildAdminPkiReportInvocation: smtpServer is required when emailReport is true.");
    }
    if (toList === "") {
        throw new Error("buildAdminPkiReportInvocation: mailTo must contain at least one recipient when emailReport is true.");
    }
    // Guard against the vRO "scalar string bound to an Array/string input" artifact, which
    // explodes one address into single characters. Every real recipient contains '@'.
    function assertAddresses(csv, inputName) {
        var tokens = csv.split(",");
        for (var k = 0; k < tokens.length; k++) {
            if (tokens[k].indexOf("@") === -1) {
                throw new Error("buildAdminPkiReportInvocation: " + inputName + " contains an entry with no " +
                    "'@' ('" + tokens[k] + "'). This usually means a single address string was bound to an " +
                    "Array/string input and vRO split it into characters. Bind " + inputName + " as an Array " +
                    "of addresses, or as a plain/CSV string - not a string fed to an Array parameter.");
            }
        }
    }
    assertAddresses(toList, "mailTo");
    if (ccList !== "") { assertAddresses(ccList, "mailCc"); }
} else {
    System.warn(
        "buildAdminPkiReportInvocation | emailReport=false - the compliance report will NOT be emailed. It is " +
        "still written to PKI_result.html / PKI_result.csv beside the script on the PS host and summarised in " +
        "the workflow log."
    );
}

// ── Encode the scope as JSON ──────────────────────────────────────────────────
//
// Hand-built rather than via JSON.stringify: this string is embedded in a command line and
// re-parsed by ConvertFrom-Json on the far side, so the escaping is explicit and
// engine-independent.
//
// Escaping chain: backslash -> \\ and '"' -> \" here (JSON rules); the whole JSON is then
// wrapped in PowerShell SINGLE quotes by psQuote, a literal string with no backslash or $
// expansion, so it reaches ConvertFrom-Json byte-for-byte. A single quote inside a DN
// (OU=O'Brien) needs no JSON escape but IS doubled by psQuote.
//
// Shape matches Get-DomainOuMap (cvs_admin.ps1:69-111), which reads the per-domain object
// form { ous, departments, credential } as well as the bare array form v2 used.

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

function jsonArray(items) {
    var out = [];
    for (var i = 0; i < items.length; i++) { out.push(jsonQuote(items[i])); }
    return "[" + out.join(",") + "]";
}

var jsonParts = [];
for (var i2 = 0; i2 < domainOrder.length; i2++) {
    var dn2 = domainOrder[i2];
    var en  = scope[dn2];
    jsonParts.push(
        jsonQuote(dn2) + ":{" +
        "\"ous\":" + jsonArray(en.ous) + "," +
        "\"departments\":" + jsonArray(en.departments) + "," +
        "\"credential\":" + jsonQuote(en.credential) +
        "}"
    );
}
var domainOUsJson = "{" + jsonParts.join(",") + "}";

// ── Build the invocation string ───────────────────────────────────────────────
//
// Parameters confirmed against the cvs_admin.ps1 param block (lines 1-42). All of them
// already exist - nothing here asks the script to change.
//
// -DomainOUs (inline) rather than -DomainOUsFile: the script accepts both, and inline keeps
// the scope visible in the run history beside the result it produced, with no second file to
// stage. Switch to -DomainOUsFile only if exact parity with the playbook is wanted.

function psQuote(value) {
    return "'" + String(value === null || value === undefined ? "" : value).replace(/'/g, "''") + "'";
}

var wantsDisabled  = (includeDisabled !== false);    // default yes, matching both templates
var wantsFailOnErr = (failOnQueryError !== false);   // default yes - see below

// The v3 template runs -FailOnQueryError 'no'. Defaulting to 'yes' is deliberate (P-59): a
// consolidated run covers eight domains, and a query error means one is missing from a
// compliance report that will be read as complete. The script sends the mail FIRST and exits
// 1 afterwards (cvs_admin.ps1:426-432), so the report is still delivered - the run is simply
// marked failed, which is the family's "Completed with Errors rather than silently
// under-report" convention (cf. S-27).
if (!wantsFailOnErr) {
    System.warn(
        "buildAdminPkiReportInvocation | failOnQueryError=false - a domain or OU that cannot be queried will " +
        "be listed in the report's Query Errors section but the RUN will still succeed. On a " +
        domainOrder.length + "-domain sweep that means a compliance report can be short an entire domain and " +
        "nothing outside the email body will say so."
    );
}

var invocationString =
    "& \"" + String(scriptPath).trim() + "\"" +
    " -Action 'Get-AllAdmin-Accounts'" +
    " -DomainOUs " + psQuote(domainOUsJson) +
    " -DefaultCredentialKey " + psQuote(defaultCred) +
    " -IncludeDisabled '" + (wantsDisabled ? "yes" : "no") + "'" +
    " -FailOnQueryError '" + (wantsFailOnErr ? "yes" : "no") + "'" +
    " -eMailReport '" + (wantsEmail ? "yes" : "no") + "'" +
    " -SMTPServer " + psQuote(smtpServer ? String(smtpServer).trim() : "") +
    " -MailToString " + psQuote(toList) +
    " -MailCcString " + psQuote(ccList) +
    " -MailSubjectstring " + psQuote(mailSubject ? String(mailSubject).trim() : "") +
    " -ReportTitle " + psQuote(reportTitle ? String(reportTitle).trim() : "Admin Account PKI Report") +
    // Stream capture: cvs_admin.ps1 reports through Write-Log -> Write-Host. The vRO
    // PowerShell plug-in returns only the SUCCESS stream, so without '*>&1' the transcript
    // comes back empty and parseScriptOutput has nothing to classify. '-Width 4096' stops
    // the default ~80-column wrap splitting a long 'ERROR:' line mid-scan.
    " *>&1 | Out-String -Width 4096";

System.log(
    "buildAdminPkiReportInvocation | scriptPath=" + scriptPath +
    " | domains=" + domainOrder.length +
    " | OUs=" + totalOUs +
    " | scope=" + domainOrder.join(", ") +
    " | credentialKeys=" + (credKeys.length ? credKeys.join(", ") : "(none)") +
    " | defaultCredentialKey=" + (defaultCred === "" ? "(none)" : defaultCred) +
    " | includeDisabled=" + wantsDisabled +
    " | failOnQueryError=" + wantsFailOnErr +
    " | emailReport=" + wantsEmail +
    " | mailTo=" + toList
);
System.log("buildAdminPkiReportInvocation | invocationString=" + invocationString);

return invocationString;
