// ===================================================================
// ACTION:    disableSshService
// MODULE:    com.broadcom.pso.vc.esxi.remediation.account
// PURPOSE:   Stop the TSM-SSH service on the target host. Mirror
//            of enableSshService — runs in the SSH_DISABLE cleanup
//            phase. Idempotent: if SSH is already stopped, returns
//            immediately.
//
//            CRITICAL invariant: only stop the service if THIS run
//            started it. If the operator had SSH running before
//            our run started (and enableSshService recorded
//            wasAlreadyRunning=true), we LEAVE IT RUNNING. This
//            preserves operator state and avoids accidental
//            disruption to ad-hoc admin sessions.
//
// PHASE:     SSH_DISABLE
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-ACCOUNT]
//
// INPUTS:
//   targetHost        (VC:HostSystem)
//   wasAlreadyRunning (boolean)        — captured by
//                                         enableSshService earlier
//                                         in this host's procedure.
//
// RETURNS: Properties — {
//            stopped (boolean) — true if we stopped the service;
//                                 false if we left it running (per
//                                 the invariant above) or if it
//                                 was already stopped.
//          }
//
// REQUIREMENT TRACE:
//   Implements: AD-08, AD-11 cleanup cascade rule for SSH service,
//               FR-19 step 12.
//
// NOTES:
//   - When wasAlreadyRunning=true, we ALWAYS preserve the running
//     state. This is the operator-state-preservation invariant.
//   - When wasAlreadyRunning=false, we attempt to stop. If the
//     stop fails, we log a WARN but DO NOT throw. AD-09 partial
//     cleanup states classify this as state B (cleanup partial,
//     host usable) — the host is patched, online, just has SSH
//     running which a human admin may want to clean up later.
//   - This action is called from a cleanup-phase Scriptable Task
//     and from the AUTH_CLEANUP / DEH cleanup paths. Throwing here
//     would cascade into the cluster-level cleanup cascade and
//     mask the real failure that led to cleanup. Permissive on
//     failure is correct.
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-ACCOUNT]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

if (arguments.length < 2) {
    throw new Error(
        "disableSshService requires 2 inputs: (targetHost, wasAlreadyRunning)."
    );
}
var targetHost        = arguments[0];
var wasAlreadyRunning = arguments[1];

if (targetHost == null) {
    throw new Error("disableSshService: 'targetHost' must not be null.");
}
if (typeof wasAlreadyRunning !== "boolean") wasAlreadyRunning = false;

var result = new Properties();
result.put("stopped", false);

// Operator-state-preservation invariant.
if (wasAlreadyRunning) {
    auditLogger.auditLog(
        LOG_PREFIX, "SSH_DISABLE", "SKIP",
        "Leaving SSH running per operator-state-preservation invariant | " +
        "host=" + targetHost.name
    );
    return result;
}

// Walk the service system, find current state, stop if running.
var serviceSystem = null;
try {
    if (targetHost.configManager != null) {
        serviceSystem = targetHost.configManager.serviceSystem;
    }
} catch (e) {
    auditLogger.auditLog(
        LOG_PREFIX, "SSH_DISABLE", "WARN",
        "Cannot read serviceSystem | host=" + targetHost.name +
        " | error=" + e.message
    );
    return result;
}
if (serviceSystem == null) {
    auditLogger.auditLog(
        LOG_PREFIX, "SSH_DISABLE", "WARN",
        "Host has no serviceSystem | host=" + targetHost.name
    );
    return result;
}

var sshKey = "TSM-SSH";
var running = false;
try {
    var services = serviceSystem.serviceInfo != null
        ? serviceSystem.serviceInfo.service
        : null;
    if (services != null) {
        for (var i = 0; i < services.length; i++) {
            if (services[i] != null && String(services[i].key) === sshKey) {
                if (services[i].running === true) {
                    running = true;
                }
                break;
            }
        }
    }
} catch (e) {
    auditLogger.auditLog(
        LOG_PREFIX, "SSH_DISABLE", "WARN",
        "Could not read SSH state | host=" + targetHost.name +
        " | error=" + e.message
    );
}

if (!running) {
    auditLogger.auditLog(
        LOG_PREFIX, "SSH_DISABLE", "OK",
        "SSH already stopped; nothing to do | host=" + targetHost.name
    );
    return result;
}

try {
    serviceSystem.stopService(sshKey);
    result.put("stopped", true);
    auditLogger.auditLog(
        LOG_PREFIX, "SSH_DISABLE", "OK",
        "SSH service stopped | host=" + targetHost.name
    );
} catch (e) {
    auditLogger.auditLog(
        LOG_PREFIX, "SSH_DISABLE", "WARN",
        "stopService failed; SSH may still be running | host=" + targetHost.name +
        " | error=" + e.message
    );
}

return result;
