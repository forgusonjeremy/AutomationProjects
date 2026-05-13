// ===================================================================
// ACTION:    getDepotItemsForVcenter
// MODULE:    com.broadcom.pso.vc.esxi.remediation.form
// PURPOSE:   List Content Library items in the selected vCenter
//            that look like ESXi depot ZIPs, filtered to Content
//            Libraries whose name contains the configured pattern
//            (per CE-01 esxiPatchContentLibraryNamePattern,
//            substring match per C-09).
//
//            Used as the source of the form's depot picker
//            (Section 3 of the request form).
//
// PHASE:     form-time
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-FORM]
//
// INPUTS:
//   vcenter                       (VC:SdkConnection)
//   contentLibraryNamePattern     (string) — substring pattern.
//                                  Caller passes the pattern from
//                                  CE-01. Pass empty string to use
//                                  default ("ESXi-Patches").
//
// RETURNS: Array/Properties — entries:
//          { label: "<filename> [<libraryName>]", value: Properties }
//          where 'value' contains:
//          { itemId, itemName, itemFileName, libraryId, libraryName,
//            createdTime, sizeBytes }
//
// REQUIREMENT TRACE:
//   Implements: FR-7 (Section 3 patch picker), FR-11 (CL filter
//               with substring match), C-09 (substring pattern).
//
// NOTES:
//   - Content Library items are accessed via the vCenter Content
//     Library API. In vRO 9.x the helper module
//     com.vmware.library.contentlibrary exposes the relevant
//     operations. Item type for ESXi depots is typically "iso"
//     or "ovf" — our depot ZIPs are exposed as type "iso" or as
//     a generic file item depending on how the customer uploads.
//     We do not filter by type; instead we filter by filename
//     pattern (.zip with VMware-ESXi prefix).
//   - Filename pattern: ^VMware-ESXi-.*-depot\.zip$ (per FR-11).
//   - The action returns Properties as the 'value' so the workflow
//     receives the resolution metadata (item ID, library ID) it
//     needs to look up the on-disk path later, rather than just
//     a CL item display name.
//   - vCenter Content Library REST endpoints used:
//       GET /api/content/library                  — list libraries
//       GET /api/content/library/item?library_id=  — list items
//       GET /api/content/library/item/{itemId}     — item detail
//     vRO's plugin abstracts these. We use the plugin where
//     possible and fall back to direct REST if the plugin doesn't
//     expose the needed shape.
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-FORM]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

if (arguments.length < 1) {
    throw new Error(
        "getDepotItemsForVcenter requires 1-2 inputs: " +
        "(vcenter, [contentLibraryNamePattern])."
    );
}
var vcenter = arguments[0];
var contentLibraryNamePattern = arguments.length >= 2 ? arguments[1] : "";

if (vcenter == null) {
    // Form-time external action: return empty array if input not
    // yet supplied (the form is still loading).
    return [];
}

if (typeof contentLibraryNamePattern !== "string"
    || contentLibraryNamePattern.length === 0) {
    contentLibraryNamePattern = "ESXi-Patches";
}

var entries = [];
var depotFilenamePattern = /^VMware-ESXi-.*-depot\.zip$/;

// -------------------------------------------------------------------
// Walk Content Libraries on this vCenter. The vRO content library
// helper module exposes findContentLibraryByName-style accessors.
// We use a generic enumerator: list all libraries on the vCenter
// and filter by name substring.
// -------------------------------------------------------------------

try {
    // The vCenter SDK exposes content library service via the
    // SDK connection. The helper module path varies; we use
    // direct plugin object access via vcenter.contentLibraries
    // or fall back to the vRO content library helper.
    var libraries = null;

    try {
        // Direct plugin field (if exposed).
        if (vcenter.contentLibraries != null) {
            libraries = vcenter.contentLibraries;
        }
    } catch (probeErr) {
        libraries = null;
    }

    if (libraries == null) {
        // Fallback: use the vRO content library helper module.
        // The helper module's listContentLibraries returns
        // an Array of ContentLibrary objects.
        try {
            libraries = System.getModule("com.vmware.library.contentlibrary")
                .listContentLibraries(vcenter);
        } catch (helperErr) {
            // Helper not available (some installations don't
            // ship the contentlibrary library module). Try
            // a different known path.
            try {
                libraries = System.getModule("com.vmware.library.vc.contentLibrary")
                    .findAllContentLibraries(vcenter);
            } catch (helper2Err) {
                throw new Error(
                    "Could not enumerate Content Libraries; no plugin or library helper available: " +
                    helper2Err.message
                );
            }
        }
    }

    if (libraries == null) libraries = [];

    for (var li = 0; li < libraries.length; li++) {
        var lib = libraries[li];
        if (lib == null) continue;

        var libName = "(unknown)";
        var libId = "(unknown)";
        try {
            libName = String(lib.name);
            libId = String(lib.id);
        } catch (e) {
            continue;
        }

        // Substring match per C-09.
        if (libName.indexOf(contentLibraryNamePattern) === -1) {
            continue;
        }

        // List items in this library.
        var items = null;
        try {
            if (lib.items != null) {
                items = lib.items;
            } else {
                items = System.getModule("com.vmware.library.contentlibrary")
                    .listItemsInLibrary(vcenter, libId);
            }
        } catch (itemErr) {
            // Skip this library on item enumeration failure.
            auditLogger.auditLog(
                LOG_PREFIX, "DISCOVER", "WARN",
                "Could not enumerate items in CL '" + libName + "': " + itemErr.message
            );
            continue;
        }

        if (items == null) items = [];

        for (var ii = 0; ii < items.length; ii++) {
            var item = items[ii];
            if (item == null) continue;

            var itemName = "(unknown)";
            var itemId = "(unknown)";
            var itemFileName = "(unknown)";

            try {
                itemName = String(item.name);
                itemId = String(item.id);
                // itemFileName is the actual on-disk filename; for
                // ESXi depots this is the .zip name.
                if (item.fileName != null) {
                    itemFileName = String(item.fileName);
                } else if (item.files != null && item.files.length > 0
                           && item.files[0].name != null) {
                    itemFileName = String(item.files[0].name);
                } else {
                    // Fall back to item name.
                    itemFileName = itemName;
                }
            } catch (e) {
                continue;
            }

            // Filename pattern filter.
            if (!depotFilenamePattern.test(itemFileName)) {
                continue;
            }

            // Build the value Properties.
            var value = new Properties();
            value.put("itemId", itemId);
            value.put("itemName", itemName);
            value.put("itemFileName", itemFileName);
            value.put("libraryId", libId);
            value.put("libraryName", libName);
            try {
                if (item.creationTime != null) {
                    value.put("createdTime", String(item.creationTime));
                }
            } catch (e) { /* optional */ }
            try {
                if (item.sizeBytes != null) {
                    value.put("sizeBytes", Number(item.sizeBytes));
                }
            } catch (e) { /* optional */ }

            var entry = new Properties();
            entry.put("label", itemFileName + " [" + libName + "]");
            entry.put("value", value);
            entries.push(entry);
        }
    }

} catch (e) {
    // Form-time external actions should not throw — they should
    // return an empty array and let the user pick again. Log the
    // error for diagnostics.
    auditLogger.auditLog(
        LOG_PREFIX, "DISCOVER", "FAIL",
        "Failed to enumerate depot items | vcenter=" + (vcenter.name != null ? vcenter.name : "?") +
        " | error=" + e.message
    );
    return [];
}

// Sort alphabetically by label.
entries.sort(function(a, b) {
    var la = String(a.get("label")).toLowerCase();
    var lb = String(b.get("label")).toLowerCase();
    if (la < lb) return -1;
    if (la > lb) return 1;
    return 0;
});

auditLogger.auditLog(
    LOG_PREFIX, "DISCOVER", "OK",
    "Listed depot items | vcenter=" + vcenter.name +
    " | pattern=" + contentLibraryNamePattern +
    " | count=" + entries.length
);

return entries;
