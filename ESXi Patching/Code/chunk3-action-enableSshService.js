// ===================================================================
// ACTION:    enableSshService
// MODULE:    com.broadcom.pso.vc.esxi.remediation.account
// PURPOSE:   Start the TSM-SSH (SSH daemon) service on the target
//            host. Required for the per-host KB 000345284 procedure
//            because esxcli software vib install runs over an SSH
//            connection from vRO. The service is enabled via
//            host.configManager.serviceSystem.startService().
//
//            Idempotent: if SSH is already running, the action
//            returns immediately without state change.
//
//            Per C-03 and AD-08 the service is enabled per-host
//            for the duration of the host's procedure only — there
//            is NO Change Request requirement for this transient
//            enablement. The cleanup pair disableSshService runs
//            in MM_EXIT cleanup regardless of patch outcome.
//
// PHASE:     SSH_ENABLE
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-ACCOUNT]
//
// INPUTS:
//   targetHost (VC:HostSystem)
//
// RETURNS: Properties — {
//            wasAlreadyRunning (boolean) — true if SSH was already
//                                           started (idempotent
//                                           path); false if we
//                                           started it
//          }
//
// REQUIREMENT TRACE:
//   Implements: AD-08 (transient SSH), C-03 (no CR for SSH enable),
//               FR-19 step 3.
//
// NOTES:
//   - The TSM-SSH service has key "TSM-SSH" on ESXi 8.x. This is
//     stable.
//   - serviceSystem.serviceInfo.service is an array of HostService
//     entries. Each entry has .key (e.g. "TSM-SSH") and .running
//     (boolean).
//   - We do NOT change service.policy (start/stop policy at host
//     boot). Only the runtime running state. The boot-time policy
//     remains whatever the operator had configured (typically
//     "off").
//   - Output 'wasAlreadyRunning' is informational; useful for the
//     cleanup phase to decide whether to STOP the service: if it
//     was already running when we arrived, we leave it running on
//     exit. (See disableSshService.)
//   - If the service is in lockdown mode the start will fail. The
//     preflight stage rules out lockdown hosts, so we shouldn't
//     hit this path here. If we do, the error is fatal for THIS
//     host — surface it.
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-ACCOUNT]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

if (arguments.length < 1) {
    throw new Error("enableSshService requires 1 input: targetHost.");
}
var targetHost = arguments[0];

if (targetHost == null) {
    throw new Error("enableSshService: 'targetHost' must not be null.");
}

var serviceSystem = null;
try {
    if (targetHost.configManager != null) {
        serviceSystem = targetHost.configManager.serviceSystem;
    }
} catch (e) {
    throw new Error("enableSshService: cannot read host.configManager.serviceSystem: " + e.message);
}
if (serviceSystem == null) {
    throw new Error("enableSshService: host has no serviceSystem | host=" + targetHost.name);
}

// -------------------------------------------------------------------
// Find current TSM-SSH state.
// -------------------------------------------------------------------

var sshKey = "TSM-SSH";
var wasAlreadyRunning = false;
var found = false;

try {
    var services = serviceSystem.serviceInfo != null
        ? serviceSystem.serviceInfo.service
        : null;
    if (services != null) {
        for (var i = 0; i < services.length; i++) {
            if (services[i] != null && String(services[i].key) === sshKey) {
                found = true;
                if (services[i].running === true) {
                    wasAlreadyRunning = true;
                }
                break;
            }
        }
    }
} catch (e) {
    // Read failure: log and proceed to attempt start anyway.
    auditLogger.auditLog(
        LOG_PREFIX, "SSH_ENABLE", "WARN",
        "Could not read SSH service state, will attempt start anyway | " +
        "host=" + targetHost.name + " | error=" + e.message
    );
}

if (!found) {
    // Service not in the host's service inventory. This is highly
    // unusual on ESXi 8.x — TSM-SSH ships with the OS. Surface as
    // a fatal error.
    throw new Error(
        "enableSshService: TSM-SSH service not found in host's service inventory | " +
        "host=" + targetHost.name
    );
}

if (wasAlreadyRunning) {
    auditLogger.auditLog(
        LOG_PREFIX, "SSH_ENABLE", "OK",
        "SSH already running; idempotent path | host=" + targetHost.name
    );
} else {
    // Start it.
    try {
        serviceSystem.startService(sshKey);
    } catch (e) {
        throw new Error(
            "enableSshService: startService failed | host=" + targetHost.name +
            " | error=" + e.message
        );
    }
    auditLogger.auditLog(
        LOG_PREFIX, "SSH_ENABLE", "OK",
        "SSH service started | host=" + targetHost.name
    );
}

var result = new Properties();
result.put("wasAlreadyRunning", wasAlreadyRunning);
return result;
