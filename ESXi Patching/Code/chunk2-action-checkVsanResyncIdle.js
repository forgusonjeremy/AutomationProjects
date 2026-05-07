// ===================================================================
// ACTION:    checkVsanResyncIdle
// MODULE:    com.broadcom.pso.vc.esxi.remediation.preflight
// PURPOSE:   Detect whether vSAN resync (object replication / repair)
//            is currently active on the cluster. Patching during an
//            active resync amplifies the disruption — taking a host
//            into MM during resync can extend the resync window
//            significantly and may put the cluster at degraded
//            redundancy for longer than expected.
//
// PHASE:     VALIDATE (workflow-start-time only — too expensive for
//                       form-time)
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-PREFLIGHT]
//
// INPUTS:
//   cluster (VC:ClusterComputeResource)
//
// RETURNS: Properties — {
//            idle              (boolean) — true iff no active resync
//            totalBytesToSync  (number)  — bytes still to be resynced
//                                          (0 if idle)
//            totalRecoveryEta  (number)  — estimated remaining seconds
//                                          to completion (0 if idle)
//            objectsToSync     (number)  — count of objects still
//                                          syncing
//            reason            (string)
//            error             (string)  — non-empty if probe failed
//                                          (caller should treat
//                                           probe failure as warn,
//                                           not block).
//          }
//
// REQUIREMENT TRACE:
//   Implements: FR-16 (workflow-start-time check for active resync).
//
// NOTES:
//   - vSAN resync data is exposed via the vSAN Management API. In
//     the vRO vCenter plugin this surfaces via the vSAN namespace
//     methods on the cluster — exact method varies across vSphere
//     versions. The pattern uses
//     VsanVcStretchedClusterSystem / VsanVcClusterHealthSystem
//     entry points.
//   - Section 3h.2 marks the exact API path UNVERIFIED. This
//     action probes via a try/catch and returns a "probe failed"
//     result rather than throwing if the API is not available in
//     the runtime environment. Callers should not block on probe
//     failure — they should warn and let the operator decide.
//   - This action is intentionally permissive: when in doubt, it
//     reports idle=true with an error message describing what
//     went wrong. The vSAN resync check is one of many; if this
//     one cannot run, others (vSAN health curated, recent task
//     activity) will catch overlapping signals.
//   - Implementation uses the vRO vSAN library if present (path:
//     com.vmware.library.vsan.management.cluster), falling back to
//     direct Vc plugin object access otherwise.
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-PREFLIGHT]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

if (arguments.length < 1) {
    throw new Error("checkVsanResyncIdle requires 1 input: cluster.");
}
var cluster = arguments[0];

if (cluster == null) {
    throw new Error("checkVsanResyncIdle: 'cluster' must not be null.");
}

var result = new Properties();
result.put("idle", true);
result.put("totalBytesToSync", 0);
result.put("totalRecoveryEta", 0);
result.put("objectsToSync", 0);
result.put("reason", "Initial state");
result.put("error", "");

// -------------------------------------------------------------------
// Probe via the vSAN VcVsan extension. The cluster's parent vCenter
// SDK connection exposes a vSAN extension if the cluster is vSAN-
// enabled. Method names per vSphere 8.x:
//   VsanVcClusterHealthSystem.queryClusterHealthSummary
//   VsanVcClusterObjectSystem.queryObjectInformation
// Resync info specifically lives at:
//   VsanVcClusterObjectSystem.queryClusterObjectsResync(cluster)
//   → returns a ResyncResult with totalBytesToSync, totalRecoveryEta
//
// UNVERIFIED — Section 3h.2. Wrap in try/catch.
// -------------------------------------------------------------------

try {
    // Resolve the vCenter SDK connection via the cluster's parent
    // chain. cluster.sdkConnection is the vRO plugin convention.
    var sdkConn = cluster.sdkConnection;
    if (sdkConn == null) {
        throw new Error("Cluster has no associated SDK connection");
    }

    // The vSAN object system is reached via the vCenter content's
    // about-info → vSAN service-instance content. The method name
    // and exact path vary between SDK versions. Attempt the
    // canonical path used in vSphere 8.x:
    var vsanObjSys = null;
    try {
        // Newer vRO/vSphere combos expose
        // sdkConn.vsanQueryObjectSystem or similar.
        // Defensive probing — try several candidate accessors.
        if (sdkConn.vsanObjectSystem != null) {
            vsanObjSys = sdkConn.vsanObjectSystem;
        } else if (sdkConn.vsanClusterObjectSystem != null) {
            vsanObjSys = sdkConn.vsanClusterObjectSystem;
        }
    } catch (probeErr) {
        vsanObjSys = null;
    }

    if (vsanObjSys == null) {
        // Probe fallback: try reading direct cluster property if
        // exposed by plugin.
        try {
            if (cluster.queryClusterObjectsResync != null) {
                var resyncResult = cluster.queryClusterObjectsResync();
                if (resyncResult != null) {
                    var bytes = Number(resyncResult.totalBytesToSync != null
                        ? resyncResult.totalBytesToSync : 0);
                    var eta = Number(resyncResult.totalRecoveryEta != null
                        ? resyncResult.totalRecoveryEta : 0);
                    var objs = 0;
                    if (resyncResult.objectsResync != null
                        && resyncResult.objectsResync.length != null) {
                        objs = resyncResult.objectsResync.length;
                    }
                    result.put("totalBytesToSync", bytes);
                    result.put("totalRecoveryEta", eta);
                    result.put("objectsToSync", objs);
                    var idle = (bytes === 0 && objs === 0);
                    result.put("idle", idle);
                    result.put("reason", idle
                        ? "vSAN resync idle"
                        : "vSAN resync active | bytes=" + bytes +
                          " | objects=" + objs +
                          " | eta=" + eta + "s");
                    auditLogger.auditLog(
                        LOG_PREFIX, "VALIDATE", idle ? "OK" : "WARN",
                        "vSAN resync check | cluster=" + cluster.name +
                        " | " + result.get("reason")
                    );
                    return result;
                }
            }
        } catch (clusterProbeErr) {
            // Fall through to probe-failed path.
        }

        // Probe failed — report permissively.
        result.put("reason", "vSAN resync API unavailable in runtime; assuming idle");
        result.put("error", "vSAN object system accessor not found on SDK connection");
        auditLogger.auditLog(
            LOG_PREFIX, "VALIDATE", "WARN",
            "vSAN resync check | cluster=" + cluster.name +
            " | API unavailable, assuming idle"
        );
        return result;
    }

    // Use the resolved vsanObjSys.
    var resyncInfo = vsanObjSys.queryClusterObjectsResync(cluster);
    if (resyncInfo == null) {
        result.put("reason", "vSAN resync API returned null; assuming idle");
        return result;
    }

    var totalBytes = Number(resyncInfo.totalBytesToSync != null
        ? resyncInfo.totalBytesToSync : 0);
    var totalEta = Number(resyncInfo.totalRecoveryEta != null
        ? resyncInfo.totalRecoveryEta : 0);
    var objCount = 0;
    if (resyncInfo.objectsResync != null && resyncInfo.objectsResync.length != null) {
        objCount = resyncInfo.objectsResync.length;
    }

    result.put("totalBytesToSync", totalBytes);
    result.put("totalRecoveryEta", totalEta);
    result.put("objectsToSync", objCount);

    var idleFinal = (totalBytes === 0 && objCount === 0);
    result.put("idle", idleFinal);
    result.put("reason", idleFinal
        ? "vSAN resync idle"
        : "vSAN resync active | bytes=" + totalBytes +
          " | objects=" + objCount +
          " | eta=" + totalEta + "s");

    auditLogger.auditLog(
        LOG_PREFIX, "VALIDATE", idleFinal ? "OK" : "WARN",
        "vSAN resync check | cluster=" + cluster.name +
        " | " + result.get("reason")
    );

} catch (e) {
    // Whole probe failed. Permissive: report idle with the error.
    result.put("idle", true);
    result.put("reason", "vSAN resync probe failed; assuming idle");
    result.put("error", e.message);
    auditLogger.auditLog(
        LOG_PREFIX, "VALIDATE", "WARN",
        "vSAN resync probe threw, treating idle | cluster=" + cluster.name +
        " | error=" + e.message
    );
}

return result;
