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
 *   Under "Group membership", at least one of computerMembers / groupMembers / members
 *   must say "present". If all three say "missing", this plug-in version reports
 *   membership some other way and getGroupComputers needs adjusting to match.
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
        // findAdHostForDn matches a domain against these, so at least one of them
        // must contain the domain name or its DC= path.
        var fields = ["name", "hostName", "ldapHostName", "domainName", "rootDn", "ldapBase", "defaultRootDn"];
        for (var f = 0; f < fields.length; f++) {
            say("        " + fields[f] + " : " + describe(adHosts[h], fields[f]));
        }
    }
}

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
    say("  getGroupComputers needs at least one of these to be present:");
    say("      computerMembers : " + describe(adGroup, "computerMembers"));
    say("      groupMembers    : " + describe(adGroup, "groupMembers"));
    say("      members         : " + describe(adGroup, "members"));
    say("      (userMembers    : " + describe(adGroup, "userMembers") + " -- not used, shown for comparison)");

    // Look at one computer to confirm the two properties used to build its full name,
    // and the disabled flag used to skip decommissioned machines.
    var sample = null;
    try {
        var list = adGroup.computerMembers || adGroup.members || [];
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
