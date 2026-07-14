/**
 * Action: getAdGroupComputers
 * Module: com.corp.serverreboot
 *
 * Resolve the DIRECT COMPUTER members of an Active Directory group to a
 * normalized list. Isolates all AD-plugin specifics so the rest of the pipeline
 * is plugin-agnostic.
 *
 * NON-RECURSIVE BY DESIGN — read this before changing anything below:
 *   - Only TOP-LEVEL (direct) members of the named group are considered.
 *   - Only COMPUTER account objects are returned. Users are ignored.
 *   - Sub-groups nested in the group are IGNORED, never traversed/expanded.
 *     We do not resolve the members of a member. There is intentionally no
 *     recursion here and no use of the recursive matching rule OID
 *     1.2.840.113556.1.4.1941 (LDAP_MATCHING_RULE_IN_CHAIN).
 *
 * @param {string} adGroupName - sAMAccountName / CN of the AD group (e.g. "Security-Reboot-Servers")
 * @returns {Array/Properties} each element: { cn:String, dnsHostName:String, dn:String }
 *
 * -----------------------------------------------------------------------------
 * !! VALIDATE PER YOUR AD PLUGIN VERSION !!
 * Group -> computer-member enumeration is the one area that varies across
 * Active Directory plugin versions. Two implementations are provided below;
 * BOTH are strictly direct-membership (non-recursive). Confirm which one your
 * plugin exposes in the vRO API Explorer before go-live:
 *   Primary : direct 'member' DN walk, each DN resolved as a computer only
 *   Fallback: LDAP filter for computers whose direct memberOf = group DN
 * Everything downstream only depends on the returned {cn, dnsHostName} shape.
 * -----------------------------------------------------------------------------
 */

if (!adGroupName) {
    throw "getAdGroupComputers: 'adGroupName' is required.";
}

System.log("[reboot] Resolving computer members of AD group: " + adGroupName);

function normalize(cn, dnsHostName, dn) {
    // Tools may report short name; AD may store FQDN. Keep both, lowercased.
    var short = (cn || "").toLowerCase();
    var fqdn = (dnsHostName || "").toLowerCase();
    if (!fqdn && short) { fqdn = short; } // best effort; resolver also tries short name
    return { cn: short, dnsHostName: fqdn, dn: dn || "" };
}

var results = [];

// --- Locate the group -------------------------------------------------------
var group = null;
try {
    // Common accessor; VALIDATE (some versions: ActiveDirectory.getUserGroup / .search)
    group = ActiveDirectory.getUserGroup(adGroupName);
} catch (e) {
    System.warn("[reboot] getUserGroup threw: " + e + " -- trying search()");
}
if (!group) {
    var found = ActiveDirectory.search("UserGroup", adGroupName) || [];
    if (found.length > 0) { group = found[0]; }
}
if (!group) {
    throw "getAdGroupComputers: AD group not found: " + adGroupName;
}

// --- Enumerate DIRECT computer members (non-recursive) ----------------------
// PRIMARY: walk the group's raw 'member' DNs. 'member' contains only DIRECT
// members (AD never lists nested-group members here), so this is inherently
// non-recursive. Each DN is resolved ONLY as a computer; anything that isn't a
// computer -- a user, or a nested SUB-GROUP -- is ignored and NOT traversed.
var memberDNs = [];
try {
    // 'member' is the multi-valued DN attribute of the group (direct members only).
    memberDNs = group.member || group.getProperty && group.getProperty("member") || [];
} catch (e) {
    System.warn("[reboot] Could not read group.member: " + e);
}

if (memberDNs && memberDNs.length > 0) {
    for (var i = 0; i < memberDNs.length; i++) {
        var dn = memberDNs[i];
        try {
            // Resolve as a COMPUTER only. Returns null for users AND for groups,
            // which is exactly what we want: sub-groups are skipped, never expanded.
            var comp = ActiveDirectory.getComputerAD(dn); // accepts DN or name; VALIDATE
            if (comp) {
                results.push(normalize(comp.name, comp.dnsHostName, dn));
            } else {
                // Non-computer direct member (user or nested group). Do NOT recurse.
                System.debug("[reboot] Ignoring non-computer direct member (not traversed): " + dn);
            }
        } catch (e) {
            System.warn("[reboot] Failed to resolve member DN '" + dn + "': " + e);
        }
    }
}

// FALLBACK: if the plugin did not surface member DNs, search computers by memberOf.
// 'memberOf=<groupDN>' matches DIRECT membership only. Do NOT change this to the
// recursive matching rule (memberOf:1.2.840.113556.1.4.1941:=<groupDN>) -- that
// would pull in computers from nested sub-groups, which we explicitly must not do.
if (results.length === 0) {
    System.warn("[reboot] No members via DN walk; attempting direct computer memberOf search.");
    try {
        var groupDn = group.distinguishedName || group.dn;
        var computers = ActiveDirectory.searchForObjectsWithType(
            "(&(objectCategory=computer)(memberOf=" + groupDn + "))", // DIRECT membership only
            "Computer"); // signature VALIDATE per plugin
        computers = computers || [];
        for (var j = 0; j < computers.length; j++) {
            var c = computers[j];
            results.push(normalize(c.name, c.dnsHostName, c.distinguishedName));
        }
    } catch (e) {
        System.warn("[reboot] memberOf search failed: " + e);
    }
}

if (results.length === 0) {
    System.warn("[reboot] AD group '" + adGroupName + "' returned 0 computer members.");
}
System.log("[reboot] AD group resolved to " + results.length + " computer(s).");
return results;
