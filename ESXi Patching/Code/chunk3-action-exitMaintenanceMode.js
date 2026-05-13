// ===================================================================
// ACTION:    exitMaintenanceMode
// MODULE:    com.broadcom.pso.vc.esxi.remediation.host
// PURPOSE:   Take the target host out of maintenance mode after
//            patch + reboot + verification have succeeded. Mirror
//            of enterMaintenanceMode — invokes the SDK task and
//            polls to completion.
//
// PHASE:     MM_EXIT
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-HOST]
//
// INPUTS:
//   targetHost     (VC:HostSystem)
//   timeoutSeconds (number) — Default 600 (10 minutes). MM exit is
//                              fast — this is generous.
//
// RETURNS: Properties — {
//            success      (boolean)
//            durationSec  (number)
//            taskState    (string)
//            error        (string)
//          }
//
// REQUIREMENT TRACE:
//   Implements: FR-19 step 13 (MM_EXIT), AD-08 cleanup ordering.
//
// NOTES:
//   - exitMaintenanceMode_Task takes a single int parameter
//     (timeout in seconds; 0 = no SDK-side timeout).
//   - We poll task state with the same pattern as MM-enter.
//   - Returning success=false with an error message lets the
//     cluster-level cleanup classify per AD-09 (state B/C).
//   - Idempotent in spirit: if the host is already NOT in MM,
//     ESXi treats the call as success / no-op. We don't need a
//     pre-check.
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-HOST]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

if (arguments.length < 1) {
    throw new Error("exitMaintenanceMode requires 1-2 inputs: (targetHost, [timeoutSeconds]).");
}
var targetHost     = arguments[0];
var timeoutSeconds = arguments.length >= 2 ? arguments[1] : 600;

if (targetHost == null) {
    throw new Error("exitMaintenanceMode: 'targetHost' must not be null.");
}
if (typeof timeoutSeconds !== "number" || timeoutSeconds < 60) timeoutSeconds = 600;

var result = new Properties();
result.put("success", false);
result.put("durationSec", 0);
result.put("taskState", "(unknown)");
result.put("error", "");

var hostFqdn = String(targetHost.name);
var startMs  = (new Date()).getTime();

// Quick pre-check: if host isn't in MM, return success immediately.
try {
    if (targetHost.runtime != null && targetHost.runtime.inMaintenanceMode === false) {
        result.put("success", true);
        result.put("taskState", "noOp");
        auditLogger.auditLog(
            LOG_PREFIX, "MM_EXIT", "OK",
            "Host not in MM; nothing to do | host=" + hostFqdn
        );
        return result;
    }
} catch (e) { /* fall through to attempt exit anyway */ }

// Invoke task.
var task = null;
try {
    task = targetHost.exitMaintenanceMode_Task(0);
} catch (e) {
    result.put("error", "exitMaintenanceMode_Task threw: " + e.message);
    auditLogger.auditLog(
        LOG_PREFIX, "MM_EXIT", "FAIL",
        "Could not start MM-exit task | host=" + hostFqdn + " | error=" + e.message
    );
    return result;
}

if (task == null) {
    result.put("error", "exitMaintenanceMode_Task returned null");
    return result;
}

auditLogger.auditLog(
    LOG_PREFIX, "MM_EXIT", "OK",
    "MM-exit task started | host=" + hostFqdn + " | timeoutSec=" + timeoutSeconds
);

// Poll.
var pollIntervalMs = 3000;
var deadlineMs = startMs + (timeoutSeconds * 1000);

while (true) {
    var nowMs = (new Date()).getTime();
    if (nowMs >= deadlineMs) {
        result.put("error", "MM-exit timed out after " + timeoutSeconds + "s");
        result.put("taskState", "timedout");
        result.put("durationSec", Math.round((nowMs - startMs) / 1000));
        auditLogger.auditLog(
            LOG_PREFIX, "MM_EXIT", "FAIL",
            "MM-exit task timed out | host=" + hostFqdn
        );
        return result;
    }

    var info = null;
    try { info = task.info; } catch (e) { /* retry */ }
    if (info == null) {
        System.sleep(pollIntervalMs);
        continue;
    }

    var stateStr = "(unknown)";
    try {
        stateStr = info.state != null
            ? (typeof info.state === "string" ? info.state : String(info.state.value))
            : "(unknown)";
    } catch (e) { /* continue */ }

    if (stateStr === "success") {
        result.put("success", true);
        result.put("taskState", stateStr);
        result.put("durationSec", Math.round((nowMs - startMs) / 1000));
        auditLogger.auditLog(
            LOG_PREFIX, "MM_EXIT", "DONE",
            "Host exited MM | host=" + hostFqdn +
            " | durationSec=" + result.get("durationSec")
        );
        return result;
    } else if (stateStr === "error") {
        var errMsg = "(unknown)";
        try {
            if (info.error != null && info.error.localizedMessage != null) {
                errMsg = String(info.error.localizedMessage);
            } else if (info.error != null) {
                errMsg = String(info.error);
            }
        } catch (e) { /* continue */ }
        result.put("error", errMsg);
        result.put("taskState", stateStr);
        result.put("durationSec", Math.round((nowMs - startMs) / 1000));
        auditLogger.auditLog(
            LOG_PREFIX, "MM_EXIT", "FAIL",
            "MM-exit failed | host=" + hostFqdn + " | error=" + errMsg
        );
        return result;
    }

    System.sleep(pollIntervalMs);
}
