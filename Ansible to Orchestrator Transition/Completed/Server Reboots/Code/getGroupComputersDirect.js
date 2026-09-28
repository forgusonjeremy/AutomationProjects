/**
 * Action:  getGroupComputersDirect
 * Module:  com.broadcom.pso.windows.servers.reboot
 *
 * WHAT IT DOES
 *   Takes an Active Directory group and returns the full names of the enabled computers
 *   that are DIRECT members of it. Nested groups are NOT opened.
 *
 *   This is the job cvs_functions.ps1 did with Get-ADGroupMember over WinRM. Here it is
 *   done by the Orchestrator Active Directory plug-in instead, so no PowerShell runs to
 *   resolve the group and no credentials go anywhere -- the plug-in uses the account
 *   already stored against the AD endpoint.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT getGroupComputers, AND MUST NOT BE REPLACED BY IT
 * ───────────────────────────────────────────────────────────────────────────────
 *   The Move Archived Logs package has an action called getGroupComputers which does
 *   almost the same thing. It is RECURSIVE: it walks nested groups all the way down and
 *   returns everything it finds. Do not swap it in here, and do not "fix" this action by
 *   making it recursive to match.
 *
 *   Moving a log file off a machine that should not have been in scope wastes a little
 *   time. Rebooting one takes a production service down. So the two automations draw the
 *   line in different places on purpose:
 *
 *       getGroupComputers        recursive    -- find every server this group implies
 *       getGroupComputersDirect  NOT          -- reboot only what someone put in the group
 *
 *   Targeting for a destructive action is explicit: what the operator placed directly in
 *   the group is the target list, and nothing else is. A sub-group added to the group
 *   later -- by someone who never saw this workflow -- cannot silently enrol its members
 *   into a reboot schedule.
 *
 *   This is change S-7 in the Change Register, and it is the reason that entry exists.
 *
 * A NESTED GROUP IS REPORTED, NOT SILENTLY DROPPED
 *   Ignoring a sub-group quietly would be its own trap: someone nests
 *   'Security-Reboot-Servers-London' inside the group, sees the workflow run green, and
 *   assumes London was rebooted. Every direct sub-group is named in the log and in a
 *   warning, so the omission is visible on the run that made it.
 *
 * INPUTS (in this order -- vRO passes action inputs positionally)
 *   adGroup  AD:UserGroup  the group whose direct members are the targets
 *
 * RETURNS
 *   Array/string -- computer names such as ["srv01.vcf.lab", "srv02.vcf.lab"]
 */

/**
 * Turns  CN=SRV01,OU=Servers,DC=vcf,DC=lab  into  vcf.lab
 *
 * Each computer's full name is built from its OWN distinguishedName, not the group's.
 * A group in one domain can hold computers from another, and building the name this way
 * gets those right instead of quietly pointing at the wrong domain -- which for a reboot
 * would mean issuing shutdown at a machine of the same short name in the wrong place.
 */
function domainFromDn(distinguishedName) {
    var parts = String(distinguishedName).split(",");
    var domainParts = [];

    for (var i = 0; i < parts.length; i++) {
        var part = parts[i].replace(/^\s+|\s+$/g, "");
        if (part.toUpperCase().indexOf("DC=") === 0) {
            domainParts.push(part.substring(3));
        }
    }
    return domainParts.join(".");
}

/**
 * Reads a property that may not exist on this version of the plug-in.
 */
function readProperty(object, propertyName) {
    try {
        var value = object[propertyName];
        return (value === undefined) ? null : value;
    }
    catch (e) {
        return null;
    }
}

/**
 * A computer account that has been disabled is skipped -- a decommissioned machine
 * should not be a reboot target, and should not be reported as a failure every run.
 *
 * Active Directory records this in two ways and plug-in versions differ over which they
 * expose, so both are checked. Bit 2 of userAccountControl is the disabled flag.
 */
function isDisabled(computer) {
    if (readProperty(computer, "disabled") === true) {
        return true;
    }

    var flags = readProperty(computer, "userAccountControl");
    if (flags !== null && (Number(flags) & 2) === 2) {
        return true;
    }

    return false;
}

/**
 * Returns the DIRECT members of the group, split into the computers and the nested
 * groups. The nested groups are read only so they can be REPORTED -- they are never
 * opened.
 *
 * This plug-in exposes them as typed lists on the group itself: 'computerMembers' holds
 * the AD:ComputerAD objects and 'groupMembers' the nested AD:UserGroup ones. Some
 * versions name the same pair 'computers' and 'groups', and older ones give a single
 * mixed list instead, so both are tried after it and the mixed list is sorted out by
 * type. Anything that is neither -- a user account, a contact -- is not a server and is
 * ignored, which is the other half of S-7's filtering.
 */
function directMembersOf(group) {
    var computers = readProperty(group, "computerMembers");
    if (computers === null) {
        computers = readProperty(group, "computers");
    }

    var groups = readProperty(group, "groupMembers");
    if (groups === null) {
        groups = readProperty(group, "groups");
    }

    if (computers !== null || groups !== null) {
        return {
            computers  : computers || [],
            groups     : groups || [],
            readByName : true
        };
    }

    var mixed = readProperty(group, "members");
    if (mixed === null) {
        // No typed list and no mixed list either. Say so rather than report an empty
        // group, which reads as "nothing to do" and is not the same thing at all.
        return { computers : [], groups : [], readByName : false };
    }

    var sortedComputers = [];
    var sortedGroups = [];

    for (var i = 0; i < mixed.length; i++) {
        var type = String(System.getObjectType(mixed[i]));
        if (type.indexOf("Computer") !== -1) {
            sortedComputers.push(mixed[i]);
        }
        else if (type.indexOf("Group") !== -1) {
            sortedGroups.push(mixed[i]);
        }
        // A user or a contact is not a server, so it is ignored.
    }

    return { computers : sortedComputers, groups : sortedGroups, readByName : true };
}

// ---------------------------------------------------------------------------
// Read the group's direct membership
// ---------------------------------------------------------------------------
if (adGroup === null || adGroup === undefined) {
    throw new Error("getGroupComputersDirect: no group was supplied.");
}

System.log("Reading the DIRECT members of Active Directory group: " + adGroup.distinguishedName);
System.log("Nested groups are NOT expanded -- only what is directly in this group is a reboot target.");

var members = directMembersOf(adGroup);

// A group whose membership the plug-in would not report at all is not an empty group.
// Treating it as one would end the run reporting "no servers require a reboot" while
// every server in it sat unpatched, so it stops here instead.
if (members.readByName === false) {
    throw new Error(
        "getGroupComputersDirect: this Active Directory plug-in did not report the membership of '" +
        adGroup.name + "'. None of computers / computerMembers / groups / groupMembers / members " +
        "was present on the group. Run the probeAdPlugin action to see how this plug-in reports " +
        "membership, and adjust directMembersOf to match."
    );
}

System.log(
    adGroup.name + " -- " + members.computers.length + " direct computer member(s), " +
    members.groups.length + " direct nested group(s)"
);

// ---------------------------------------------------------------------------
// Keep the enabled computers
// ---------------------------------------------------------------------------
var foundComputers = {};   // keyed by name, so a machine listed twice is rebooted once
var skippedDisabled = [];

for (var c = 0; c < members.computers.length; c++) {
    var computer = members.computers[c];
    var name = String(computer.name);

    if (isDisabled(computer)) {
        System.log("    skipping " + name + " - its computer account is disabled.");
        skippedDisabled.push(name);
        continue;
    }

    var domain = domainFromDn(computer.distinguishedName);
    foundComputers[(name + "." + domain).toLowerCase()] = true;
}

var computerNames = [];
for (var key in foundComputers) {
    computerNames.push(key);
}
computerNames.sort();

// ---------------------------------------------------------------------------
// Say what was left out, and why
// ---------------------------------------------------------------------------
// A sub-group sitting in the reboot group is the one thing most likely to be
// misread as "those servers are covered". It is deliberately not expanded, so it
// has to be said out loud on the run that ignored it -- not left for someone to
// notice months later when those machines turn out never to have been rebooted.
if (members.groups.length > 0) {
    var nestedNames = [];
    for (var g = 0; g < members.groups.length; g++) {
        nestedNames.push(String(members.groups[g].name));
    }

    System.warn(
        "'" + adGroup.name + "' contains " + members.groups.length + " nested group(s): " +
        nestedNames.join(", ") + ". Their members were NOT included and will NOT be rebooted. " +
        "Reboot targeting is deliberately direct-membership only (change S-7) so that a group " +
        "added here cannot enrol its servers into a reboot without anyone deciding to. To reboot " +
        "those servers, add the computer accounts to '" + adGroup.name + "' directly, or run this " +
        "workflow again against each nested group."
    );
}

System.log(
    "Found " + computerNames.length + " enabled, direct computer member(s) of '" + adGroup.name + "'" +
    (skippedDisabled.length > 0 ? ", skipped " + skippedDisabled.length + " disabled (" + skippedDisabled.join(", ") + ")" : "") +
    (members.groups.length > 0 ? ", ignored " + members.groups.length + " nested group(s)" : "") + "."
);

// Finding nothing is a legitimate answer, but it is far more often a sign that the
// wrong group was picked -- or that the servers are one level down in a sub-group that
// this action will not open. The calling workflow stops on an empty list rather than
// reporting a successful run that rebooted nothing.
if (computerNames.length === 0) {
    System.warn(
        "No enabled computers are DIRECT members of '" + adGroup.name + "'." +
        (members.groups.length > 0
            ? " It holds " + members.groups.length + " nested group(s), which this action does not open -- " +
              "that is very likely where the servers are."
            : " Check that the group holds computer accounts rather than user accounts, and run the " +
              "probeAdPlugin action to confirm the plug-in is reporting membership.")
    );
}

return computerNames;
