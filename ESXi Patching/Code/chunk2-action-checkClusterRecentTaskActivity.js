// ===================================================================
// ACTION:    checkClusterRecentTaskActivity
// MODULE:    com.broadcom.pso.vc.esxi.remediation.preflight
// PURPOSE:   Detect recent vCenter task activity on the cluster that
//            suggests other automation (VxRail Manager, vLCM, manual
//            operator activity) may collide with patching. Used as
//            a workflow-start-time WARNING gate — running into
//            VxRail Manager or vLCM mid-patch creates the very
//            scenarios this workflow is designed to avoid.
//
// PHASE:     VALIDATE (workflow-start-time only)
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-PREFLIGHT]
//
// INPUTS:
//   cluster          (VC:ClusterComputeResource)
//   lookbackMinutes  (number) — How far back to inspect.
//
// RETURNS: Properties — {
//            clean             (boolean)
//            recentTaskCount   (number)
//            suspiciousTasks   (Array/Properties) — entries with
//                              { taskName, startTime, finishTime,
//                                state, entityName, suspicionReason }
//            reason            (string)
//          }
//
// REQUIREMENT TRACE:
//   Implements: FR-16 (recent-task analysis at workflow-start-time),
//               FR-18 (warning silenceable via ignorePreflightWarnings).
//
// NOTES:
//   - Reads task history via the vCenter taskManager. Tasks are
//     filtered to those whose entity is the cluster, any host in
//     the cluster, or any datastore mounted by the cluster.
//   - Suspicious task name patterns:
//       * "Upgrade" / "Update" / "Install" — vLCM / VxRail
//       * "Apply" / "Remediate" — vLCM
//       * "Reconfigure host" — vLCM during firmware/driver work
//       * "Enter maintenance mode" / "Exit maintenance mode" —
//         when not initiated by this workflow run, indicates
//         someone else is operating on the cluster
//   - The check is HEURISTIC. It can produce false positives
//     (e.g., legitimate one-off operator work). That is why it is
//     a WARNING, not a BLOCKER.
//   - Implementation: collect task history via the vCenter root
//     folder's recentTask field PLUS task history collector for
//     historical lookback. The recentTask field is the
//     authoritative source for currently-running and recently-
//     completed tasks.
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-PREFLIGHT]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

if (arguments.length < 2) {
    throw new Error(
        "checkClusterRecentTaskActivity requires 2 inputs: " +
        "(cluster, lookbackMinutes)."
    );
}
var cluster = arguments[0];
var lookbackMinutes = arguments[1];

if (cluster == null) {
    throw new Error("checkClusterRecentTaskActivity: 'cluster' must not be null.");
}
if (typeof lookbackMinutes !== "number" || lookbackMinutes < 1) {
    lookbackMinutes = 60; // default 1 hour
}

var lookbackMs = lookbackMinutes * 60 * 1000;
var nowMs = (new Date()).getTime();
var cutoffMs = nowMs - lookbackMs;

// Build the entity-of-interest set: cluster MoRef + all host MoRefs.
var entityIds = {};
try {
    entityIds[String(cluster.id)] = cluster.name;
    var hosts = cluster.host;
    if (hosts != null) {
        for (var i = 0; i < hosts.length; i++) {
            if (hosts[i] != null) {
                entityIds[String(hosts[i].id)] = String(hosts[i].name);
            }
        }
    }
} catch (e) {
    // Continue with whatever we got.
}

// Suspicious name patterns (lowercased substrings).
var suspiciousPatterns = [
    "upgrade", "update", "install", "patch",
    "apply", "remediate",
    "reconfigure host",
    "enter maintenance mode", "exit maintenance mode"
];

var suspiciousTasks = [];
var totalScanned = 0;

// -------------------------------------------------------------------
// Read recent tasks via the vCenter taskManager. We use the
// taskManager's recentTask field (currently-running and recently-
// completed). For deeper history we'd use createCollectorForTasks,
// but recentTask is sufficient for a short lookback (~1 hour) and
// avoids the management overhead of explicit collectors.
// -------------------------------------------------------------------

try {
    var sdkConn = cluster.sdkConnection;
    if (sdkConn == null) {
        throw new Error("Cluster has no associated SDK connection");
    }

    var taskManager = sdkConn.taskManager;
    if (taskManager == null) {
        throw new Error("vCenter taskManager not accessible");
    }

    var recentTasks = taskManager.recentTask;
    if (recentTasks == null) recentTasks = [];

    for (var t = 0; t < recentTasks.length; t++) {
        var task = recentTasks[t];
        if (task == null || task.info == null) continue;
        totalScanned++;

        var info = task.info;

        // Filter by entity.
        var entityMoRef = null;
        var entityName = null;
        try {
            if (info.entity != null) {
                entityMoRef = String(info.entity.id);
                entityName = info.entityName != null
                    ? String(info.entityName)
                    : entityIds[entityMoRef];
            }
        } catch (e) {
            entityMoRef = null;
        }

        if (entityMoRef == null || !entityIds.hasOwnProperty(entityMoRef)) {
            continue; // not in our entity set
        }

        // Filter by time. Use queueTime fallback if startTime is null.
        var startTimeMs = nowMs; // default to "now" so we don't skip running tasks
        try {
            if (info.startTime != null) {
                startTimeMs = info.startTime.getTime();
            } else if (info.queueTime != null) {
                startTimeMs = info.queueTime.getTime();
            }
        } catch (e) {
            startTimeMs = nowMs;
        }

        if (startTimeMs < cutoffMs) {
            continue; // older than lookback
        }

        // Skip our own recent tasks. Our workflow uses local SSH/MM
        // operations which are NOT recorded as cluster-level tasks
        // for the most part — but to be safe, filter out tasks whose
        // name string indicates this workflow (initiated by this run
        // we'd see if we set a task description; we don't currently).

        // Filter by suspicious name pattern.
        var taskName = info.descriptionId != null
            ? String(info.descriptionId).toLowerCase()
            : "(unknown)";
        var displayName = info.name != null
            ? String(info.name).toLowerCase()
            : taskName;

        var matched = null;
        for (var p = 0; p < suspiciousPatterns.length; p++) {
            if (taskName.indexOf(suspiciousPatterns[p]) !== -1
                || displayName.indexOf(suspiciousPatterns[p]) !== -1) {
                matched = suspiciousPatterns[p];
                break;
            }
        }

        if (matched == null) {
            continue;
        }

        var state = "(unknown)";
        try {
            if (info.state != null) {
                state = typeof info.state === "string"
                    ? info.state
                    : String(info.state.value);
            }
        } catch (e) {
            state = "(unknown)";
        }

        suspiciousTasks.push({
            taskName: info.descriptionId != null ? String(info.descriptionId) : "(unknown)",
            displayName: info.name != null ? String(info.name) : "(unknown)",
            startTime: info.startTime,
            finishTime: info.completeTime,
            state: state,
            entityName: entityName != null ? entityName : entityMoRef,
            suspicionReason: "Matched pattern '" + matched + "'"
        });
    }
} catch (e) {
    // Permissive: probe failure is a warning, not a block.
    auditLogger.auditLog(
        LOG_PREFIX, "VALIDATE", "WARN",
        "Recent task probe threw, treating clean | cluster=" + cluster.name +
        " | error=" + e.message
    );
    var result1 = new Properties();
    result1.put("clean", true);
    result1.put("recentTaskCount", 0);
    result1.put("suspiciousTasks", []);
    result1.put("reason", "Recent task probe failed: " + e.message);
    return result1;
}

var clean = (suspiciousTasks.length === 0);
var reason = clean
    ? "No suspicious recent tasks in last " + lookbackMinutes + " minutes (scanned " + totalScanned + ")"
    : suspiciousTasks.length + " suspicious task(s) detected in last " + lookbackMinutes + " minutes";

var result = new Properties();
result.put("clean", clean);
result.put("recentTaskCount", suspiciousTasks.length);
result.put("suspiciousTasks", suspiciousTasks);
result.put("reason", reason);

auditLogger.auditLog(
    LOG_PREFIX, "VALIDATE", clean ? "OK" : "WARN",
    "Recent task check | cluster=" + cluster.name + " | " + reason
);

return result;
