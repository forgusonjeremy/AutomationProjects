// ===================================================================
// ACTION:    captureHostBaseline
// MODULE:    com.broadcom.pso.vc.esxi.remediation.host
// PURPOSE:   Capture key pre-procedure facts about a host so the
//            workflow can compare pre/post and decide whether the
//            patch took effect. Called once at MM_PRECHECK before
//            anything is changed.
//
//            Captured facts:
//              * ESXi version + build (used by verifyPatchedBuild).
//              * bootTime (used by waitForHostReconnect to confirm
//                actual reboot).
//              * Initial connection state and MM state.
//              * Initial SSH service state — passed to
//                disableSshService for the operator-state-
//                preservation invariant.
//
// PHASE:     MM_PRECHECK
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-HOST]
//
// INPUTS:
//   targetHost (VC:HostSystem)
//
// RETURNS: Properties — {
//            hostName              (string)
//            hostMoRef             (string)
//            esxiVersion           (string)
//            esxiBuild             (string)
//            bootTime              (Date)
//            connectionState       (string)
//            inMaintenanceMode     (boolean)
//            sshWasAlreadyRunning  (boolean)
//            captureTime           (Date)
//          }
//
// REQUIREMENT TRACE:
//   Implements: FR-19 step 1 (MM_PRECHECK).
//
// NOTES:
//   - The action is read-only. It never modifies host state.
//   - Throws on connection state != "connected" — there's no point
//     proceeding with a host that's already disconnected. The
//     cluster-level workflow catches this exception and treats it
//     as a per-host skip.
//   - Throws on inMaintenanceMode == true — a host already in MM
//     when we arrive has been touched by another operator or
//     workflow; we refuse to proceed without knowing what put it
//     there. Cluster-level workflow handles this as a skip.
//   - The captured Properties are passed forward through the
//     14-phase procedure as a single workflow attribute. Subsequent
//     phases reference fields like beforeBuild and bootTime.
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-HOST]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

if (arguments.length < 1) {
    throw new Error("captureHostBaseline requires 1 input: targetHost.");
}
var targetHost = arguments[0];

if (targetHost == null) {
    throw new Error("captureHostBaseline: 'targetHost' must not be null.");
}

var hostName  = String(targetHost.name);
var hostMoRef = String(targetHost.id);

// -------------------------------------------------------------------
// Connection state precondition.
// -------------------------------------------------------------------

var connState = "(unknown)";
try {
    if (targetHost.runtime != null && targetHost.runtime.connectionState != null) {
        connState = String(targetHost.runtime.connectionState.value);
    }
} catch (e) {
    connState = "(unknown)";
}

if (connState !== "connected") {
    throw new Error(
        "captureHostBaseline: host is not connected | host=" + hostName +
        " | state=" + connState
    );
}

// -------------------------------------------------------------------
// MM precondition.
// -------------------------------------------------------------------

var inMM = false;
try {
    if (targetHost.runtime != null) {
        inMM = targetHost.runtime.inMaintenanceMode === true;
    }
} catch (e) { /* leave as false — overly permissive but safer than blocking */ }

if (inMM) {
    throw new Error(
        "captureHostBaseline: host is already in maintenance mode (someone else's operation in progress?) | " +
        "host=" + hostName
    );
}

// -------------------------------------------------------------------
// Capture version/build.
// -------------------------------------------------------------------

var esxiVersion = "(unknown)";
var esxiBuild = "(unknown)";
try {
    if (targetHost.config != null && targetHost.config.product != null) {
        esxiVersion = String(targetHost.config.product.version);
        esxiBuild = String(targetHost.config.product.build);
    }
} catch (e) { /* leave as unknown */ }

// -------------------------------------------------------------------
// Capture bootTime.
// -------------------------------------------------------------------

var bootTime = null;
try {
    if (targetHost.runtime != null && targetHost.runtime.bootTime != null) {
        bootTime = targetHost.runtime.bootTime;
    }
} catch (e) { /* leave as null */ }

// -------------------------------------------------------------------
// Capture SSH-running state.
// -------------------------------------------------------------------

var sshWasAlreadyRunning = false;
try {
    var serviceSystem = null;
    if (targetHost.configManager != null) {
        serviceSystem = targetHost.configManager.serviceSystem;
    }
    if (serviceSystem != null && serviceSystem.serviceInfo != null) {
        var services = serviceSystem.serviceInfo.service;
        if (services != null) {
            for (var i = 0; i < services.length; i++) {
                if (services[i] != null && String(services[i].key) === "TSM-SSH") {
                    if (services[i].running === true) {
                        sshWasAlreadyRunning = true;
                    }
                    break;
                }
            }
        }
    }
} catch (e) { /* leave as false */ }

// -------------------------------------------------------------------
// Build result.
// -------------------------------------------------------------------

var result = new Properties();
result.put("hostName", hostName);
result.put("hostMoRef", hostMoRef);
result.put("esxiVersion", esxiVersion);
result.put("esxiBuild", esxiBuild);
result.put("bootTime", bootTime);
result.put("connectionState", connState);
result.put("inMaintenanceMode", inMM);
result.put("sshWasAlreadyRunning", sshWasAlreadyRunning);
result.put("captureTime", new Date());

auditLogger.auditLog(
    LOG_PREFIX, "MM_PRECHECK", "OK",
    "Captured host baseline | host=" + hostName +
    " | version=" + esxiVersion +
    " | build=" + esxiBuild +
    " | bootTime=" + (bootTime != null ? bootTime.toString() : "(null)") +
    " | sshWasAlreadyRunning=" + sshWasAlreadyRunning
);

return result;
