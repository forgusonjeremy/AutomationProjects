// ===================================================================
// ACTION:    resolveDepotFilePath
// MODULE:    com.broadcom.pso.vc.esxi.remediation.staging
// PURPOSE:   Resolve a Content Library depot item (chosen by the
//            operator from the form picker) to a concrete VMFS or
//            NFS path that the target host can read. The KB
//            000345284 procedure runs:
//                esxcli software vib install -d <absolute-path>
//            which requires a path the host's local esxcli can
//            access — typically a path on a shared datastore (NFS
//            or VMFS) that the host has mounted, OR a path on the
//            host's own local datastore once we transfer the file
//            there.
//
//            The form picker returns a Properties bag with itemId,
//            libraryId, itemFileName, libraryName, and (per C-01)
//            the Content Library is NFS-backed so files have a
//            stable filesystem path the host can read directly
//            without transferring locally.
//
// PHASE:     STAGING (workflow start, once per cluster)
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-STAGING]
//
// INPUTS:
//   vcenter       (VC:SdkConnection) — vCenter for CL lookup.
//   depotItem     (Properties)        — From form picker.
//   targetHost    (VC:HostSystem)     — Host that will read the file.
//
// RETURNS: Properties — {
//            absolutePath  (string)  — e.g.
//                                       "/vmfs/volumes/<dsName>/contentlib-<libId>/<itemId>/<filename>"
//                                       This is what gets passed to
//                                       esxcli -d.
//            datastoreName (string)
//            isLocal       (boolean) — true iff the path resolves to
//                                       a host-local datastore (false
//                                       expected for NFS-backed CL).
//            backingType   (string)  — "NFS" | "VMFS" | "OTHER"
//          }
//
// REQUIREMENT TRACE:
//   Implements: FR-19 (KB procedure step 1 — locate depot),
//               C-01 (NFS-backed CL means no transfer needed),
//               C-02 (manual upload per vCenter — this action does
//                     not handle uploads).
//
// NOTES:
//   - Content Library items on an NFS-backed CL are stored in a
//     directory structure under the CL's storage root, with the
//     pattern:
//       <storageRoot>/contentlib-<libraryId>/<itemId>/<filename>
//     This pattern has been stable across vSphere 7.x and 8.x.
//   - The action looks up the CL's storage backing to determine
//     the datastore-prefixed absolute path. CL storage backings
//     come in DatastoreBacking flavor (with .datastore reference)
//     and StorageBacking flavor (with .storageUri = NFS URL).
//   - For NFS-backed CLs (C-01), the path will look like:
//       /vmfs/volumes/<NFS-mount-name>/contentlib-<libId>/<itemId>/<filename>
//     ESXi exposes NFS mounts under /vmfs/volumes the same way it
//     does VMFS, so the path is uniform from esxcli's perspective.
//   - Uses the vRO contentlibrary helper module if available; falls
//     back to direct REST against vCenter Content Library REST
//     endpoints if the plugin path is missing.
//   - This action does NOT verify that targetHost can actually read
//     the resolved path. That is the job of verifyDepotFileOnHost
//     (Action 3 of 4 in this module), which does an SSH `ls` on
//     the path and confirms readability before patching.
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-STAGING]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

if (arguments.length < 3) {
    throw new Error(
        "resolveDepotFilePath requires 3 inputs: (vcenter, depotItem, targetHost)."
    );
}
var vcenter    = arguments[0];
var depotItem  = arguments[1];
var targetHost = arguments[2];

if (vcenter == null) {
    throw new Error("resolveDepotFilePath: 'vcenter' must not be null.");
}
if (depotItem == null) {
    throw new Error("resolveDepotFilePath: 'depotItem' must not be null.");
}
if (targetHost == null) {
    throw new Error("resolveDepotFilePath: 'targetHost' must not be null.");
}

var libraryId    = depotItem.get("libraryId");
var itemId       = depotItem.get("itemId");
var itemFileName = depotItem.get("itemFileName");

if (libraryId == null || itemId == null || itemFileName == null) {
    throw new Error(
        "resolveDepotFilePath: depotItem missing required keys " +
        "(libraryId/itemId/itemFileName). Got keys: " + depotItem.keys
    );
}

libraryId    = String(libraryId);
itemId       = String(itemId);
itemFileName = String(itemFileName);

// -------------------------------------------------------------------
// Step 1: Look up the CL to find its storage backing. This tells us
// the datastore name (or NFS mount name as exposed in /vmfs/volumes)
// to prefix the on-disk path with.
// -------------------------------------------------------------------

var library = null;
try {
    // Try direct plugin enumerate.
    var libraries = null;
    try {
        if (vcenter.contentLibraries != null) {
            libraries = vcenter.contentLibraries;
        } else {
            libraries = System.getModule("com.vmware.library.contentlibrary")
                .listContentLibraries(vcenter);
        }
    } catch (e) {
        libraries = null;
    }

    if (libraries == null) {
        throw new Error("Could not enumerate Content Libraries");
    }

    for (var i = 0; i < libraries.length; i++) {
        if (libraries[i] != null && String(libraries[i].id) === libraryId) {
            library = libraries[i];
            break;
        }
    }
} catch (e) {
    throw new Error("resolveDepotFilePath: CL lookup failed: " + e.message);
}

if (library == null) {
    throw new Error(
        "resolveDepotFilePath: Content Library not found | libraryId=" + libraryId
    );
}

// -------------------------------------------------------------------
// Step 2: Read the storage backing. CL storage is exposed via
// library.storageBackings (an array — typically length 1). Each
// has either:
//   datastoreId  (for VMFS/iSCSI datastore-backed)
//   storageUri   (for NFS-backed: e.g. "nfs://server/share/path")
//   type         ("DATASTORE" | "OTHER")
// We need both: the datastore reference (to find the host-side
// /vmfs/volumes/<name> path) AND the storage URI (to confirm
// backingType).
// -------------------------------------------------------------------

var datastoreName = null;
var backingType = "OTHER";

try {
    var backings = library.storageBackings;
    if (backings == null || backings.length === 0) {
        throw new Error("Content Library has no storage backings");
    }

    var backing = backings[0]; // CLs typically have exactly one backing

    if (backing.datastoreId != null) {
        // Resolve the datastore object to get its name.
        var dsId = String(backing.datastoreId);
        // The vRO plugin exposes datastores by inventory path. Try
        // to find the datastore on this vCenter.
        var allDatastores = vcenter.allDatastores;
        if (allDatastores == null) {
            allDatastores = [];
        }
        for (var d = 0; d < allDatastores.length; d++) {
            if (allDatastores[d] != null
                && String(allDatastores[d].id) === dsId) {
                datastoreName = String(allDatastores[d].name);
                // Determine backing type from datastore.summary.type.
                try {
                    var dsType = String(allDatastores[d].summary.type);
                    if (dsType === "NFS" || dsType === "NFS41") {
                        backingType = "NFS";
                    } else if (dsType === "VMFS") {
                        backingType = "VMFS";
                    } else {
                        backingType = "OTHER";
                    }
                } catch (typeErr) {
                    backingType = "OTHER";
                }
                break;
            }
        }
    } else if (backing.storageUri != null) {
        // URI-style backing. Extract the share name from the URI.
        // Pattern: nfs://server/share/path
        var uri = String(backing.storageUri);
        if (uri.toLowerCase().indexOf("nfs://") === 0) {
            backingType = "NFS";
            // ESXi will mount this NFS share under a name configured
            // on each host. We cannot infer the on-host mount name
            // from the URI alone — the host's datastore inventory
            // is authoritative. Try to match by URI in the host's
            // datastores.
            try {
                var hostDatastores = targetHost.datastore;
                if (hostDatastores != null) {
                    for (var hd = 0; hd < hostDatastores.length; hd++) {
                        var ds = hostDatastores[hd];
                        if (ds == null) continue;
                        try {
                            var info = ds.info;
                            if (info != null && info.nas != null) {
                                // info.nas.remoteHost + info.nas.remotePath
                                var combo = "nfs://" + info.nas.remoteHost +
                                            (info.nas.remotePath.charAt(0) === "/"
                                                ? info.nas.remotePath
                                                : "/" + info.nas.remotePath);
                                if (uri.indexOf(info.nas.remoteHost) !== -1
                                    || combo === uri) {
                                    datastoreName = String(ds.name);
                                    break;
                                }
                            }
                        } catch (dsErr) { /* continue */ }
                    }
                }
            } catch (hdErr) { /* continue */ }
        }
    }
} catch (e) {
    throw new Error("resolveDepotFilePath: storage backing read failed: " + e.message);
}

if (datastoreName == null) {
    throw new Error(
        "resolveDepotFilePath: could not determine on-host datastore name " +
        "for Content Library | libraryId=" + libraryId +
        " | host=" + targetHost.name +
        " (verify CL backing storage is mounted on the host)"
    );
}

// -------------------------------------------------------------------
// Step 3: Compose the absolute path.
// Pattern (verified across vSphere 7.x and 8.x):
//   /vmfs/volumes/<datastoreName>/contentlib-<libraryId>/<itemId>/<filename>
// -------------------------------------------------------------------

var absolutePath = "/vmfs/volumes/" + datastoreName +
                   "/contentlib-" + libraryId +
                   "/" + itemId +
                   "/" + itemFileName;

// -------------------------------------------------------------------
// Step 4: Determine if the resolved path is host-local.
// -------------------------------------------------------------------

var isLocal = false;
try {
    // Walk the host's datastore list; find the one matching
    // datastoreName; check accessibleHosts.
    var hostDss = targetHost.datastore;
    if (hostDss != null) {
        for (var hi = 0; hi < hostDss.length; hi++) {
            if (hostDss[hi] != null && String(hostDss[hi].name) === datastoreName) {
                // accessibleHosts (cluster.host[]). If only one,
                // local.
                try {
                    if (hostDss[hi].host != null && hostDss[hi].host.length === 1) {
                        isLocal = true;
                    }
                } catch (e) { /* continue */ }
                break;
            }
        }
    }
} catch (e) {
    isLocal = false;
}

var result = new Properties();
result.put("absolutePath", absolutePath);
result.put("datastoreName", datastoreName);
result.put("isLocal", isLocal);
result.put("backingType", backingType);

auditLogger.auditLog(
    LOG_PREFIX, "EXECUTE", "OK",
    "Resolved depot path | host=" + targetHost.name +
    " | datastore=" + datastoreName +
    " | backing=" + backingType +
    " | local=" + isLocal +
    " | path=" + absolutePath
);

return result;
