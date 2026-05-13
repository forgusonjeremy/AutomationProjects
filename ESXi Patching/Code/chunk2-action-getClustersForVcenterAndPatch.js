// ===================================================================
// ACTION:    getClustersForVcenterAndPatch
// MODULE:    com.broadcom.pso.vc.esxi.remediation.form
// PURPOSE:   List clusters in the selected vCenter, each labeled
//            with cluster type and a brief health/eligibility tag
//            (per FR-9). When a depot has been selected, the labels
//            additionally surface depot-version-mismatch warnings
//            inline (per C-12 architect direction — patch is
//            selected before clusters, so the picker re-renders
//            with version-aware labels once the depot is chosen).
//
//            Source for the cluster picker (Section 4 of the form).
//
// PHASE:     form-time
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-FORM]
//
// INPUTS:
//   vcenter    (VC:SdkConnection)
//   depotItem  (Properties)         — Selected depot item from
//                                      getDepotItemsForVcenter, or
//                                      null if not yet selected.
//
// RETURNS: Array/Properties — entries:
//          { label: "<clusterName> (<TYPE> — <STATUS>: <reason>)",
//            value: <VC:ClusterComputeResource> }
//          BLOCKED clusters are still in the list (visible) but
//          their value remains the cluster object — the form's
//          field validation prevents the operator from selecting
//          BLOCKED entries.
//
// REQUIREMENT TRACE:
//   Implements: FR-7 (Section 4 cluster picker), FR-9 (label
//               format), FR-10 (re-render with version awareness
//               when depot selected), C-12 (architect direction),
//               AD-12 (validation summary source).
//
// NOTES:
//   - When depotItem is null, labels reflect cluster type and
//     baseline health only (no version comparison).
//   - When depotItem is not null, labels include depot version
//     mismatch warnings.
//   - Label semantics (per FR-9):
//       (VXRAIL — READY)        → Selectable, no findings
//       (VXRAIL — WARNING: ...) → Selectable, warnings present
//       (VXRAIL — BLOCKED: ...) → Visible but not selectable
//       (POWERFLEX — NOT SUPPORTED)
//       (VSAN-ONLY — NOT SUPPORTED)
//       (OTHER — NOT SUPPORTED)
//   - This action calls evaluateClusterPreflightCheap. Form-time
//     re-render performance: each cluster takes a few SDK calls;
//     for a typical 5-10 cluster vCenter the action returns in a
//     few seconds. If a customer has a much larger cluster count,
//     a faster lighter-weight pre-check could be added.
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-FORM]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

if (arguments.length < 1) {
    throw new Error("getClustersForVcenterAndPatch requires 1-2 inputs: (vcenter, [depotItem]).");
}
var vcenter = arguments[0];
var depotItem = arguments.length >= 2 ? arguments[1] : null;

if (vcenter == null) {
    return []; // form not yet ready
}

var depotName = "";
if (depotItem != null) {
    var fn = depotItem.get("itemFileName");
    if (fn != null) {
        depotName = String(fn);
    }
}

var entries = [];

// -------------------------------------------------------------------
// Find all clusters in this vCenter. The pattern uses
// rootFolder.childEntity recursive walk via the vCenter helper.
// -------------------------------------------------------------------

var clusters = [];
try {
    // The vCenter plugin exposes clusters via the inventory tree.
    // The simplest cross-version approach is via the
    // "com.vmware.library.vc.cluster" helper if available, or the
    // root folder traversal.
    try {
        clusters = System.getModule("com.vmware.library.vc.cluster")
            .getAllClusterComputeResources(vcenter);
    } catch (e) {
        // Fall back: walk the root folder.
        clusters = walkForClusters(vcenter.rootFolder);
    }
} catch (e) {
    auditLogger.auditLog(
        LOG_PREFIX, "DISCOVER", "FAIL",
        "Could not enumerate clusters | vcenter=" + vcenter.name +
        " | error=" + e.message
    );
    return [];
}

if (clusters == null) clusters = [];

// -------------------------------------------------------------------
// Helper: walk an inventory folder tree to find clusters.
// -------------------------------------------------------------------
function walkForClusters(folder) {
    var found = [];
    if (folder == null) return found;

    var children = null;
    try {
        children = folder.childEntity;
    } catch (e) {
        return found;
    }
    if (children == null) return found;

    for (var c = 0; c < children.length; c++) {
        var child = children[c];
        if (child == null) continue;

        // Detect cluster vs other types via duck-typing.
        var typeStr = "";
        try {
            typeStr = String(child);
        } catch (e) { /* continue */ }

        if (typeStr.indexOf("ClusterComputeResource") !== -1) {
            found.push(child);
        } else if (typeStr.indexOf("Datacenter") !== -1) {
            // Datacenters have hostFolder.
            try {
                var hf = child.hostFolder;
                if (hf != null) {
                    var sub = walkForClusters(hf);
                    for (var s = 0; s < sub.length; s++) {
                        found.push(sub[s]);
                    }
                }
            } catch (dcErr) { /* continue */ }
        } else if (typeStr.indexOf("Folder") !== -1) {
            var sub2 = walkForClusters(child);
            for (var s2 = 0; s2 < sub2.length; s2++) {
                found.push(sub2[s2]);
            }
        }
    }

    return found;
}

// -------------------------------------------------------------------
// Per-cluster: run the cheap pre-flight and build a labeled entry.
// We pass smallClusterAcknowledged=true so 4-node clusters surface
// as INFO not CRITICAL during picker render — operator hasn't
// reached the 4-node ack yet at this stage. The final form
// validation will recheck Ack2 on submit.
//
// Same for ignoreWarnings=false: we want all warnings to surface
// in the picker so the operator sees them in the picker labels
// AND in the Validation Summary.
// -------------------------------------------------------------------

var preflight = System.getModule("com.broadcom.pso.vc.esxi.remediation.preflight");

for (var i = 0; i < clusters.length; i++) {
    var cluster = clusters[i];
    if (cluster == null) continue;

    var clusterName = "(unknown)";
    try {
        clusterName = String(cluster.name);
    } catch (e) {
        continue;
    }

    var label;
    var clusterType;
    try {
        var pf = preflight.evaluateClusterPreflightCheap(
            cluster,
            depotName,
            true,   // smallClusterAcknowledged: don't penalize 4-node at picker time
            false   // ignoreWarnings: surface all warnings in label
        );

        clusterType = pf.get("clusterType");
        var status = pf.get("status");
        var findings = pf.get("findings");

        if (clusterType !== "VXRAIL") {
            // Non-VxRail: not supported.
            label = clusterName + " (" + clusterType + " — NOT SUPPORTED)";
        } else if (status === "BLOCKED") {
            // Find the most prominent CRITICAL finding to surface.
            var primary = "Failed pre-flight";
            for (var fi = 0; fi < findings.length; fi++) {
                if (findings[fi].severity === "CRITICAL") {
                    primary = findings[fi].message;
                    break;
                }
            }
            // Truncate to keep picker readable.
            if (primary.length > 80) primary = primary.substring(0, 77) + "...";
            label = clusterName + " (VXRAIL — BLOCKED: " + primary + ")";
        } else if (status === "WARNING") {
            var warnPrimary = "warnings";
            for (var wi = 0; wi < findings.length; wi++) {
                if (findings[wi].severity === "WARNING") {
                    warnPrimary = findings[wi].message;
                    break;
                }
            }
            if (warnPrimary.length > 80) warnPrimary = warnPrimary.substring(0, 77) + "...";
            label = clusterName + " (VXRAIL — WARNING: " + warnPrimary + ")";
        } else {
            label = clusterName + " (VXRAIL — READY)";
        }

    } catch (e) {
        // Pre-flight evaluation threw. Surface as a NOT SUPPORTED
        // entry rather than dropping the cluster from the list.
        label = clusterName + " (UNKNOWN — preflight error: " + e.message + ")";
    }

    var entry = new Properties();
    entry.put("label", label);
    entry.put("value", cluster);
    entries.push(entry);
}

// Sort alphabetically by cluster name (label has cluster name
// prefix, so label sort works).
entries.sort(function(a, b) {
    var la = String(a.get("label")).toLowerCase();
    var lb = String(b.get("label")).toLowerCase();
    if (la < lb) return -1;
    if (la > lb) return 1;
    return 0;
});

auditLogger.auditLog(
    LOG_PREFIX, "DISCOVER", "OK",
    "Listed clusters with preflight labels | vcenter=" + vcenter.name +
    " | depotSelected=" + (depotName !== "") +
    " | count=" + entries.length
);

return entries;
