/**
 * Action: getFolderList
 * Module: com.vcf.guestcustomization
 *
 * Purpose:
 *   Returns a list of VM folders in a given vCenter datacenter for populating
 *   folder selection dropdowns in catalog request forms.
 *
 * Prerequisites:
 *   - vCenter Server plugin configured and connected in Orchestrator
 *
 * Inputs:
 *   datacenterName {string} - vCenter datacenter display name
 *
 * Output:
 *   {string} JSON array: [{name, path, moRef}]
 *   Path format: full path from datacenter VM folder root
 *   Example: "Datacenter/vm/Production/WebTier"
 *
 * Notes:
 *   - vimType values must be validated for your vCenter SDK version (V4 validation item)
 *   - folderName input in blueprints must use the full path format returned here
 */

try {
    if (!datacenterName) throw new Error("Input 'datacenterName' is required.");

    System.log("getFolderList: Searching for VM folders in datacenter: " + datacenterName);

    var folderList  = [];
    var allFolders  = VcPlugin.getAllFolders();

    if (!allFolders || allFolders.length === 0) {
        System.warn("getFolderList: No folders found in vCenter inventory.");
        return JSON.stringify([]);
    }

    /**
     * Recursively builds the full folder path from datacenter root.
     * @param {VcFolder} folder
     * @returns {string} full path string
     */
    function buildFolderPath(folder) {
        var pathParts = [];
        var entity    = folder;

        while (entity && entity.vimType !== "Datacenter") {
            pathParts.unshift(entity.name);
            entity = entity.parent;
        }

        if (entity && entity.name === datacenterName) {
            pathParts.unshift(entity.name);
            return pathParts.join("/");
        }

        return null; // Folder is not under the target datacenter
    }

    for (var i = 0; i < allFolders.length; i++) {
        var folder = allFolders[i];

        // Filter: VM folders only (vimType — validate for your SDK version, V4)
        if (!folder.vimType || folder.vimType !== "Folder") {
            continue;
        }

        var fullPath = buildFolderPath(folder);
        if (!fullPath) continue;

        folderList.push({
            name:  folder.name,
            path:  fullPath,
            moRef: folder.reference.value
        });
    }

    System.log("getFolderList: Returned " + folderList.length + " folder(s) in datacenter: " + datacenterName);
    return JSON.stringify(folderList);

} catch (e) {
    System.error("getFolderList FAILED: " + e.message);
    throw e;
}
