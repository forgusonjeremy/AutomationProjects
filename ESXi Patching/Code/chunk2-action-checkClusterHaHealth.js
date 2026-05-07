// ===================================================================
// ACTION:    checkClusterHaHealth
// MODULE:    com.broadcom.pso.vc.esxi.remediation.preflight
// PURPOSE:   Evaluate cluster HA configuration. Returns whether HA
//            is enabled, its admission control mode (used downstream
//            by evaluateResidualCapacity to decide patching
//            eligibility), and a healthy/unhealthy assessment.
//
// PHASE:     VALIDATE
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-PREFLIGHT]
//
// INPUTS:
//   cluster (VC:ClusterComputeResource)
//
// RETURNS: Properties — {
//            enabled              (boolean)  — HA toggle
//            healthy              (boolean)  — enabled AND no faults
//            admissionControlMode (string)   — one of:
//                                  "DISABLED",
//                                  "FAILURES_TO_TOLERATE",
//                                  "DEDICATED_FAILOVER_HOSTS",
//                                  "PERCENTAGE",
//                                  "UNKNOWN"
//            failuresToTolerate   (number)   — vSphere FTT setting,
//                                              relevant when mode is
//                                              FAILURES_TO_TOLERATE.
//                                              0 if not applicable.
//            reason               (string)   — Human-readable
//                                              description of state
//                                              (e.g. "HA disabled",
//                                              "HA enabled, FTT=1").
//          }
//
// REQUIREMENT TRACE:
//   Implements: FR-15 (HA check at form-time and workflow-start),
//               FR-17 (block clusters with HA disabled).
//
// NOTES:
//   - HA configuration lives at cluster.configurationEx.dasConfig
//     (DAS = Distributed Availability Service, vSphere's old name
//     for HA).
//   - Admission control settings live at
//     cluster.configurationEx.dasConfig.admissionControlPolicy.
//     The polymorphic type is one of:
//       ClusterFailoverLevelAdmissionControlPolicy   → FAILURES_TO_TOLERATE
//       ClusterFailoverHostAdmissionControlPolicy    → DEDICATED_FAILOVER_HOSTS
//       ClusterFailoverResourcesAdmissionControlPolicy → PERCENTAGE
//     We type-check via the JavaScript-visible class name (not the
//     Java SDK type) since vRO exposes these as distinct types.
//   - The "healthy" boolean is intentionally simple — it returns
//     true if HA is enabled and the cluster reports no overall
//     status problem. Granular issue detection (master agent state,
//     heartbeat datastore counts) is reserved for the per-host
//     HA_REJOIN check during patching (FR-19 step 11).
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-PREFLIGHT]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

if (arguments.length < 1) {
    throw new Error("checkClusterHaHealth requires 1 input: cluster.");
}
var cluster = arguments[0];

if (cluster == null) {
    throw new Error("checkClusterHaHealth: 'cluster' must not be null.");
}

var result = new Properties();
result.put("enabled", false);
result.put("healthy", false);
result.put("admissionControlMode", "DISABLED");
result.put("failuresToTolerate", 0);
result.put("reason", "Initial state");

// -------------------------------------------------------------------
// Read HA configuration. We wrap in try/catch so a malformed cluster
// configurationEx does not throw out of the action.
// -------------------------------------------------------------------

var dasConfig = null;
try {
    var configEx = cluster.configurationEx;
    if (configEx != null) {
        dasConfig = configEx.dasConfig;
    }
} catch (e) {
    auditLogger.auditLog(
        LOG_PREFIX, "VALIDATE", "WARN",
        "Could not read dasConfig | cluster=" + cluster.name +
        " | error=" + e.message
    );
    result.put("reason", "Could not read HA configuration: " + e.message);
    return result;
}

if (dasConfig == null) {
    result.put("reason", "HA configuration not present on cluster");
    auditLogger.auditLog(
        LOG_PREFIX, "VALIDATE", "FAIL",
        "HA config missing | cluster=" + cluster.name
    );
    return result;
}

var enabled = dasConfig.enabled === true;
result.put("enabled", enabled);

if (!enabled) {
    result.put("reason", "HA is disabled on the cluster");
    auditLogger.auditLog(
        LOG_PREFIX, "VALIDATE", "FAIL",
        "HA disabled | cluster=" + cluster.name
    );
    return result;
}

// -------------------------------------------------------------------
// HA is enabled. Determine admission control mode.
// -------------------------------------------------------------------

var admissionControlMode = "UNKNOWN";
var failuresToTolerate = 0;

try {
    // First check: is admission control enabled at all?
    if (dasConfig.admissionControlEnabled === false) {
        admissionControlMode = "DISABLED";
    } else {
        var policy = dasConfig.admissionControlPolicy;
        if (policy == null) {
            admissionControlMode = "DISABLED";
        } else {
            // Detect the policy type by checking known fields.
            // - failoverLevel exists on FailoverLevel policy
            // - failoverHosts exists on FailoverHost policy
            // - cpuFailoverResourcesPercent / memoryFailoverResourcesPercent
            //     exist on FailoverResources (percentage) policy
            if (policy.failoverLevel != null) {
                admissionControlMode = "FAILURES_TO_TOLERATE";
                failuresToTolerate = Number(policy.failoverLevel);
            } else if (policy.failoverHosts != null) {
                admissionControlMode = "DEDICATED_FAILOVER_HOSTS";
            } else if (policy.cpuFailoverResourcesPercent != null ||
                       policy.memoryFailoverResourcesPercent != null) {
                admissionControlMode = "PERCENTAGE";
            } else {
                admissionControlMode = "UNKNOWN";
            }
        }
    }
} catch (e) {
    admissionControlMode = "UNKNOWN";
    auditLogger.auditLog(
        LOG_PREFIX, "VALIDATE", "WARN",
        "Could not determine admission control mode | cluster=" + cluster.name +
        " | error=" + e.message
    );
}

result.put("admissionControlMode", admissionControlMode);
result.put("failuresToTolerate", failuresToTolerate);

// -------------------------------------------------------------------
// Health check: HA enabled, cluster overall status not red.
// cluster.overallStatus values: gray, green, yellow, red.
// -------------------------------------------------------------------

var overallStatus = "(unknown)";
try {
    overallStatus = String(cluster.overallStatus.value);
} catch (e) {
    // overallStatus may be unreadable on rare cluster states.
}

var healthy = enabled && (overallStatus !== "red");
result.put("healthy", healthy);

var reason;
if (healthy) {
    reason = "HA enabled | mode=" + admissionControlMode +
             (admissionControlMode === "FAILURES_TO_TOLERATE"
                ? " | FTT=" + failuresToTolerate
                : "") +
             " | clusterStatus=" + overallStatus;
} else if (overallStatus === "red") {
    reason = "HA enabled but cluster overall status is RED";
} else {
    reason = "HA enabled but health check did not pass";
}
result.put("reason", reason);

auditLogger.auditLog(
    LOG_PREFIX, "VALIDATE", healthy ? "OK" : "FAIL",
    "HA check | cluster=" + cluster.name + " | " + reason
);

return result;
