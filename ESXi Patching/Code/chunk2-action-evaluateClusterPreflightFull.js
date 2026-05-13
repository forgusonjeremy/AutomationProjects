// ===================================================================
// ACTION:    evaluateClusterPreflightFull
// MODULE:    com.broadcom.pso.vc.esxi.remediation.preflight
// PURPOSE:   Run the FULL pre-flight check at workflow start. Calls
//            evaluateClusterPreflightCheap then adds the expensive
//            checks (vSAN resync, recent task activity) that are
//            only run once per workflow execution rather than every
//            form-time render.
//
//            Used by WF-01 just before dispatching cluster work.
//            State may have changed between form submission and
//            workflow start — this is the last gate before the
//            cluster is locked and processed.
//
// PHASE:     VALIDATE (workflow-start-time)
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-PREFLIGHT]
//
// INPUTS:
//   cluster                  (VC:ClusterComputeResource)
//   depotName                (string)
//   smallClusterAcknowledged (boolean)
//   ignoreWarnings           (boolean)
//   recentTaskLookbackMinutes (number) — How far back to scan task
//                                         history. Default 60.
//
// RETURNS: Properties — same shape as evaluateClusterPreflightCheap,
//          with the additional checks merged into 'findings'.
//
// REQUIREMENT TRACE:
//   Implements: FR-16 (workflow-start-time full check), AD-12
//               (validation summary source).
//
// NOTES:
//   - This action calls evaluateClusterPreflightCheap internally and
//     appends additional findings. The 'status' is recomputed after
//     the additional findings are added.
//   - Failures of the expensive probes themselves (e.g. vSAN API
//     unavailable) produce informational findings rather than
//     CRITICAL, consistent with the permissive philosophy of those
//     individual probe Actions.
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-PREFLIGHT]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

if (arguments.length < 4) {
    throw new Error(
        "evaluateClusterPreflightFull requires 4-5 inputs: " +
        "(cluster, depotName, smallClusterAcknowledged, ignoreWarnings, [recentTaskLookbackMinutes])."
    );
}
var cluster                   = arguments[0];
var depotName                 = arguments[1];
var smallClusterAcknowledged  = arguments[2];
var ignoreWarnings            = arguments[3];
var recentTaskLookbackMinutes = arguments.length >= 5 ? arguments[4] : 60;

if (cluster == null) {
    throw new Error("evaluateClusterPreflightFull: 'cluster' must not be null.");
}
if (typeof recentTaskLookbackMinutes !== "number" || recentTaskLookbackMinutes < 1) {
    recentTaskLookbackMinutes = 60;
}

var preflight = System.getModule("com.broadcom.pso.vc.esxi.remediation.preflight");

// -------------------------------------------------------------------
// Run the cheap aggregator first.
// -------------------------------------------------------------------

var cheapResult = preflight.evaluateClusterPreflightCheap(
    cluster, depotName, smallClusterAcknowledged, ignoreWarnings
);

// Pull out the existing findings array. Properties.get returns the
// same Array object — we will mutate it.
var findings = cheapResult.get("findings");
if (findings == null) findings = [];

// -------------------------------------------------------------------
// Expensive Check 1: vSAN resync idle.
// -------------------------------------------------------------------

try {
    var resyncCheck = preflight.checkVsanResyncIdle(cluster);
    if (resyncCheck.get("idle") !== true) {
        findings.push({
            severity: "WARNING",
            check: "vSANResync",
            message: resyncCheck.get("reason")
        });
    } else if (resyncCheck.get("error") !== "") {
        findings.push({
            severity: "INFO",
            check: "vSANResync",
            message: "vSAN resync probe could not run: " + resyncCheck.get("error")
        });
    }
} catch (e) {
    findings.push({
        severity: "INFO",
        check: "vSANResync",
        message: "vSAN resync check threw: " + e.message
    });
}

// -------------------------------------------------------------------
// Expensive Check 2: recent task activity.
// -------------------------------------------------------------------

try {
    var taskCheck = preflight.checkClusterRecentTaskActivity(cluster, recentTaskLookbackMinutes);
    if (taskCheck.get("clean") !== true) {
        findings.push({
            severity: "WARNING",
            check: "RecentTasks",
            message: taskCheck.get("reason")
        });
    }
} catch (e) {
    findings.push({
        severity: "INFO",
        check: "RecentTasks",
        message: "Recent task probe threw: " + e.message
    });
}

// -------------------------------------------------------------------
// Recompute status with the new findings included.
// -------------------------------------------------------------------

var hasCritical = false;
var hasWarning = false;
for (var i = 0; i < findings.length; i++) {
    if (findings[i].severity === "CRITICAL") {
        hasCritical = true;
    } else if (findings[i].severity === "WARNING") {
        hasWarning = true;
    }
}

var status;
if (hasCritical) {
    status = "BLOCKED";
} else if (hasWarning && !ignoreWarnings) {
    status = "WARNING";
} else {
    status = "READY";
}

// Build new result with merged findings and updated status.
var result = new Properties();
result.put("status", status);
result.put("findings", findings);
result.put("clusterType", cheapResult.get("clusterType"));
result.put("hostCount", cheapResult.get("hostCount"));

auditLogger.auditLog(
    LOG_PREFIX, "VALIDATE", status === "READY" ? "OK" : (status === "WARNING" ? "WARN" : "FAIL"),
    "Full preflight | cluster=" + cluster.name +
    " | status=" + status +
    " | findings=" + findings.length
);

return result;
