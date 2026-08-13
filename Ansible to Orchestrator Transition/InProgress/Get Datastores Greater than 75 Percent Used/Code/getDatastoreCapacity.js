/**
 * ACTION: getDatastoreCapacity
 * Module : com.broadcom.pso.vc.storage.reporting
 *
 * Collects capacity, free space and thin-provisioning commitment for every
 * datastore visible on ONE vCenter SDK connection, and returns the subset at or
 * above a minimum percent-used threshold.
 *
 * This action replaces the PowerCLI collection loop in the
 * 'get_datastores_75_100_used' case of the customer's shared cvs_functions.ps1.
 * It uses the vRO vCenter plug-in directly — there is no PowerShell host, no
 * PowerCLI module, and no separately stored vCenter credential.
 *
 * -- INPUTS -------------------------------------------------------------------
 *   Name                  Type              Description
 *   --------------------------------------------------------------------------
 *   vcenterSdkConnection  VC:SdkConnection  The vCenter connection to inventory.
 *   minPercentUsed        number            Inclusive floor. A datastore is
 *                                           returned when percentUsed >= this
 *                                           value. Pass 70 to match the
 *                                           behaviour of the retiring playbook.
 *   includeInaccessible   boolean           When true, datastores reporting
 *                                           accessible=false are still returned
 *                                           (with whatever capacity figures
 *                                           vCenter last knew) instead of being
 *                                           skipped and logged.
 *
 * -- RETURN TYPE --------------------------------------------------------------
 *   string  JSON object. Never throws for a per-datastore problem; a datastore
 *           that cannot be read is counted in skipped[] and the scan continues.
 *
 *   Shape:
 *   {
 *     vcenterName:   "vc01.corp.local",
 *     scannedAtMs:   <epoch ms>,
 *     totalSeen:     412,          // datastores enumerated on this vCenter
 *     datastores: [
 *       {
 *         name:            "PROD-VMFS-014",
 *         moRef:           "datastore-18",
 *         vcenterName:     "vc01.corp.local",
 *         datacenter:      "DC-EAST",     // "" if it could not be resolved
 *         datastoreCluster:"SDRS-PROD",   // "" if not in a StoragePod
 *         type:            "VMFS",
 *         accessible:      true,
 *         maintenanceMode: "normal",
 *         capacityGB:      2048,
 *         usedGB:          1904,
 *         freeSpaceGB:     144,
 *         uncommittedGB:   310,
 *         uncommittedKnown:true,   // false => vCenter did not publish the value
 *         percentUsed:     92.97,
 *         percentFree:     7.03,
 *         overcommitted:   true     // uncommitted > freeSpace (see note below)
 *       }, ...
 *     ],
 *     skipped: [
 *       { name:"OLD-NFS-02", moRef:"datastore-91", reason:"zero or unreadable capacity" }
 *     ]
 *   }
 *
 * -- NOTE ON 'overcommitted' --------------------------------------------------
 *   The retiring PowerShell collected a datastore ONLY when
 *   (percentUsed > threshold) AND (uncommitted > freeSpace). That AND meant a
 *   datastore at 99% used with little thin-provisioned growth outstanding was
 *   never reported at all. This action drops the AND and returns every datastore
 *   over the threshold, carrying the original condition as the boolean
 *   'overcommitted' so the report can still highlight it. See change P-36.
 *
 * -- VERSION DEPENDENCIES -----------------------------------------------------
 *   vRO / VCF Operations Orchestrator 8.11+ (validated on the VCF 9 embedded
 *   Orchestrator). vCenter plug-in must have at least one registered endpoint.
 *   All properties read here (DatastoreSummary.capacity / .freeSpace /
 *   .uncommitted / .accessible / .type / .maintenanceMode) are core vSphere API
 *   properties present in every supported vCenter release.
 */

var BYTES_IN_GB = 1073741824;

var vcName = "unknown";
try {
    vcName = vcenterSdkConnection.name || vcenterSdkConnection.url || "unknown";
} catch (eName) {
    vcName = "unknown";
}

var result = {
    vcenterName: vcName,
    scannedAtMs: new Date().getTime(),
    totalSeen:   0,
    datastores:  [],
    skipped:     []
};

// ─────────────────────────────────────────────────────────────────────────────
// Placement map: datastore MoRef -> { datacenter, datastoreCluster }
//
// Built top-down from rootFolder > Datacenter > datastoreFolder, recursing
// through nested folders and StoragePods (datastore clusters). Branching is on
// the MoRef id prefix rather than a type name, which is stable across releases:
//   datastore-*  a Datastore
//   group-p*     a StoragePod (datastore cluster)
//   group-s*     a Folder
//
// Placement is presentation detail only. If the traversal fails for any reason
// the map is simply left incomplete and the affected rows show blank columns —
// it must never cost us the capacity report itself.
// ─────────────────────────────────────────────────────────────────────────────
function buildPlacementMap(conn) {
    var map = {};

    function walk(entity, dcName, podName) {
        if (!entity) return;
        var children = null;
        try { children = entity.childEntity; } catch (eCe) { return; }
        if (!children) return;

        for (var i = 0; i < children.length; i++) {
            var child = children[i];
            var childId = "";
            try { childId = String(child.id || ""); } catch (eId) { continue; }

            if (childId.indexOf("datastore-") === 0) {
                map[childId] = { datacenter: dcName, datastoreCluster: podName };
            } else if (childId.indexOf("group-p") === 0) {
                // StoragePod — its name becomes the datastore cluster for children.
                var podLabel = podName;
                try { podLabel = child.name || podName; } catch (ePn) { /* keep */ }
                walk(child, dcName, podLabel);
            } else if (childId.indexOf("group-") === 0) {
                walk(child, dcName, podName);
            }
        }
    }

    try {
        var root = conn.rootFolder;
        var dcs  = root ? root.childEntity : null;
        if (!dcs) return map;

        for (var d = 0; d < dcs.length; d++) {
            var dc = dcs[d];
            var dcName = "";
            try { dcName = dc.name || ""; } catch (eDn) { dcName = ""; }
            var dsFolder = null;
            try { dsFolder = dc.datastoreFolder; } catch (eDf) { dsFolder = null; }
            if (dsFolder) walk(dsFolder, dcName, "");
        }
    } catch (eMap) {
        System.warn("[DATASTORE-REPORT] [INVENTORY] [WARN]   " + vcName +
                    ": could not build datacenter/cluster placement map — " +
                    eMap.message + " (capacity data is unaffected; the " +
                    "Datacenter and Datastore Cluster columns will be blank)");
    }
    return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// Collection
// ─────────────────────────────────────────────────────────────────────────────
var floorPct = Number(minPercentUsed);
if (isNaN(floorPct) || floorPct < 0 || floorPct > 100) {
    throw "getDatastoreCapacity: minPercentUsed must be a number between 0 and " +
          "100 — received '" + minPercentUsed + "'";
}

var placement = buildPlacementMap(vcenterSdkConnection);

// getAllDatastores() throws if the connection is down. That is deliberate: the
// caller (ST-02) catches it per vCenter, records the vCenter as unreachable and
// carries on with the remaining ones.
var datastores = vcenterSdkConnection.getAllDatastores();
if (!datastores) datastores = [];
result.totalSeen = datastores.length;

for (var i = 0; i < datastores.length; i++) {
    var ds     = datastores[i];
    var dsName = "";
    var dsId   = "";

    try {
        dsName = ds.name || "";
        dsId   = String(ds.id || "");
    } catch (eBasic) {
        result.skipped.push({ name: "(unreadable)", moRef: "", reason: "name/id not readable: " + eBasic.message });
        continue;
    }

    try {
        var s = ds.summary;
        if (!s) {
            result.skipped.push({ name: dsName, moRef: dsId, reason: "no summary published by vCenter" });
            continue;
        }

        var accessible = (s.accessible === true);
        if (!accessible && includeInaccessible !== true) {
            result.skipped.push({ name: dsName, moRef: dsId, reason: "datastore is inaccessible" });
            continue;
        }

        // Divide-by-zero guard. An inaccessible, unmounted or freshly removed
        // datastore reports capacity 0. The retiring PowerShell divided by this
        // unguarded, which raised a terminating error and killed the whole run
        // before any report was produced (see change P-35).
        var capacity = Number(s.capacity);
        if (isNaN(capacity) || capacity <= 0) {
            result.skipped.push({ name: dsName, moRef: dsId, reason: "zero or unreadable capacity" });
            continue;
        }

        var freeSpace = Number(s.freeSpace);
        if (isNaN(freeSpace) || freeSpace < 0) freeSpace = 0;

        // DatastoreSummary.uncommitted is OPTIONAL in the vSphere API and is not
        // published by every datastore type. Distinguish "no thin-provisioned
        // growth outstanding" from "vCenter did not tell us" so the report can
        // avoid asserting overcommit status it does not actually know.
        var uncommittedKnown = true;
        var uncommitted = 0;
        try {
            if (s.uncommitted === null || s.uncommitted === undefined) {
                uncommittedKnown = false;
            } else {
                uncommitted = Number(s.uncommitted);
                if (isNaN(uncommitted) || uncommitted < 0) {
                    uncommittedKnown = false;
                    uncommitted = 0;
                }
            }
        } catch (eUnc) {
            uncommittedKnown = false;
            uncommitted = 0;
        }

        var used        = capacity - freeSpace;
        var percentUsed = Math.round((used / capacity) * 10000) / 100;
        var percentFree = Math.round((freeSpace / capacity) * 10000) / 100;

        if (percentUsed < floorPct) continue;

        var place = placement[dsId] || { datacenter: "", datastoreCluster: "" };

        var dsType = "";
        try { dsType = s.type || ""; } catch (eType) { dsType = ""; }
        var mmode = "";
        try { mmode = s.maintenanceMode || ""; } catch (eMm) { mmode = ""; }

        result.datastores.push({
            name:             dsName,
            moRef:            dsId,
            vcenterName:      vcName,
            datacenter:       place.datacenter,
            datastoreCluster: place.datastoreCluster,
            type:             dsType,
            accessible:       accessible,
            maintenanceMode:  mmode,
            capacityGB:       Math.round(capacity  / BYTES_IN_GB),
            usedGB:           Math.round(used      / BYTES_IN_GB),
            freeSpaceGB:      Math.round(freeSpace / BYTES_IN_GB),
            uncommittedGB:    uncommittedKnown ? Math.round(uncommitted / BYTES_IN_GB) : null,
            uncommittedKnown: uncommittedKnown,
            percentUsed:      percentUsed,
            percentFree:      percentFree,
            overcommitted:    uncommittedKnown ? (uncommitted > freeSpace) : false
        });

    } catch (eDs) {
        // One unreadable datastore must not cost us the other 400.
        result.skipped.push({ name: dsName, moRef: dsId, reason: eDs.message });
    }
}

System.log("[DATASTORE-REPORT] [INVENTORY] [OK]     " + vcName + ": " +
           result.totalSeen + " datastore(s) enumerated, " +
           result.datastores.length + " at or above " + floorPct + "% used, " +
           result.skipped.length + " skipped.");

return JSON.stringify(result);
