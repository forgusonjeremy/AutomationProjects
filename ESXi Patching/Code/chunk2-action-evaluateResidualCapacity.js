// ===================================================================
// ACTION:    evaluateResidualCapacity
// MODULE:    com.broadcom.pso.vc.esxi.remediation.preflight
// PURPOSE:   Dynamically determine whether the cluster has enough
//            redundancy headroom to safely take the next host into
//            maintenance mode. Called immediately before each
//            MM_ENTER step, NOT once at workflow start. Implements
//            the AD-04 hybrid policy:
//              * 3-node clusters: BLOCKED unconditionally.
//              * 4-node clusters: ALLOWED with explicit
//                acknowledgement (Ack2) at workflow start; this
//                action does the per-host residual check.
//              * 5+ node clusters: ALLOWED with 1-host headroom;
//                this action verifies headroom remains before each
//                MM entry.
//
// PHASE:     VALIDATE / DECIDE (per-host, between hosts)
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-PREFLIGHT]
//
// INPUTS:
//   cluster                    (VC:ClusterComputeResource)
//   nextHost                   (VC:HostSystem) — the host about to
//                              be put in MM (i.e. excluded from
//                              capacity calc).
//   alreadyFailedHostMoRefs    (Array/string) — hosts that failed
//                              earlier in this run; must not count
//                              toward capacity. Per AD-09 a host
//                              that failed at HA_REJOIN is broken
//                              even if connected.
//   smallClusterAcknowledged   (boolean) — whether Ack2 was checked
//                              at submission. Required for 4-node
//                              clusters; ignored for others.
//
// RETURNS: Properties — {
//            canProceed       (boolean) — true iff MM entry on
//                                          nextHost is permitted.
//            mode             (string)  — "BLOCK_3_NODE",
//                                         "PROCEED_4_NODE_ACK",
//                                         "PROCEED_FLOOR_OK",
//                                         "BLOCK_FLOOR_VIOLATION",
//                                         "BLOCK_4_NODE_NO_ACK"
//            currentMargin    (number)  — hosts that would still be
//                                          patchable-capacity after
//                                          MM entry (signed).
//            reason           (string)
//            details          (Properties) — contributing values:
//                              { totalHosts, healthyHosts,
//                                lockdownHosts, failedHosts,
//                                hostsAlreadyInMM, ftt }
//          }
//
// REQUIREMENT TRACE:
//   Implements: AD-04 (hybrid 3-node/4-node/5+-node policy),
//               FR-26 (residual capacity rule), FR-27 (HA_REJOIN
//               failures don't count toward capacity).
//
// CAPACITY MATH:
//   capacityHosts = (connected, not-in-MM, not-failed-this-run, not-in-lockdown)
//
//   For VxRail at vSAN FTT=1, the cluster needs FTT+1=2 hosts to
//   maintain redundancy. After taking nextHost into MM, the
//   capacityHosts count must be:
//     - Total cluster size 3 → BLOCKED unconditionally per AD-04.
//     - Total cluster size 4 → must be >= 3 AFTER MM entry
//       (= FTT+1+0 headroom) AND smallClusterAcknowledged.
//     - Total cluster size >= 5 → must be >= 4 AFTER MM entry
//       (= FTT+1+1 headroom).
//
// NOTES:
//   - "lockdown" hosts contribute to capacity since they remain
//     online and serving (per AD-09); we do not subtract them from
//     the count.
//   - "alreadyInMM" hosts (other than nextHost) DO NOT contribute
//     to capacity — they are not serving workloads.
//   - For 4-node clusters with Ack2: the check is "after this MM,
//     do we still have 3 capacity hosts?" — equivalent to "are
//     all OTHER hosts healthy?" Failure of any other host tips the
//     cluster below FTT minimum.
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-PREFLIGHT]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

if (arguments.length < 4) {
    throw new Error(
        "evaluateResidualCapacity requires 4 inputs: " +
        "(cluster, nextHost, alreadyFailedHostMoRefs, smallClusterAcknowledged)."
    );
}
var cluster = arguments[0];
var nextHost = arguments[1];
var alreadyFailedHostMoRefs = arguments[2];
var smallClusterAcknowledged = arguments[3];

if (cluster == null) {
    throw new Error("evaluateResidualCapacity: 'cluster' must not be null.");
}
if (nextHost == null) {
    throw new Error("evaluateResidualCapacity: 'nextHost' must not be null.");
}
if (alreadyFailedHostMoRefs == null) {
    alreadyFailedHostMoRefs = [];
}
if (typeof smallClusterAcknowledged !== "boolean") {
    smallClusterAcknowledged = false;
}

// Index failed hosts for fast lookup.
var failedSet = {};
for (var f = 0; f < alreadyFailedHostMoRefs.length; f++) {
    failedSet[String(alreadyFailedHostMoRefs[f])] = true;
}

var nextHostMoRef = String(nextHost.id);

// -------------------------------------------------------------------
// Walk hosts and tally each category.
// -------------------------------------------------------------------

var hosts = cluster.host;
if (hosts == null) hosts = [];

var totalHosts = hosts.length;
var healthyHosts = 0;     // connected, not in MM, not failed
var lockdownHosts = 0;    // connected, locked-down (count toward capacity)
var failedHosts = 0;      // failed this run
var hostsAlreadyInMM = 0;

for (var i = 0; i < hosts.length; i++) {
    var host = hosts[i];
    if (host == null) continue;

    var moRef = String(host.id);

    if (moRef === nextHostMoRef) {
        // Excluding the nextHost from the capacity calc — this is
        // the simulated post-MM-entry world.
        continue;
    }

    if (failedSet.hasOwnProperty(moRef)) {
        failedHosts++;
        continue;
    }

    var connState = "(unknown)";
    var inMM = false;
    try {
        if (host.runtime != null) {
            if (host.runtime.connectionState != null) {
                connState = String(host.runtime.connectionState.value);
            }
            inMM = host.runtime.inMaintenanceMode === true;
        }
    } catch (e) {
        connState = "(unknown)";
    }

    if (connState !== "connected") {
        // Disconnected hosts don't contribute to capacity.
        continue;
    }

    if (inMM) {
        hostsAlreadyInMM++;
        continue;
    }

    // Lockdown check.
    var lockdownMode = "(unknown)";
    try {
        if (host.config != null && host.config.lockdownMode != null) {
            lockdownMode = typeof host.config.lockdownMode === "string"
                ? host.config.lockdownMode
                : String(host.config.lockdownMode.value);
        } else {
            lockdownMode = "lockdownDisabled";
        }
    } catch (e) {
        lockdownMode = "lockdownDisabled";
    }

    if (lockdownMode === "lockdownNormal" || lockdownMode === "lockdownStrict") {
        lockdownHosts++;
        // Locked-down hosts CONTRIBUTE to capacity (they're online).
        healthyHosts++;
    } else {
        healthyHosts++;
    }
}

// -------------------------------------------------------------------
// Determine FTT. We default to 1 (FTT=1 is the standard VxRail
// minimum). If the cluster's HA admission control reports
// FAILURES_TO_TOLERATE we use that value; otherwise FTT=1 stands.
// -------------------------------------------------------------------

var ftt = 1;
try {
    var haCheck = System.getModule("com.broadcom.pso.vc.esxi.remediation.preflight")
        .checkClusterHaHealth(cluster);
    if (haCheck != null && haCheck.get("admissionControlMode") === "FAILURES_TO_TOLERATE") {
        var declared = Number(haCheck.get("failuresToTolerate"));
        if (declared > 0) {
            ftt = declared;
        }
    }
} catch (e) {
    // Stick with default ftt=1.
}

// -------------------------------------------------------------------
// Apply AD-04 hybrid policy.
// -------------------------------------------------------------------

var details = new Properties();
details.put("totalHosts", totalHosts);
details.put("healthyHosts", healthyHosts);
details.put("lockdownHosts", lockdownHosts);
details.put("failedHosts", failedHosts);
details.put("hostsAlreadyInMM", hostsAlreadyInMM);
details.put("ftt", ftt);

var result = new Properties();
result.put("details", details);

// 3-node = BLOCKED
if (totalHosts === 3) {
    result.put("canProceed", false);
    result.put("mode", "BLOCK_3_NODE");
    result.put("currentMargin", -999); // not meaningful for blocked
    result.put("reason", "3-node clusters are blocked per AD-04 hybrid policy.");
    auditLogger.auditLog(
        LOG_PREFIX, "VALIDATE", "FAIL",
        "Residual capacity | cluster=" + cluster.name +
        " | BLOCK_3_NODE"
    );
    return result;
}

// Required minimum healthyHosts AFTER taking nextHost into MM.
// FTT+1 = bare minimum to maintain redundancy.
var fttFloor = ftt + 1;

if (totalHosts === 4) {
    if (!smallClusterAcknowledged) {
        result.put("canProceed", false);
        result.put("mode", "BLOCK_4_NODE_NO_ACK");
        result.put("currentMargin", healthyHosts - fttFloor);
        result.put("reason",
            "4-node cluster requires explicit acknowledgement (Ack2). " +
            "smallClusterAcknowledged=false."
        );
        auditLogger.auditLog(
            LOG_PREFIX, "VALIDATE", "FAIL",
            "Residual capacity | cluster=" + cluster.name +
            " | BLOCK_4_NODE_NO_ACK"
        );
        return result;
    }
    // With ack: require healthyHosts >= fttFloor (no headroom).
    var canProceed4 = healthyHosts >= fttFloor;
    result.put("canProceed", canProceed4);
    result.put("mode", canProceed4 ? "PROCEED_4_NODE_ACK" : "BLOCK_FLOOR_VIOLATION");
    result.put("currentMargin", healthyHosts - fttFloor);
    result.put("reason",
        canProceed4
            ? "4-node cluster with Ack2; healthyHosts=" + healthyHosts +
              " >= floor=" + fttFloor + " after MM entry on " + nextHost.name + "."
            : "4-node cluster: would have only " + healthyHosts +
              " healthy host(s) after MM entry; floor=" + fttFloor + ". Halting cluster."
    );
    auditLogger.auditLog(
        LOG_PREFIX, "VALIDATE", canProceed4 ? "OK" : "FAIL",
        "Residual capacity | cluster=" + cluster.name +
        " | " + result.get("mode") +
        " | healthy=" + healthyHosts + "/floor=" + fttFloor
    );
    return result;
}

// 5+ node clusters: require fttFloor + 1 headroom.
var requiredCapacity = fttFloor + 1;
var canProceedN = healthyHosts >= requiredCapacity;

result.put("canProceed", canProceedN);
result.put("mode", canProceedN ? "PROCEED_FLOOR_OK" : "BLOCK_FLOOR_VIOLATION");
result.put("currentMargin", healthyHosts - requiredCapacity);
result.put("reason",
    canProceedN
        ? totalHosts + "-node cluster; healthyHosts=" + healthyHosts +
          " >= required=" + requiredCapacity +
          " (FTT+1+headroom) after MM entry on " + nextHost.name + "."
        : totalHosts + "-node cluster: would have only " + healthyHosts +
          " healthy host(s) after MM entry; required=" + requiredCapacity +
          " (FTT+1+headroom). Halting cluster to preserve 1-host margin."
);

auditLogger.auditLog(
    LOG_PREFIX, "VALIDATE", canProceedN ? "OK" : "FAIL",
    "Residual capacity | cluster=" + cluster.name +
    " | " + result.get("mode") +
    " | healthy=" + healthyHosts + "/required=" + requiredCapacity
);

return result;
