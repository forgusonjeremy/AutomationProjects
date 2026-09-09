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
 *   adGroup  AD:Group  the group to expand
 *
 * RETURNS
 *   Array/string -- computer names such as ["srv01.connect.lab", "srv02.connect.lab"]
 *
 * ABOUT NESTED GROUPS AND MULTIPLE DOMAINS
 *   Groups are followed down through as many levels as they nest, and a group that has
 *   already been visited is not visited twice -- otherwise two groups that contain each
 *   other would loop forever.
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
 * Returns the members of a group.
 *
 * The plug-in exposes membership as typed lists (computerMembers, groupMembers). Older
 * versions provide a single mixed list instead, so that is used as a fallback and the
 * items are sorted out by type.
 */
function membersOf(group) {
    var computers = readProperty(group, "computerMembers");
    var groups    = readProperty(group, "groupMembers");

    if (computers !== null || groups !== null) {
        return {
            computers : computers || [],
            groups    : groups || []
        };
    }

    var mixed = readProperty(group, "members") || [];
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

    return { computers : sortedComputers, groups : sortedGroups };
}

// ---------------------------------------------------------------------------
// Walk the group
// ---------------------------------------------------------------------------
if (adGroup === null || adGroup === undefined) {
    throw new Error("getGroupComputers: no group was supplied.");
}

var visitedGroups = {};   // group DNs already expanded
var foundComputers = {};  // keyed by name, so a machine in two groups is listed once
var skippedCount = 0;

function expand(group) {
    var groupDn = String(group.distinguishedName).toLowerCase();

    if (visitedGroups[groupDn] === true) {
        return;
    }
    visitedGroups[groupDn] = true;

    var members = membersOf(group);

    for (var c = 0; c < members.computers.length; c++) {
        var computer = members.computers[c];
        var name = String(computer.name);

        if (isDisabled(computer)) {
            System.log("Skipping " + name + " - its computer account is disabled.");
            skippedCount++;
            continue;
        }

        var domain = domainFromDn(computer.distinguishedName);
        foundComputers[(name + "." + domain).toLowerCase()] = true;
    }

    for (var g = 0; g < members.groups.length; g++) {
        System.log("Following nested group: " + members.groups[g].name);
        expand(members.groups[g]);
    }
}

System.log("Expanding Active Directory group: " + adGroup.distinguishedName);

expand(adGroup);

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
    " in " + adGroup.name + " and any groups nested inside it."
);

// An empty group is worth saying out loud. It is a legitimate answer, but it is far
// more often a sign that the wrong group was picked, and the workflow that calls this
// will stop rather than report a successful run that did nothing.
if (computerNames.length === 0) {
    System.warn(
        "Group '" + adGroup.name + "' contains no enabled computers. If that is unexpected, check " +
        "that it holds computer accounts rather than user accounts, and run the probeAdPlugin " +
        "action to confirm the plug-in is reporting its membership."
    );
}

return computerNames;
