/**
 * Action: resolveVm
 * Module: com.corp.serverreboot
 *
 * Find the vCenter VM for an AD computer across ALL registered vCenters.
 * Primary match: SearchIndex.findByDnsName (uses the DNS name VMware Tools reports).
 * Fallback match: name index (lazy, Tools-independent) so we can distinguish
 *                 "found but Tools/power off" from "genuinely no VM".
 *
 * @param {string}  dnsHostName - AD computer dNSHostName (FQDN), lowercased
 * @param {string}  cn          - AD computer short name, lowercased
 * @param {Array}   nameIndex   - optional preloaded fallback: Array/Properties of
 *                                { name:String, vm:VC:VirtualMachine }
 * @returns {Properties} { vm:VC:VirtualMachine|null, matchedBy:String,
 *                         ambiguous:Boolean }
 */

if (!dnsHostName && !cn) {
    throw "resolveVm: need at least one of dnsHostName / cn.";
}

var connections = VcPlugin.allSdkConnections || [];
System.debug("[reboot] Resolving '" + (dnsHostName || cn) + "' across " +
    connections.length + " vCenter connection(s).");

// --- Primary: DNS name reported by VMware Tools, per vCenter -----------------
if (dnsHostName) {
    for (var i = 0; i < connections.length; i++) {
        var conn = connections[i];
        try {
            // findByDnsName(datacenter=null -> whole vCenter, dnsName, vmSearch=true)
            var vm = conn.searchIndex.findByDnsName(null, dnsHostName, true);
            if (vm) {
                System.log("[reboot] '" + dnsHostName + "' -> VM '" + vm.name +
                    "' via Tools DNS on " + conn.name);
                return { vm: vm, matchedBy: "toolsDns", ambiguous: false };
            }
        } catch (e) {
            System.warn("[reboot] findByDnsName error on " + conn.name + ": " + e);
        }
    }
}

// --- Fallback: name index (only distinguishes reporting; never guesses reboot) ---
if (nameIndex && nameIndex.length > 0) {
    var matches = [];
    var targets = [dnsHostName, cn];
    for (var n = 0; n < nameIndex.length; n++) {
        var entry = nameIndex[n];
        var entryName = (entry.name || "").toLowerCase();
        var entryShort = entryName.split(".")[0];
        for (var t = 0; t < targets.length; t++) {
            var want = (targets[t] || "").toLowerCase();
            if (!want) { continue; }
            var wantShort = want.split(".")[0];
            if (entryName === want || entryShort === wantShort) {
                matches.push(entry.vm);
                break;
            }
        }
    }
    if (matches.length === 1) {
        System.log("[reboot] '" + (dnsHostName || cn) + "' -> VM '" +
            matches[0].name + "' via name fallback.");
        return { vm: matches[0], matchedBy: "name", ambiguous: false };
    }
    if (matches.length > 1) {
        System.warn("[reboot] Ambiguous name match for '" + (dnsHostName || cn) +
            "' (" + matches.length + " VMs) -> will be skipped, never guessed.");
        return { vm: null, matchedBy: "name", ambiguous: true };
    }
}

return { vm: null, matchedBy: "none", ambiguous: false };
