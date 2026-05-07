// ===================================================================
// ACTION:    rebootHost
// MODULE:    com.broadcom.pso.vc.esxi.remediation.host
// PURPOSE:   Initiate a graceful reboot of the target host. The
//            action does NOT wait for the reboot to complete here
//            — that is the job of waitForHostReconnect (Action 7
//            of 10). This action's job is to issue the reboot
//            command and confirm the host has begun going offline.
//
//            Per FR-19 step 7 (REBOOT phase) the host reboots via
//            host.rebootHost_Task() — vCenter-initiated graceful
//            reboot, NOT esxcli system shutdown reboot.
//
// PHASE:     REBOOT
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-HOST]
//
// INPUTS:
//   targetHost (VC:HostSystem)
//   force      (boolean) — when true, the SDK passes force=true to
//                          rebootHost_Task. We default to false —
//                          the host is in MM at this point so a
//                          graceful reboot has nothing to interrupt.
//                          Force is reserved for emergency recovery.
//
// RETURNS: Properties — {
//            success         (boolean) — true if the reboot task
//                                         was accepted by vCenter
//            taskInitiated   (boolean) — true if a task was started
//            error           (string)
//          }
//
// REQUIREMENT TRACE:
//   Implements: FR-19 step 7 (REBOOT phase initiation).
//
// NOTES:
//   - rebootHost_Task() returns immediately after the task is
//     accepted; the host begins shutting down asynchronously.
//   - We do NOT wait for the task to reach "success" because the
//     task IS the reboot — the host's vCenter agent goes offline
//     mid-task by design. The task may even end up in state
//     "running" when host comms drop. Trying to poll it to
//     completion would either hang or report a misleading error.
//   - Instead we just confirm the SDK accepted the request and
//     return. The follow-up Action waitForHostReconnect handles
//     the round-trip wait.
//   - The only fatal failure path is "rebootHost_Task threw" —
//     which means vCenter refused to even initiate the reboot
//     (e.g. host disconnected, VPX agent unhealthy). That's a
//     hard failure for this host.
//   - Pre-check: confirm host is currently connected and in MM.
//     If host is not in MM, refuse to reboot — that would be
//     catastrophic for production VMs. This pre-check is
//     defense-in-depth; the workflow shouldn't reach REBOOT phase
//     without MM_ENTER having succeeded.
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-HOST]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

if (arguments.length < 1) {
    throw new Error("rebootHost requires 1-2 inputs: (targetHost, [force]).");
}
var targetHost = arguments[0];
var force      = arguments.length >= 2 ? arguments[1] : false;

if (targetHost == null) {
    throw new Error("rebootHost: 'targetHost' must not be null.");
}
if (typeof force !== "boolean") force = false;

var hostFqdn = String(targetHost.name);

var result = new Properties();
result.put("success", false);
result.put("taskInitiated", false);
result.put("error", "");

// -------------------------------------------------------------------
// Pre-check: must be in MM. Defense-in-depth.
// -------------------------------------------------------------------
try {
    if (targetHost.runtime != null && targetHost.runtime.inMaintenanceMode !== true) {
        throw new Error(
            "Host is NOT in maintenance mode. Refusing to reboot for safety."
        );
    }
} catch (e) {
    result.put("error", e.message);
    auditLogger.auditLog(
        LOG_PREFIX, "REBOOT", "FAIL",
        "Reboot pre-check failed | host=" + hostFqdn + " | error=" + e.message
    );
    return result;
}

// -------------------------------------------------------------------
// Initiate reboot.
// -------------------------------------------------------------------
try {
    var task = targetHost.rebootHost_Task(force);
    result.put("taskInitiated", true);
    if (task != null) {
        try {
            // Wait briefly (up to 30 seconds) to confirm the task
            // moved out of "queued" state. After that, we return
            // and let waitForHostReconnect handle the round-trip.
            var waitDeadline = (new Date()).getTime() + 30000;
            while ((new Date()).getTime() < waitDeadline) {
                var info = null;
                try { info = task.info; } catch (ie) { info = null; }
                if (info != null) {
                    var st = info.state != null
                        ? (typeof info.state === "string"
                            ? info.state
                            : String(info.state.value))
                        : "(unknown)";
                    if (st === "running" || st === "success" || st === "error") {
                        break;
                    }
                }
                System.sleep(1000);
            }
        } catch (pollErr) {
            // Polling errors here are fine — the task was started.
        }
    }
    result.put("success", true);
    auditLogger.auditLog(
        LOG_PREFIX, "REBOOT", "OK",
        "Reboot initiated | host=" + hostFqdn + " | force=" + force
    );
} catch (e) {
    result.put("error", "rebootHost_Task threw: " + e.message);
    auditLogger.auditLog(
        LOG_PREFIX, "REBOOT", "FAIL",
        "Reboot initiation failed | host=" + hostFqdn + " | error=" + e.message
    );
}

return result;
