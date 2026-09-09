/**
 * Action:  resolveAdGroup
 * Module:  com.broadcom.pso.windows.logs
 *
 * WHAT IT DOES
 *   Turns a group's distinguishedName into the AD:UserGroup object it names, looked up on
 *   the endpoint it is handed.
 *
 *   Scheduled and API runs have nobody to pick a group from a tree, so they name the
 *   group as text. This is what turns that text back into an object the rest of the
 *   workflow can use. When a person does pick from the tree, Orchestrator hands over the
 *   object already resolved and this action is not needed for that run at all.
 *
 * BOTH INPUTS ARE REQUIRED, AND BOTH ARE BINDINGS
 *   adGroupDn is the group to find. adHost is the endpoint to find it on, bound from the
 *   output of findAdHostForDn, which works the endpoint out from the DC= parts of that
 *   same name. Neither is looked up in here, so the workflow schema shows where both came
 *   from and that the endpoint used is demonstrably the one the name asked for.
 *
 * EVERY LOOKUP IS SCOPED TO THAT ENDPOINT
 *   Nothing here searches "all of Active Directory" and hopes. In a multi-domain estate
 *   the same group name can exist in several domains, and an unscoped search would be a
 *   coin toss between them.
 *
 * THE SEARCH TAKES THE COMMON NAME, NOT THE DISTINGUISHEDNAME
 *   These searches match on an object's NAME. Handing them a whole distinguishedName finds
 *   nothing, because no group is named 'CN=Monitoring-Servers,OU=Servers,DC=vcf,DC=lab' --
 *   that is its path, not its name. So the CN is pulled off the front and searched for,
 *   and the full distinguishedName is then used to pick the right one out of the results.
 *   That second step is what makes a name search safe: a name can repeat across OUs and
 *   domains, a distinguishedName cannot.
 *
 * WHICH CALL IS USED
 *   Plug-in versions differ over what they expose, so the lookup is tried in order of
 *   preference and the first form this plug-in supports is the one used:
 *
 *     1. adHost.searchExactMatch('UserGroup', cn)
 *     2. adHost.search('UserGroup', cn)
 *     3. ActiveDirectory.searchExactMatch('UserGroup', cn, adHost)
 *     4. ActiveDirectory.search('UserGroup', cn, adHost)
 *     5. ActiveDirectory.searchExactMatch('UserGroup', cn)      -- unscoped
 *     6. ActiveDirectory.search('UserGroup', cn)                -- unscoped
 *
 *   The endpoint is the THIRD argument, not the fourth. There is no result-limit parameter
 *   in front of it: passing one produces 'Cannot convert 1000.0 to ...AdHost', because the
 *   limit lands where the endpoint was expected.
 *
 *   The unscoped forms are a last resort for versions that will not take an endpoint at
 *   all. They search every registered domain, which is only safe here because every
 *   candidate is checked against the full distinguishedName before it is returned.
 *
 *   If they all fail, the error lists what was tried and what each one said. Run
 *   probeAdPlugin to see which of these methods this plug-in actually offers.
 *
 * INPUTS (in this order -- vRO passes action inputs positionally)
 *   adGroupDn  string     the group's distinguishedName, e.g.
 *                         CN=Monitoring-Servers,OU=Servers,DC=connect,DC=lab
 *   adHost     AD:AdHost  the endpoint to look it up on. Bind this from findAdHostForDn.
 *
 * RETURNS
 *   AD:UserGroup
 */

// ---------------------------------------------------------------------------
// Both inputs have to be there. Say which one is missing rather than failing
// later inside a plug-in call with a null argument.
// ---------------------------------------------------------------------------
if (adGroupDn === null || adGroupDn === undefined || String(adGroupDn).replace(/^\s+|\s+$/g, "") === "") {
    throw new Error(
        "resolveAdGroup: no group was supplied. Pass the group's distinguishedName, for example " +
        "CN=Monitoring-Servers,OU=Servers,DC=connect,DC=lab."
    );
}

var wantedDn = String(adGroupDn).replace(/^\s+|\s+$/g, "");

if (adHost === null || adHost === undefined) {
    throw new Error(
        "resolveAdGroup: no Active Directory endpoint was supplied to look '" + wantedDn + "' up on. " +
        "Bind the adHost input to the output of findAdHostForDn, which works the endpoint out from " +
        "the DC= parts of the name."
    );
}

System.log("Looking up group '" + wantedDn + "' on endpoint " + adHost.name);

// The group's own CN is the part before the first comma:
//   CN=Monitoring-Servers,OU=Servers,DC=connect,DC=lab  ->  Monitoring-Servers
var commonName = wantedDn.split(",")[0].replace(/^\s*CN=/i, "");

// ---------------------------------------------------------------------------
// Ask the endpoint for the group
// ---------------------------------------------------------------------------

// What was tried and what each attempt said. Only read when everything failed, but
// then it is the whole diagnosis: which methods this plug-in has, and how they answered.
var attempts = [];

/** True when the object really has this method, whatever the plug-in version. */
function callable(object, methodName) {
    try {
        return typeof object[methodName] === "function";
    }
    catch (e) {
        return false;
    }
}

/** A plug-in call may return one object, a list, or nothing. Always give back a list. */
function asList(value) {
    if (value === null || value === undefined) {
        return [];
    }
    if (typeof value.length !== "number") {
        return [value];
    }
    var out = [];
    for (var i = 0; i < value.length; i++) {
        out.push(value[i]);
    }
    return out;
}

/** Runs one lookup, records how it went, and never lets it stop the action. */
function attempt(label, call) {
    try {
        var found = asList(call());
        attempts.push(label + " -> " + found.length + " match(es)");
        return found;
    }
    catch (e) {
        attempts.push(label + " -> rejected: " + e);
        System.debug("resolveAdGroup: " + label + " was not accepted: " + e);
        return [];
    }
}

/**
 * The lookups, best first. Each returns as soon as it finds anything, so a plug-in that
 * supports the exact-match forms never runs the broader name searches.
 */
function findOnEndpoint() {
    var found;

    // The endpoint's own methods, on versions that provide them.
    if (callable(adHost, "searchExactMatch")) {
        found = attempt("adHost.searchExactMatch('UserGroup', cn)", function () {
            return adHost.searchExactMatch("UserGroup", commonName);
        });
        if (found.length > 0) { return found; }
    }

    if (callable(adHost, "search")) {
        found = attempt("adHost.search('UserGroup', cn)", function () {
            return adHost.search("UserGroup", commonName);
        });
        if (found.length > 0) { return found; }
    }

    // The scripting class, scoped by handing it the endpoint as the third argument.
    if (callable(ActiveDirectory, "searchExactMatch")) {
        found = attempt("ActiveDirectory.searchExactMatch('UserGroup', cn, adHost)", function () {
            return ActiveDirectory.searchExactMatch("UserGroup", commonName, adHost);
        });
        if (found.length > 0) { return found; }
    }

    found = attempt("ActiveDirectory.search('UserGroup', cn, adHost)", function () {
        return ActiveDirectory.search("UserGroup", commonName, adHost);
    });
    if (found.length > 0) { return found; }

    // Unscoped, for versions that will not take an endpoint at all. Every result is still
    // checked against the full distinguishedName below, so a hit from the wrong domain is
    // discarded rather than returned.
    if (callable(ActiveDirectory, "searchExactMatch")) {
        found = attempt("ActiveDirectory.searchExactMatch('UserGroup', cn) -- unscoped", function () {
            return ActiveDirectory.searchExactMatch("UserGroup", commonName);
        });
        if (found.length > 0) { return found; }
    }

    found = attempt("ActiveDirectory.search('UserGroup', cn) -- unscoped", function () {
        return ActiveDirectory.search("UserGroup", commonName);
    });
    if (found.length > 0) { return found; }

    return [];
}

var candidates = findOnEndpoint();

// ---------------------------------------------------------------------------
// Accept only the exact name that was asked for
// ---------------------------------------------------------------------------
// A name search returns near matches, and even an exact-match call is only as exact as
// the plug-in makes it. The distinguishedName is the identity, so it is what decides.
for (var i = 0; i < candidates.length; i++) {
    if (String(candidates[i].distinguishedName).toLowerCase() === wantedDn.toLowerCase()) {
        System.log("Resolved group: " + candidates[i].distinguishedName + " on " + adHost.name);
        return candidates[i];
    }
}

throw new Error(
    "resolveAdGroup: no group named '" + wantedDn + "' exists on endpoint '" + adHost.name + "'. " +
    "Check the distinguishedName is spelled exactly as it appears in Active Directory. " +
    "The lookups tried were: " + attempts.join(" | ") + "."
);
