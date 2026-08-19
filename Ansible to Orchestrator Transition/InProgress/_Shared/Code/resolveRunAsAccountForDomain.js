/**
 * Action: resolveRunAsAccountForDomain
 * Module:  com.broadcom.pso.vcf.powershell.identity   (SHARED - reference, do not copy)
 *
 * vRO input-parameter order (positional call from the workflow):
 *   (accountCategoryPath, domainName, explicitAccount)
 *
 * Purpose:
 *   Returns the run-as account SELECTOR registered for a domain, so a workflow that can
 *   already derive the domain does not have to ask an operator for the identity as well.
 *
 *   Feed the result to resolvePowerShellHostForAccount, which resolves the actual host
 *   object. This action does not resolve one itself, deliberately: there stays exactly ONE
 *   path from a selector to a PowerShellHost, and one place where a missing or duplicated
 *   host object is caught.
 *
 * ── Why this is not a return to domain-keyed mapping ──────────────────────────
 *
 *   The superseded resolvePowerShellHostForDomain kept a SECOND map, keyed on domain,
 *   alongside the account definitions - and a half-updated pair of maps is the defect that
 *   authenticates successfully as the wrong account.
 *
 *   This is a LOOKUP INTO the one map, not another map. PSO/Identity/RunAsAccounts stays
 *   keyed on the account; this action reads the 'domain' attribute already defined on each
 *   element and finds the account that claims it. Adding an account still means editing one
 *   place, and nothing can disagree with anything.
 *
 * ── When the derivation is appropriate ────────────────────────────────────────
 *
 *   Only where the domain is a PROPERTY OF THE WORK, not a choice. The file-move workflow
 *   qualifies for its AD query: the group is given as a distinguishedName, the DN's DC=
 *   components name the domain that holds it, and the account that reads it must be able to
 *   read that domain. Deriving is strictly better than asking - one less input, and it
 *   cannot disagree with the group.
 *
 *   IT DOES NOT QUALIFY FOR THE FILE MOVE in that same workflow. The move reaches
 *   \\<server>\<share> on each target server and writes to a file share that lives wherever
 *   it lives - in the current estate, always subdom1, whichever domain the group is in.
 *   Nothing about the group's DN implies who can write to that share, so the move identity
 *   stays an explicit input. Deriving it would be inventing a relationship that does not
 *   exist, and the failure would be an access-denied halfway through a file move.
 *
 *   The reports do not qualify either: the admin sweep covers eight domains in one
 *   invocation, so there is no single domain to derive from.
 *
 * ── Two accounts for one domain ───────────────────────────────────────────────
 *
 *   A domain legitimately can have more than one registered account - a read-only one for
 *   reports and a privileged one for writes is the obvious pair. That ambiguity is why the
 *   shared map is keyed on the account rather than the domain in the first place.
 *
 *   Here it is a HARD FAILURE naming both candidates, not a first-match. Picking either
 *   would be choosing an identity by accident of element ordering, and the wrong choice
 *   either fails with an access-denied or succeeds with more rights than the run needed.
 *   Pass explicitAccount to settle it.
 *
 * Inputs:
 *   accountCategoryPath (string) - e.g. 'PSO/Identity/RunAsAccounts'
 *   domainName          (string) - the derived domain, e.g. 'customer2.net'
 *   explicitAccount     (string) - optional override; when set, returned as-is and the
 *                                  lookup is skipped entirely
 *
 * Returns: string - the selector, for resolvePowerShellHostForAccount
 */

if (!accountCategoryPath || String(accountCategoryPath).trim() === "") {
    throw new Error("resolveRunAsAccountForDomain: accountCategoryPath is required, e.g. 'PSO/Identity/RunAsAccounts'.");
}

// An explicit choice always wins, and is not validated against the domain: an account in
// one domain reading another across a trust is legitimate, and this action has no business
// overruling an operator who named one.
if (explicitAccount && String(explicitAccount).trim() !== "") {
    var chosen = String(explicitAccount).trim();
    System.log("resolveRunAsAccountForDomain | explicit account '" + chosen + "' supplied - domain lookup skipped.");
    return chosen;
}

if (!domainName || String(domainName).trim() === "") {
    throw new Error(
        "resolveRunAsAccountForDomain: domainName is required when no explicitAccount is given. It is " +
        "normally derived from the DC= components of a distinguishedName earlier in the workflow."
    );
}

var wantCategory = String(accountCategoryPath).trim().replace(/^\/+|\/+$/g, "");
var wantDomain   = String(domainName).trim();

var category = Server.getConfigurationElementCategoryWithPath(wantCategory);
if (category === null || category === undefined) {
    throw new Error(
        "resolveRunAsAccountForDomain: no Configuration Element category at '" + wantCategory + "'. See " +
        "_Shared/Documentation/RunAsAccounts-Config_definition.md."
    );
}

var matches  = [];
var surveyed = [];
var elements = category.configurationElements || [];

for (var i = 0; i < elements.length; i++) {
    var domainAttr = elements[i].getAttributeWithKey("domain");
    var elementDomain = (domainAttr && domainAttr.value) ? String(domainAttr.value).trim() : "";

    surveyed.push(elements[i].name + " -> " + (elementDomain === "" ? "(no domain attribute)" : elementDomain));

    // AD domain names are case-insensitive.
    if (elementDomain !== "" && elementDomain.toLowerCase() === wantDomain.toLowerCase()) {
        matches.push(String(elements[i].name));
    }
}

if (matches.length === 0) {
    throw new Error(
        "resolveRunAsAccountForDomain: no run-as account in '" + wantCategory + "' declares domain '" +
        wantDomain + "'. Registered: " + (surveyed.length ? surveyed.join("; ") : "(none)") + ". Either add " +
        "the 'domain' attribute to the account that reads that domain, or supply explicitAccount. An account " +
        "is NOT guessed from a partial match - a run against the wrong directory returns a plausible answer."
    );
}

if (matches.length > 1) {
    throw new Error(
        "resolveRunAsAccountForDomain: " + matches.length + " run-as accounts declare domain '" + wantDomain +
        "' (" + matches.join(", ") + "). This is legitimate - a read-only account and a privileged one for " +
        "the same domain is a normal arrangement - but it means the identity cannot be derived. Supply " +
        "explicitAccount to say which. Choosing by element order would pick an identity by accident, and the " +
        "wrong pick either fails with access-denied or runs with more rights than the work needs."
    );
}

System.log("resolveRunAsAccountForDomain | domain '" + wantDomain + "' -> account '" + matches[0] + "'");
return matches[0];
