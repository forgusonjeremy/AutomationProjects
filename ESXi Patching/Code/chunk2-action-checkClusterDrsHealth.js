// ===================================================================
// ACTION:    checkClusterDrsHealth
// MODULE:    com.broadcom.pso.vc.esxi.remediation.preflight
// PURPOSE:   Evaluate cluster DRS configuration. KB 000345284 patching
//            requires DRS to evacuate VMs as hosts enter MM. Manual
//            or partially-automated DRS would force operators to
//            confirm migrations interactively, which the workflow
//            does not handle (per EX-14 — no awaiting user
//            interaction during workflow execution).
//
// PHASE:     VALIDATE
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-PREFLIGHT]
//
// INPUTS:
//   cluster (VC:ClusterComputeResource)
//
// RETURNS: Properties — {
//            enabled        (boolean)  — DRS toggle
//            automated      (boolean)  — true iff
//                                         defaultVmBehavior is
//                                         "fullyAutomated"
//            behavior       (string)   — defaultVmBehavior value
//                                         ("manual", "partiallyAutomated",
//                                          "fullyAutomated", or
//                                          "(disabled)")
//            healthy        (boolean)  — enabled AND automated
//            reason         (string)
//          }
//
// REQUIREMENT TRACE:
//   Implements: FR-15, FR-17, EX-14.
//
// NOTES:
//   - DRS configuration lives at
//     cluster.configurationEx.drsConfig (a ClusterDrsConfigInfo).
//   - The defaultVmBehavior field is an enum:
//       manual              — DRS only recommends; admin must apply.
//       partiallyAutomated  — Initial placement automated; vMotion
//                             only recommended.
//       fullyAutomated      — Initial placement AND vMotion automated.
//     Only fullyAutomated supports unattended MM entry workflows.
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-PREFLIGHT]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

if (arguments.length < 1) {
    throw new Error("checkClusterDrsHealth requires 1 input: cluster.");
}
var cluster = arguments[0];

if (cluster == null) {
    throw new Error("checkClusterDrsHealth: 'cluster' must not be null.");
}

var result = new Properties();
result.put("enabled", false);
result.put("automated", false);
result.put("behavior", "(disabled)");
result.put("healthy", false);
result.put("reason", "Initial state");

var drsConfig = null;
try {
    var configEx = cluster.configurationEx;
    if (configEx != null) {
        drsConfig = configEx.drsConfig;
    }
} catch (e) {
    result.put("reason", "Could not read DRS configuration: " + e.message);
    auditLogger.auditLog(
        LOG_PREFIX, "VALIDATE", "WARN",
        "DRS config read failed | cluster=" + cluster.name +
        " | error=" + e.message
    );
    return result;
}

if (drsConfig == null || drsConfig.enabled !== true) {
    result.put("reason", "DRS is disabled on the cluster");
    auditLogger.auditLog(
        LOG_PREFIX, "VALIDATE", "FAIL",
        "DRS disabled | cluster=" + cluster.name
    );
    return result;
}

result.put("enabled", true);

// -------------------------------------------------------------------
// Read defaultVmBehavior. The vRO plugin exposes the enum as an
// object with a .value string property (consistent with other
// vSphere SDK enums in vRO).
// -------------------------------------------------------------------

var behavior = "(unknown)";
try {
    if (drsConfig.defaultVmBehavior != null) {
        // Some plugin versions return a string directly; others
        // return an object with .value. Handle both.
        if (typeof drsConfig.defaultVmBehavior === "string") {
            behavior = drsConfig.defaultVmBehavior;
        } else if (drsConfig.defaultVmBehavior.value != null) {
            behavior = String(drsConfig.defaultVmBehavior.value);
        }
    }
} catch (e) {
    behavior = "(error)";
}

result.put("behavior", behavior);

var automated = (behavior === "fullyAutomated");
result.put("automated", automated);

var healthy = automated;
result.put("healthy", healthy);

var reason;
if (healthy) {
    reason = "DRS enabled and fully automated";
} else {
    reason = "DRS enabled but defaultVmBehavior=" + behavior +
             " (must be fullyAutomated for unattended patching)";
}
result.put("reason", reason);

auditLogger.auditLog(
    LOG_PREFIX, "VALIDATE", healthy ? "OK" : "FAIL",
    "DRS check | cluster=" + cluster.name + " | " + reason
);

return result;
