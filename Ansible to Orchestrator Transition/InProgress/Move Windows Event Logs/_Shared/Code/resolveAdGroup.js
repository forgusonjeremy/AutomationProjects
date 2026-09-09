/**
 * Action:  resolveAdGroup
 * Module:  com.broadcom.pso.windows.logs
 *
 * WHAT IT DOES
 *   Gives the workflow one Active Directory group to work with, whichever way it was asked for.
 *
 *   There are two kinds of caller and they cannot supply a group the same way:
 *
 *     A person  picks the group from the tree in the request form. Orchestrator hands over
 *               the group itself, already attached to the right domain endpoint. Nothing
 *               is typed and there is nothing to get wrong.
 *
 *     A schedule or an API call has nobody to click a tree, so it passes the group's
 *               distinguishedName as text. The endpoint is then worked out from the
 *               DC= parts of that name (see findAdHostForDn).
 *
 *   Either way this action returns the same thing, so the rest of the workflow does not
 *   have to care which happened.
 *
 * INPUTS (in this order)
 *   adGroup    AD:UserGroup  the group picked in the form -- may be empty
 *   adGroupDn  string        the group's distinguishedName -- may be empty
 *
 * RETURNS
 *   AD:UserGroup
 */

// ---------------------------------------------------------------------------
// The picked group wins. It is already resolved, so there is nothing to look up.
// ---------------------------------------------------------------------------
if (adGroup !== null && adGroup !== undefined) {
    System.log("Using the group selected in the form: " + adGroup.distinguishedName);
    return adGroup;
}

if (adGroupDn === null || adGroupDn === undefined || String(adGroupDn).replace(/^\s+|\s+$/g, "") === "") {
    throw new Error(
        "resolveAdGroup: no group was supplied. Either pick a group in the request form, or pass " +
        "its distinguishedName (for example CN=Monitoring-Servers,OU=Servers,DC=connect,DC=lab)."
    );
}

var wantedDn = String(adGroupDn).replace(/^\s+|\s+$/g, "");

System.log("Looking up group by name: " + wantedDn);

// ---------------------------------------------------------------------------
// Work out which domain the name belongs to, and search only that endpoint.
// ---------------------------------------------------------------------------
var adHost = System.getModule("com.broadcom.pso.windows.logs").findAdHostForDn(wantedDn);

// The group's own CN is the part before the first comma:
//   CN=Monitoring-Servers,OU=Servers,DC=connect,DC=lab  ->  Monitoring-Servers
var commonName = wantedDn.split(",")[0].replace(/^\s*CN=/i, "");

/**
 * Searches one endpoint for groups matching a name.
 *
 * The plug-in's search takes a host argument in current versions and not in older ones,
 * so the host-scoped form is tried first and the plain form used as a fallback.
 */
function searchGroups(host, name) {
    try {
        return ActiveDirectory.search("UserGroup", name, 1000, host) || [];
    }
    catch (e) {
        System.debug("Host-scoped AD search was not accepted, falling back: " + e);
    }

    try {
        return ActiveDirectory.search("UserGroup", name) || [];
    }
    catch (e2) {
        throw new Error(
            "resolveAdGroup: the Active Directory plug-in rejected the search for '" + name + "'. " +
            "Run the probeAdPlugin action to see what this plug-in version supports. Error: " + e2
        );
    }
}

var candidates = searchGroups(adHost, commonName);

// A name search can return near matches, so accept only the exact name that was asked for.
for (var i = 0; i < candidates.length; i++) {
    if (String(candidates[i].distinguishedName).toLowerCase() === wantedDn.toLowerCase()) {
        System.log("Resolved group: " + candidates[i].distinguishedName);
        return candidates[i];
    }
}

throw new Error(
    "resolveAdGroup: no group named '" + wantedDn + "' exists on endpoint '" + adHost.name + "'. " +
    "Check the distinguishedName is spelled exactly as it appears in Active Directory " +
    "(" + candidates.length + " group(s) matched the name '" + commonName + "')."
);
