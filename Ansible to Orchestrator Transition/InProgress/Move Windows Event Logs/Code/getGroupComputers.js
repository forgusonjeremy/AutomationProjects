/**
 * Action:  getGroupComputers
 * Module:  com.broadcom.pso.windows.logs
 *
 * WHAT IT DOES
 *   Takes an Active Directory group and returns the full names of every computer in it,
 *   including computers inside nested groups.
 *
 *   This is the job the Ansible playbooks did by running Get-ADGroupMember over WinRM.
 *   Here it is done by the Orchestrator Active Directory plug-in instead, so no
 *   PowerShell runs and no credentials go anywhere -- the plug-in uses the account
 *   already stored against the AD endpoint.
 *
 * INPUTS (in this order)
 *   adGroup  AD:UserGroup  the group to expand
 *
 * RETURNS
 *   Array/string -- computer names such as ["srv01.connect.lab", "srv02.connect.lab"]
 *
 * ABOUT NESTED GROUPS AND MULTIPLE DOMAINS
 *   Groups are followed down through as many levels as they nest, and a group that has
 *   already been visited is not visited twice -- otherwise two groups that contain each
 *   other would loop forever.
 *
 *   The group handed in is a starting point, not the answer. It is perfectly ordinary for
 *   it to hold no computers at all and only other groups -- a "Servers" group made up of
 *   "Servers-London" and "Servers-Frankfurt", say. Every level is opened and the computers
 *   are collected from wherever they actually sit, so what comes back is the whole tree
 *   flattened. Nothing is judged empty until the walk has finished.
 *
 *   A machine that appears in several of those groups is listed once.
 *
 *   Each computer's full name is built from its own distinguishedName, not from the
 *   group's. A group in one domain can contain computers from another, and building the
 *   name this way gets those right instead of quietly pointing at the wrong domain.
 */

/**
 * Turns  CN=SRV01,OU=Servers,DC=connect,DC=lab  into  connect.lab
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
 * should not be treated as a failure every time the workflow runs.
 *
 * Active Directory records this in two ways and plug-in versions differ over which
 * they expose, so both are checked. Bit 2 of userAccountControl is the disabled flag.
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
 * Returns the members of a group, split into the computers and the nested groups.
 *
 * This plug-in exposes them as typed lists on the group itself: 'computerMembers' holds
 * the AD:ComputerAD objects and 'groupMembers' the nested AD:UserGroup ones -- confirmed
 * against the deployed plug-in with probeAdPlugin. Some versions name the same pair
 * 'computers' and 'groups', and older ones give a single mixed list instead, so both are
 * tried after it and the mixed list is sorted out by type.
 *
 * Only lists of MEMBERS belong here. A property holding the groups this group is itself
 * a member of would walk the tree upwards and pull in machines that are not in scope, so
 * nothing is read on a guess -- run probeAdPlugin to see which of these a group carries.
 */
function membersOf(group) {
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
            computers : computers || [],
            groups    : groups || [],
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
        // Anything else (a user, a contact) is not a server, so it is ignored.
    }

    return { computers : sortedComputers, groups : sortedGroups, readByName : true };
}

// ---------------------------------------------------------------------------
// Walk the group
// ---------------------------------------------------------------------------
if (adGroup === null || adGroup === undefined) {
    throw new Error("getGroupComputers: no group was supplied.");
}

var visitedGroups = {};    // group DNs already expanded
var foundComputers = {};   // keyed by name, so a machine in two groups is listed once
var skippedCount = 0;
var groupsExpanded = 0;
var unreadableGroups = []; // groups whose membership this plug-in would not report at all

/**
 * Collects every computer in this group and in every group nested inside it, however
 * deep that goes.
 *
 * A group is only a container: it may hold computers, or only other groups, or a mix.
 * A group with no computers of its own is an ordinary shape, not an empty result -- the
 * machines can all sit one or more levels further down, and the walk carries on until
 * there is nothing left to open. Only the total at the very end says whether anything
 * was found.
 *
 * depth is for the log alone, so the shape of the tree can be read off the run.
 */
function expand(group, depth) {
    var groupDn = String(group.distinguishedName).toLowerCase();
    var indent = new Array(depth + 1).join("    ");

    // Two groups that contain each other would otherwise loop forever, and a group
    // reachable by two paths would be opened twice for no benefit.
    if (visitedGroups[groupDn] === true) {
        System.log(indent + group.name + " -- already expanded, not opening it again.");
        return;
    }
    visitedGroups[groupDn] = true;
    groupsExpanded++;

    var members = membersOf(group);

    if (members.readByName === false) {
        unreadableGroups.push(group.name);
    }

    System.log(
        indent + group.name + " -- " + members.computers.length + " computer(s), " +
        members.groups.length + " nested group(s)"
    );

    for (var c = 0; c < members.computers.length; c++) {
        var computer = members.computers[c];
        var name = String(computer.name);

        if (isDisabled(computer)) {
            System.log(indent + "    skipping " + name + " - its computer account is disabled.");
            skippedCount++;
            continue;
        }

        var domain = domainFromDn(computer.distinguishedName);
        foundComputers[(name + "." + domain).toLowerCase()] = true;
    }

    for (var g = 0; g < members.groups.length; g++) {
        expand(members.groups[g], depth + 1);
    }
}

System.log("Expanding Active Directory group: " + adGroup.distinguishedName);

expand(adGroup, 0);

// ---------------------------------------------------------------------------
// Hand back the list
// ---------------------------------------------------------------------------
var computerNames = [];
for (var key in foundComputers) {
    computerNames.push(key);
}
computerNames.sort();

System.log(
    "Found " + computerNames.length + " enabled computer(s)" +
    (skippedCount > 0 ? ", skipped " + skippedCount + " disabled" : "") +
    " across " + groupsExpanded + " group(s), starting at " + adGroup.name + "."
);

// A group whose membership the plug-in would not report at all is not an empty group.
// Treating it as one would move logs from an incomplete set of servers and call that a
// successful run, so it stops here instead.
if (unreadableGroups.length > 0) {
    throw new Error(
        "getGroupComputers: this Active Directory plug-in did not report the membership of " +
        unreadableGroups.join(", ") + ". None of computers / computerMembers / groups / " +
        "groupMembers / members was present on the group. Run the probeAdPlugin action to see " +
        "how this plug-in reports membership, and adjust membersOf to match."
    );
}

// Finding nothing is worth saying out loud. It is a legitimate answer, but it is far
// more often a sign that the wrong group was picked, and the workflow that calls this
// will stop rather than report a successful run that did nothing.
//
// This is judged on the total from the whole tree, never on the top group alone. A group
// that holds only other groups contributes no computers itself and is not a problem.
if (computerNames.length === 0) {
    System.warn(
        "No enabled computers were found in '" + adGroup.name + "' or in the " +
        (groupsExpanded - 1) + " group(s) nested inside it. If that is unexpected, check that " +
        "those groups hold computer accounts rather than user accounts, and run the " +
        "probeAdPlugin action to confirm the plug-in is reporting membership."
    );
}

return computerNames;
