/**
 * Action: buildVmNameIndex
 * Module: com.corp.serverreboot
 *
 * Build a Tools-independent { name -> VM } list across ALL registered vCenters,
 * used ONLY as a fallback locator for precise reporting (found-but-Tools-off vs
 * no-VM). Heavy call: enumerates every VM. Invoke LAZILY - only when at least
 * one AD member fails the primary Tools-DNS resolution.
 *
 * @returns {Array/Properties} each: { name:String (lowercased), vm:VC:VirtualMachine }
 */

System.log("[reboot] Building fallback VM name index across all vCenters (lazy).");

var index = [];
var all = [];
try {
    // Returns all VMs from every registered vCenter connection.
    all = Server.findAllForType("VC:VirtualMachine") || [];
} catch (e) {
    System.warn("[reboot] Server.findAllForType failed: " + e +
        " -- fallback name matching disabled for this run.");
    return index;
}

for (var i = 0; i < all.length; i++) {
    var vm = all[i];
    try {
        index.push({ name: (vm.name || "").toLowerCase(), vm: vm });
    } catch (e) {
        // Skip unreadable entries rather than fail the whole index.
    }
}
System.log("[reboot] Fallback VM name index built: " + index.length + " VM(s).");
return index;
