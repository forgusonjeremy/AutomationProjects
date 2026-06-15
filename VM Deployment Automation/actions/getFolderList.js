/**
 * Action: getFolderList
 * Module: com.broadcom.pso.vcfa.customForms
 *
 * Purpose:
 *   Returns a sorted list of VM folders in a given vCenter for populating
 *   folder selection dropdowns in catalog request forms.
 *
 * Prerequisites:
 *   - vCenter Server plugin configured and connected in Orchestrator
 *
 * Inputs:
 *   vcenterName {string} - vCenter sdkId as returned by getVCenterList
 *
 * Output:
 *   {Array} Sorted array of VM folder path strings
 */

try {
    if (!vcenterName) throw new Error("Input 'vcenterName' is required.");

    System.log("getFolderList: vcenterName='" + vcenterName + "'");

    var connections  = Server.findAllForType("VC:SdkConnection");
    var vcConnection = null;

    for (var i = 0; i < connections.length; i++) {
        if (connections[i].id === vcenterName) {
            vcConnection = connections[i];
            break;
        }
    }

    if (!vcConnection) {
        throw new Error("No vCenter SDK connection found with sdkId: '" + vcenterName + "'");
    }

    var allFolders = vcConnection.getAllVmFolders();
    System.log("getFolderList: Found " + allFolders.length + " VM folder(s).");

    if (!allFolders || allFolders.length === 0) {
        System.warn("getFolderList: No folders found for vCenter: " + vcenterName);
        return [];
    }

    function buildFolderPath(folder) {
        var pathParts = [];
        var entity    = folder;

        while (entity !== null && entity !== undefined) {
            pathParts.unshift(entity.name);
            var parent = null;
            try { parent = entity.parent; } catch (e) { break; }
            if (!parent) break;
            entity = parent;
        }

        // Path looks like: [vcenterHost, datacenterName, "vm", folderName, ...]
        // Strip everything up to and including the "vm" container
        var vmIndex = -1;
        for (var p = 0; p < pathParts.length; p++) {
            if (pathParts[p] === "vm") { vmIndex = p; break; }
        }

        if (vmIndex >= 0) {
            return pathParts.slice(vmIndex + 1).join("/");
        }

        return pathParts.join("/");
    }

    var folderList = [];

    for (var f = 0; f < allFolders.length; f++) {
        var folder = allFolders[f];
        if (!folder || !folder.name) continue;

        var folderPath = buildFolderPath(folder);
        if (folderPath) {
            folderList.push(folderPath);
        }
    }

    // Sort hierarchically: split each path into segments and compare
    // segment by segment so parent ordering is respected at every level.
    folderList.sort(function(a, b) {
        var aParts = a.split("/");
        var bParts = b.split("/");
        var len    = Math.min(aParts.length, bParts.length);

        for (var s = 0; s < len; s++) {
            var cmp = aParts[s].toLowerCase().localeCompare(bParts[s].toLowerCase());
            if (cmp !== 0) return cmp;
        }

        // If all compared segments are equal, shorter path sorts first
        return aParts.length - bParts.length;
    });

    System.log("getFolderList: Returned " + folderList.length + " folder path(s).");
    return folderList;

} catch (e) {
    System.error("getFolderList FAILED: " + e.message);
    throw e;
}
