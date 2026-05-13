// ===================================================================
// ACTION:    getDepotChecksum
// MODULE:    com.broadcom.pso.vc.esxi.remediation.staging
// PURPOSE:   Retrieve the SHA-256 (preferred) or SHA-1 (fallback)
//            checksum of the depot file as recorded by vCenter
//            Content Library when the file was uploaded. Used by
//            verifyDepotFileOnHost to confirm the host can read
//            the same bytes that vCenter has on file (catches
//            corrupt NFS mounts and similar pathology before we
//            try to install).
//
// PHASE:     STAGING
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-STAGING]
//
// INPUTS:
//   vcenter   (VC:SdkConnection)
//   depotItem (Properties) — From form picker (must contain
//                             itemId).
//
// RETURNS: Properties — {
//            algorithm  (string) — "SHA-256" | "SHA-1" | "(none)"
//            checksum   (string) — Hex-encoded checksum, lowercase.
//                                  Empty string when algorithm is
//                                  "(none)".
//          }
//
// REQUIREMENT TRACE:
//   Implements: FR-19 (KB procedure step 1 — verify depot integrity).
//
// NOTES:
//   - vCenter Content Library tracks per-file checksums when the
//     file was uploaded via the CL UI / API. The metadata is
//     exposed at:
//       library.item.<itemId>.file.<fileName>.checksumInfo
//     where checksumInfo has fields: algorithm, checksum.
//   - vCenter typically records SHA-256 for items uploaded post-7.0.
//     Older items may have only SHA-1, or no checksum at all.
//   - When no checksum is recorded (algorithm="(none)"), the
//     downstream verifier will skip the integrity check and warn —
//     the workflow does not abort just because vCenter doesn't
//     have a checksum on file.
//   - Implementation: vRO contentlibrary helper module's
//     getItemFileInfo if available; direct REST against
//     /api/content/library/item/file as fallback.
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-STAGING]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

if (arguments.length < 2) {
    throw new Error("getDepotChecksum requires 2 inputs: (vcenter, depotItem).");
}
var vcenter   = arguments[0];
var depotItem = arguments[1];

if (vcenter == null) {
    throw new Error("getDepotChecksum: 'vcenter' must not be null.");
}
if (depotItem == null) {
    throw new Error("getDepotChecksum: 'depotItem' must not be null.");
}

var itemId       = depotItem.get("itemId");
var itemFileName = depotItem.get("itemFileName");
if (itemId == null || itemFileName == null) {
    throw new Error("getDepotChecksum: depotItem missing itemId/itemFileName.");
}
itemId = String(itemId);
itemFileName = String(itemFileName);

var result = new Properties();
result.put("algorithm", "(none)");
result.put("checksum", "");

// -------------------------------------------------------------------
// Probe via plugin helper. The exact accessor varies across vRO/
// vSphere versions; we try a few candidates.
// -------------------------------------------------------------------

var info = null;

try {
    // Candidate 1: helper module getItemFileInfo
    info = System.getModule("com.vmware.library.contentlibrary")
        .getItemFileInfo(vcenter, itemId, itemFileName);
} catch (e1) {
    info = null;
}

if (info == null) {
    try {
        // Candidate 2: helper module listItemFiles + filter
        var allFiles = System.getModule("com.vmware.library.contentlibrary")
            .listItemFiles(vcenter, itemId);
        if (allFiles != null) {
            for (var i = 0; i < allFiles.length; i++) {
                if (allFiles[i] != null && String(allFiles[i].name) === itemFileName) {
                    info = allFiles[i];
                    break;
                }
            }
        }
    } catch (e2) {
        info = null;
    }
}

if (info == null) {
    auditLogger.auditLog(
        LOG_PREFIX, "EXECUTE", "WARN",
        "Could not retrieve depot file info from CL helper | itemId=" + itemId +
        " | filename=" + itemFileName +
        " | proceeding without checksum"
    );
    return result;
}

// -------------------------------------------------------------------
// Pull the checksum out of the file info object.
// -------------------------------------------------------------------

try {
    if (info.checksumInfo != null) {
        var ci = info.checksumInfo;
        var algo = "(unknown)";
        if (ci.algorithm != null) {
            algo = typeof ci.algorithm === "string"
                ? ci.algorithm
                : String(ci.algorithm.value);
        }
        var sum = ci.checksum != null ? String(ci.checksum) : "";

        // Normalize algorithm string. The vSphere API uses
        // "SHA256" or "SHA1" (no dash); KB / VMware docs use
        // "SHA-256" / "SHA-1". Normalize to dashed form.
        if (algo === "SHA256") algo = "SHA-256";
        else if (algo === "SHA1") algo = "SHA-1";
        else if (algo === "MD5") algo = "MD5";

        result.put("algorithm", algo);
        result.put("checksum", sum.toLowerCase());
    } else {
        // No checksum recorded on this file.
        result.put("algorithm", "(none)");
        result.put("checksum", "");
    }
} catch (e) {
    auditLogger.auditLog(
        LOG_PREFIX, "EXECUTE", "WARN",
        "Could not parse checksumInfo | itemId=" + itemId +
        " | error=" + e.message
    );
}

auditLogger.auditLog(
    LOG_PREFIX, "EXECUTE", "OK",
    "Depot checksum retrieved | itemId=" + itemId +
    " | algorithm=" + result.get("algorithm")
);

return result;
