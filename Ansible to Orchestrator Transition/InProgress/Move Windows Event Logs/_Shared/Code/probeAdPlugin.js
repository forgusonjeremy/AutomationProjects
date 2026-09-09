/**
 * Action:  probeAdPlugin
 * Module:  com.broadcom.pso.windows.logs
 *
 * WHAT IT DOES
 *   Prints what this Orchestrator's plug-ins actually offer. It changes nothing.
 *
 *   Run it once, before deploying anything else, and once again if a workflow ever
 *   complains that it could not find a domain or could not read a group's membership.
 *   Everything the other actions rely on is listed here, so one run tells you whether
 *   they will work in this environment.
 *
 * INPUTS (in this order)
 *   adGroup  AD:UserGroup  any group to inspect -- may be empty, but pick one if you can
 *
 * RETURNS
 *   string -- the same report that is written to the log, so it can be copied out
 *
 * HOW TO READ THE RESULT
 *   Under "Group membership", at least one of computers / computerMembers / groups /
 *   groupMembers / members must say "present". If they all say "missing", this plug-in
 *   version reports membership some other way and getGroupComputers needs adjusting.
 *
 *   Then check that whichever nested-group list is present points DOWNWARDS -- at the
 *   groups inside this one, not the ones it belongs to. A list of parents would make
 *   getGroupComputers walk up the tree and collect servers that are not in scope.
 */

var report = [];

function say(line) {
    report.push(line);
    System.log(line);
}

function describe(object, propertyName) {
    try {
        var value = object[propertyName];
        if (value === null || value === undefined) {
            return "missing";
        }
        if (value.length !== undefined && typeof value !== "string") {
            return "present (" + value.length + " item(s))";
        }
        return "present -> " + String(value);
    }
    catch (e) {
        return "missing";
    }
}

/** Whether a method exists to be called. resolveAdGroup picks its lookup from these. */
function describeMethod(object, methodName) {
    try {
        return (typeof object[methodName] === "function") ? "present" : "missing";
    }
    catch (e) {
        return "missing";
    }
}

say("=================================================================");
say(" Orchestrator plug-in probe");
say("=================================================================");

// ---------------------------------------------------------------------------
// 1. Active Directory endpoints -- one is needed per domain
// ---------------------------------------------------------------------------
say("");
say("--- Active Directory endpoints ---");

var adHosts = Server.findAllForType("AD:AdHost");

if (adHosts === null || adHosts.length === 0) {
    say("NONE REGISTERED. Add one per domain with 'Add an Active Directory server'.");
}
else {
    say(adHosts.length + " endpoint(s) registered.");
    for (var h = 0; h < adHosts.length; h++) {
        say("");
        say("  [" + (h + 1) + "] " + adHosts[h].name);
        // An AD:AdHost carries only name, Url and hostConfiguration. Everything that
        // describes the connection lives on that nested AD_ServerConfiguration, so both
        // levels are printed -- reading ldapBase straight off the AdHost returns nothing
        // and looks exactly like an endpoint registered without it.
        say("        name : " + describe(adHosts[h], "name"));
        say("        Url  : " + describe(adHosts[h], "Url") + "   (lower-case 'url': " +
            describe(adHosts[h], "url") + ")");

        var config = null;
        try { config = adHosts[h].hostConfiguration; } catch (ce) { config = null; }

        if (config === null || config === undefined) {
            say("        hostConfiguration : MISSING -- this version does not nest the");
            say("            connection settings, so they are read off the endpoint itself.");
            config = adHosts[h];
        }
        else {
            say("        hostConfiguration : present");
        }

        // findAdHostForDn matches on ldapBase (the 'Root' field on the Add an Active
        // Directory server workflow) and defaultDomain first, then falls back to
        // host / url / alternativeHosts, and finally the endpoint's name.
        var fields = [
            "id", "name", "ldapBase", "defaultDomain", "host", "port", "alternativeHosts",
            "loadBalancingMode", "useSSL", "bindType", "useSharedSession", "sharedUserName",
            "followReferrals"
        ];
        for (var f = 0; f < fields.length; f++) {
            say("            " + fields[f] + " : " + describe(config, fields[f]));
        }

        // resolveAdGroup asks the endpoint itself for the group, preferring an exact
        // match on the distinguishedName. It tries these in order and uses the first
        // one that is present, so this says which form this plug-in will actually use.
        say("        -- lookup methods on the endpoint --");
        say("        searchExactMatch() : " + describeMethod(adHosts[h], "searchExactMatch"));
        say("        search()           : " + describeMethod(adHosts[h], "search"));
    }
}

// The same lookups on the plug-in's own scripting class, used with the endpoint passed
// as an argument. At least one of these four forms must be present for a scheduled or
// API run to resolve a group from its name.
say("");
say("--- Active Directory lookup calls ---");
say("  ActiveDirectory.searchExactMatch() : " + describeMethod(ActiveDirectory, "searchExactMatch"));
say("  ActiveDirectory.search()           : " + describeMethod(ActiveDirectory, "search"));

// ---------------------------------------------------------------------------
// 2. PowerShell hosts -- one is needed to run the scripts
// ---------------------------------------------------------------------------
say("");
say("--- PowerShell hosts ---");

var psHosts = Server.findAllForType("PowerShell:PowerShellHost");

if (psHosts === null || psHosts.length === 0) {
    say("NONE REGISTERED. Add one with 'Add a PowerShell host'.");
}
else {
    say(psHosts.length + " host(s) registered:");
    for (var p = 0; p < psHosts.length; p++) {
        say("  [" + (p + 1) + "] " + psHosts[p].name);
    }
    if (psHosts.length === 1) {
        say("  Exactly one, so the workflows will select it automatically.");
    }
    else {
        say("  More than one, so operators must choose in the request form.");
    }
}

// ---------------------------------------------------------------------------
// 3. The scripts, held in Orchestrator as Resource Elements
// ---------------------------------------------------------------------------
say("");
say("--- Scripts ---");

var wanted = ["Move-ArchivedLogs.ps1", "Remove-OldArchivedLogs.ps1"];
var elements = Server.findAllForType("ResourceElement");

for (var w = 0; w < wanted.length; w++) {
    var found = false;
    for (var e = 0; e < elements.length; e++) {
        if (elements[e].name === wanted[w]) {
            found = true;
            break;
        }
    }
    say("  " + wanted[w] + " : " + (found ? "found" : "NOT IMPORTED"));
}

// ---------------------------------------------------------------------------
// 4. Group membership -- the part most likely to differ between versions
// ---------------------------------------------------------------------------
say("");
say("--- Group membership ---");

if (adGroup === null || adGroup === undefined) {
    say("No group supplied. Re-run with a group selected to check this section --");
    say("it is the one thing this probe cannot check on its own.");
}
else {
    say("Group : " + adGroup.name);
    say("  distinguishedName : " + describe(adGroup, "distinguishedName"));
    say("");
    say("  getGroupComputers needs at least one of these to be present.");
    say("  It reads them in this order, and the mixed 'members' list only as a last resort:");
    say("      computers       : " + describe(adGroup, "computers"));
    say("      computerMembers : " + describe(adGroup, "computerMembers"));
    say("      groups          : " + describe(adGroup, "groups"));
    say("      groupMembers    : " + describe(adGroup, "groupMembers"));
    say("      members         : " + describe(adGroup, "members"));
    say("      (userMembers    : " + describe(adGroup, "userMembers") + " -- not used, shown for comparison)");
    say("      (users          : " + describe(adGroup, "users") + " -- not used, shown for comparison)");
    say("");
    say("  CHECK THE NESTED-GROUP LIST POINTS DOWNWARDS. Whichever of 'groups' or");
    say("  'groupMembers' is present must hold the groups INSIDE this one, not the ones");
    say("  this group belongs to. If it is the latter, getGroupComputers would walk up the");
    say("  tree and collect machines that are not in scope. The names below say which:");
    say("      memberOf        : " + describe(adGroup, "memberOf") + " -- upward, must NOT be used");

    // Look at one computer to confirm the two properties used to build its full name,
    // and the disabled flag used to skip decommissioned machines.
    var sample = null;
    try {
        var list = adGroup.computers || adGroup.computerMembers || adGroup.members || [];
        if (list.length > 0) {
            sample = list[0];
        }
    }
    catch (e) {
        sample = null;
    }

    say("");
    if (sample === null) {
        say("  No computer members to inspect. Try a group that contains at least one server.");
    }
    else {
        say("  Sample member: " + sample.name + "  (type " + System.getObjectType(sample) + ")");
        say("      name                : " + describe(sample, "name"));
        say("      distinguishedName   : " + describe(sample, "distinguishedName"));
        say("      disabled            : " + describe(sample, "disabled"));
        say("      userAccountControl  : " + describe(sample, "userAccountControl"));
        say("");
        say("  The full server name is built from name + the DC= parts of distinguishedName,");
        say("  so those two must be present. If BOTH disabled and userAccountControl are");
        say("  missing, disabled computer accounts cannot be skipped and will simply be");
        say("  reported as unreachable when a run tries them.");
    }
}

say("");
say("=================================================================");

return report.join("\n");
