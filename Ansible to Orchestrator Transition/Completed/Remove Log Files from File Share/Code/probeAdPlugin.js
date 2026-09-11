/* ===========================================================================
 * SHARED COMPONENT -- also used by: Move Archived Logs
 *
 * This file is delivered inside this package so that the automation can be
 * installed on its own. It is NOT specific to it.
 *
 * If the other automation above is already installed in this Orchestrator,
 * the action it belongs to already exists. Create it ONCE and let both
 * workflows call it -- do not create a second copy under a different name.
 * A fix made to one copy does not reach the other, and the two drift apart
 * silently.
 *
 * Source of truth: _Shared/Code/ in the combined development repository.
 * See Documentation/06_Shared-Components.md.
 * =========================================================================== */

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

/**
 * Lists what a plug-in object ACTUALLY carries, rather than guessing at property names.
 *
 * These objects are Java underneath and do not answer 'for (key in object)', so a probe
 * that lists a set of likely names can only ever report on the names it thought of --
 * and reports "missing" for a property that is really there under another name. Asking
 * the class itself removes the guesswork: every no-argument getter is a property, and
 * Rhino exposes getFoo() as .foo, so each one can be read straight back.
 *
 * Returns an array of lines, or null when the object will not be reflected on.
 */
function describeByReflection(object, indent) {
    var cls = null;
    try { cls = object.getClass(); }
    catch (e) { return null; }

    if (cls === null || cls === undefined) { return null; }

    var lines = [];
    try { lines.push(indent + "class : " + cls.getName()); }
    catch (e2) { return null; }

    var methods = null;
    try { methods = cls.getMethods(); }
    catch (e3) { methods = null; }

    if (methods === null || methods === undefined) {
        lines.push(indent + "(the class would not list its methods)");
        return lines;
    }

    var seen = {};
    for (var i = 0; i < methods.length; i++) {
        var name, argCount;
        try {
            name = String(methods[i].getName());
            argCount = methods[i].getParameterTypes().length;
        }
        catch (e4) { continue; }

        // A property is a getter that takes nothing. getClass() is Java's own.
        if (argCount !== 0 || name === "getClass") { continue; }

        var prop;
        if (name.indexOf("get") === 0 && name.length > 3)      { prop = name.substring(3); }
        else if (name.indexOf("is") === 0 && name.length > 2)  { prop = name.substring(2); }
        else { continue; }

        prop = prop.charAt(0).toLowerCase() + prop.substring(1);
        if (seen[prop] === true) { continue; }
        seen[prop] = true;

        lines.push(indent + prop + " : " + describe(object, prop) + "   [" + name + "()]");
    }

    if (lines.length === 1) {
        lines.push(indent + "(no readable properties found)");
    }
    return lines;
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
        say("");
        say("  [" + (p + 1) + "] " + psHosts[p].name);

        // How this host authenticates decides whether the script can reach anything
        // BEYOND the host itself. A session opened without a forwardable credential can
        // run on the host perfectly well and still be refused by \\<server>\C$, which
        // looks like a permissions fault and is not one.
        //
        //   transport / authentication : Kerberos can delegate, CredSSP always does,
        //                                Basic and plain NTLM cannot
        //   sharedSession + user       : a shared session logs on with a stored account,
        //                                which is a different kind of logon again
        //
        // Names differ between plug-in versions, so several are tried and the ones this
        // version answers to are the ones that matter.
        say("        name : " + describe(psHosts[p], "name"));
        say("        id   : " + describe(psHosts[p], "id"));
        say("        type : " + describe(psHosts[p], "type"));

        // Like AD:AdHost, this object is a thin wrapper: its 'host' property is not a
        // hostname but a nested com.vmware.o11n.plugin.powershell.model.Host holding the
        // real connection settings. Printing it directly gives only its Java toString,
        // which is what makes the settings look absent when they are not.
        var psConfig = null;
        try { psConfig = psHosts[p].host; } catch (he) { psConfig = null; }

        if (psConfig === null || psConfig === undefined || typeof psConfig === "string") {
            say("        host : " + describe(psHosts[p], "host") + "   (not a nested object)");
            psConfig = psHosts[p];
        }
        else {
            say("        host : nested object -- its settings follow");
        }

        // The authentication is the thing worth knowing. A session opened without a
        // forwardable credential runs on the host perfectly well and is still refused by
        // \\<server>\C$, which reads as a permissions fault and is not one:
        //   Kerberos with delegation, or CredSSP -> the credential reaches the next hop
        //   Basic, or plain NTLM/Negotiate       -> it stops at the host
        //
        // The names are not guessed at -- the class is asked what it has.
        var reflected = describeByReflection(psConfig, "            ");

        if (reflected !== null) {
            for (var r = 0; r < reflected.length; r++) {
                say(reflected[r]);
            }
        }
        else {
            // Orchestrator sandboxes the scripting engine, so getClass() is refused and
            // this object cannot be asked what it holds. Guessing at names is what the
            // reflection above was written to avoid, and a list of "missing" from a guess
            // says nothing about the host -- only about the guess. So it is not printed.
            say("            This plug-in will not let a script read these settings:");
            say("            getClass() is blocked and the property names are not exposed.");
            say("");
            say("            READ THE AUTHENTICATION ANOTHER WAY. It decides whether the");
            say("            script can reach \\\\<server>\\C$ at all, so it is worth knowing:");
            say("");
            say("              - In the Orchestrator UI, run 'Update a PowerShell host'");
            say("                against this host. The form shows its current settings.");
            say("              - Or ask the session itself. Run this on the host through");
            say("                'Invoke a PowerShell script':");
            say("                    whoami");
            say("                    klist");
            say("                    Test-Path \\\\<a-target-server>\\C$");
            say("");
            say("            Basic or NTLM cannot carry a credential to a second machine.");
            say("            CredSSP always does. Kerberos does only where constrained");
            say("            delegation is configured for this host.");
        }
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
