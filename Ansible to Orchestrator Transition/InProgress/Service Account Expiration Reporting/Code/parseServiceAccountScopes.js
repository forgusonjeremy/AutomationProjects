/**
 * Action: parseServiceAccountScopes
 * Module:  com.broadcom.pso.vcf.identity.ad.accounts.serviceAccountExpiry
 *
 * vRO input-parameter order (positional call from the workflow):
 *   (scopes, defaultRunAsAccount)
 *
 * Purpose:
 *   Turns the operator's scope rows into a list the workflow can iterate, one entry per
 *   invocation. This is the element the consolidated workflow loops over: for each entry it
 *   resolves a psHost, stages the script, builds an invocation and runs it.
 *
 *   Validation lives here, before the first host is touched - the same reason the v3
 *   playbook opens with an `assert` block. A malformed row should cost a rejected request,
 *   not a half-finished run that has already emailed one of two reports.
 *
 * ── The row grammar ───────────────────────────────────────────────────────────
 *
 *     subdom6.company.net | ou=OU=Service Accounts,DC=subdom6,DC=company,DC=net | account=svc-vro-subdom6@subdom6.company.net
 *     subdomain8.net      | group=SVC-Accounts                                  | account=svc-vro-subdom8@subdomain8.net
 *
 *     ou=<DN>        Search base  -> -OUPath,        -Action Get-ServiceAccountExpiration
 *     group=<name>   Group        -> -ADGroupMember, -Action Get-ServiceAccountExpiration-ByGroup
 *     account=<sel>  Run-as account selector -> resolvePowerShellHostForAccount
 *
 *   EXACTLY ONE of ou= or group= per row. They select the script's -Action, not a combined
 *   filter, so a row carrying both would silently drop one. A domain needing both is two
 *   rows, which is also two invocations - correct, because they are two different queries.
 *
 *   account= is optional and falls back to defaultRunAsAccount. It exists because the
 *   identity is per scope, not per workflow: the two job templates being replaced
 *   authenticate as accounts in DIFFERENT domains, and that is the mechanism by which each
 *   gets the rights it needs. This is the AAP "credential on the job template" decision,
 *   moved onto the row it belongs to.
 *
 * Inputs:
 *   scopes              (Array/string) - one row per scope
 *   defaultRunAsAccount (string)       - used for any row without account=
 *
 * Returns: Array/Properties - one entry per scope, keys:
 *            domain  (string)  the AD domain          -> -DomainName
 *            ou      (string)  search base DN, or ''
 *            group   (string)  group identity, or ''
 *            account (string)  run-as account selector
 *            label   (string)  human-readable, for logs and run history
 */

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

var fallbackAccount = (defaultRunAsAccount === null || defaultRunAsAccount === undefined)
    ? "" : String(defaultRunAsAccount).trim();

var rows = toTokens(scopes, "\n");
if (rows.length === 0) {
    throw new Error(
        "parseServiceAccountScopes: scopes is required - supply at least one row, e.g. " +
        "'subdom6.company.net | ou=OU=Service Accounts,DC=subdom6,DC=company,DC=net'."
    );
}

var result = [];
var seen   = [];

for (var r = 0; r < rows.length; r++) {
    var segments = rows[r].split("|");
    var domain   = segments[0].trim();

    if (domain === "") {
        throw new Error("parseServiceAccountScopes: row " + (r + 1) + " has no domain name before the first '|'.");
    }
    // A single-character row is the signature of a plain string bound to an Array/string
    // input, which vRO splits into characters.
    if (domain.length === 1) {
        throw new Error(
            "parseServiceAccountScopes: row " + (r + 1) + " is the single character '" + domain + "'. This " +
            "means a plain string was bound to an Array/string input and vRO split it into characters. Bind " +
            "scopes as an Array with one SCOPE ROW per element."
        );
    }
    if (domain.indexOf(".") === -1) {
        System.warn(
            "parseServiceAccountScopes | row " + (r + 1) + ": '" + domain + "' is not a dotted DNS domain " +
            "name. It is passed to -Server as written; confirm this is the domain you meant."
        );
    }

    var ou = "", group = "", account = "";

    for (var s = 1; s < segments.length; s++) {
        var mod = segments[s].trim();
        if (mod === "") { continue; }

        var eq = mod.indexOf("=");   // FIRST '=' only - DNs are full of them
        if (eq === -1) {
            throw new Error(
                "parseServiceAccountScopes: row " + (r + 1) + " modifier '" + mod + "' is not in 'key=value' " +
                "form. Valid keys: ou=, group=, account=."
            );
        }
        var mk = mod.substring(0, eq).trim().toLowerCase();
        var mv = mod.substring(eq + 1).trim();
        if (mv === "") {
            throw new Error("parseServiceAccountScopes: row " + (r + 1) + " modifier '" + mk + "=' has an empty value.");
        }

        if (mk === "ou") {
            if (ou !== "") {
                throw new Error(
                    "parseServiceAccountScopes: row " + (r + 1) + " has two ou= modifiers. One row is one " +
                    "invocation and the script takes a single -OUPath; use one row per search base."
                );
            }
            ou = mv;
        } else if (mk === "group") {
            if (group !== "") {
                throw new Error(
                    "parseServiceAccountScopes: row " + (r + 1) + " has two group= modifiers. One row is one " +
                    "invocation and the script takes a single -ADGroupMember; use one row per group."
                );
            }
            group = mv;
        } else if (mk === "account") {
            if (account !== "") {
                throw new Error("parseServiceAccountScopes: row " + (r + 1) + " sets account= twice ('" + account + "' then '" + mv + "').");
            }
            account = mv;
        } else {
            throw new Error(
                "parseServiceAccountScopes: row " + (r + 1) + " has unknown modifier '" + mk + "='. Valid " +
                "keys: ou=, group=, account=."
            );
        }
    }

    if (ou === "" && group === "") {
        throw new Error(
            "parseServiceAccountScopes: row " + (r + 1) + " ('" + domain + "') has neither ou= nor group=, so " +
            "nothing in it would be queried and it would contribute nothing to the report."
        );
    }
    if (ou !== "" && group !== "") {
        throw new Error(
            "parseServiceAccountScopes: row " + (r + 1) + " ('" + domain + "') has both ou= and group=. They " +
            "select the script's -Action, not a combined filter, so one would be silently ignored. Split them " +
            "into two rows."
        );
    }

    // The DN must live in the domain it is queried against: the script runs
    // 'Get-ADUser -Server <domain> -SearchBase <DN>', so a DN naming another domain is a
    // search base that server cannot resolve. The query fails, and since this script has no
    // error-row model and the playbook never checked rc, nothing else would catch it.
    if (ou !== "") {
        if (ou.toUpperCase().indexOf("DC=") === -1) {
            throw new Error(
                "parseServiceAccountScopes: row " + (r + 1) + " ou='" + ou + "' is not a distinguishedName - " +
                "it has no 'DC=' component. Expected the full DN form, e.g. " +
                "'OU=Service Accounts,DC=subdom6,DC=company,DC=net'."
            );
        }
        var dnDomain = deriveDomain(ou);
        if (dnDomain !== "" && dnDomain.toLowerCase() !== domain.toLowerCase()) {
            throw new Error(
                "parseServiceAccountScopes: row " + (r + 1) + " is filed under '" + domain + "' but its ou= DN " +
                "belongs to '" + dnDomain + "' ('" + ou + "'). Correct whichever is wrong - they must name the " +
                "same domain."
            );
        }
    }
    if (group !== "" && group.toUpperCase().indexOf("DC=") !== -1) {
        var gDomain = deriveDomain(group);
        if (gDomain !== "" && gDomain.toLowerCase() !== domain.toLowerCase()) {
            throw new Error(
                "parseServiceAccountScopes: row " + (r + 1) + " is filed under '" + domain + "' but its group= " +
                "DN belongs to '" + gDomain + "' ('" + group + "'). Get-ADGroupMember runs with '-Server " +
                domain + "' and cannot resolve a group in another domain. Give it its own row."
            );
        }
    }

    if (account === "") {
        if (fallbackAccount === "") {
            throw new Error(
                "parseServiceAccountScopes: row " + (r + 1) + " ('" + domain + "') has no account= and no " +
                "defaultRunAsAccount was supplied. The run-as account decides which domain the script can " +
                "read, so there is no safe default to assume - the two templates this workflow replaces " +
                "authenticate as accounts in different domains."
            );
        }
        account = fallbackAccount;
    }

    // Exact duplicates would send the same report twice to the same people.
    var label = domain + " " + (ou !== "" ? "ou=" + ou : "group=" + group);
    for (var d = 0; d < seen.length; d++) {
        if (seen[d].toLowerCase() === label.toLowerCase()) {
            throw new Error(
                "parseServiceAccountScopes: row " + (r + 1) + " duplicates an earlier row (" + label + "). " +
                "Each scope sends its own email, so this would deliver the same report twice."
            );
        }
    }
    seen.push(label);

    var entry = new Properties();
    entry.put("domain",  domain);
    entry.put("ou",      ou);
    entry.put("group",   group);
    entry.put("account", account);
    entry.put("label",   label);
    result.push(entry);
}

System.log("parseServiceAccountScopes | " + result.length + " scope(s), " + result.length + " invocation(s):");
for (var l = 0; l < result.length; l++) {
    System.log("  " + (l + 1) + ". " + result[l].get("label") + "  as  " + result[l].get("account"));
}

// One email per scope. Said out loud because it is the design's known limitation, not an
// accident, and because the count is the thing recipients will notice first.
if (result.length > 1) {
    System.log(
        "parseServiceAccountScopes | NOTE: this run will send " + result.length + " separate emails, one per " +
        "scope, distinguished by the domain appended to the subject. A single combined email requires S-30 " +
        "(cvs_svcaccounts.ps1) - see 06_Consolidation-Design.md §2."
    );
}

return result;
