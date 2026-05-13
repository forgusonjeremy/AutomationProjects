// ===================================================================
// ACTION:    enterMaintenanceMode
// MODULE:    com.broadcom.pso.vc.esxi.remediation.host
// PURPOSE:   Put the target host into maintenance mode and wait for
//            the operation to complete. For VxRail / vSAN clusters,
//            specify the vSAN data evacuation mode so vSAN does
//            not lose redundancy during the patch.
//
// PHASE:     MM_ENTER
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-HOST]
//
// INPUTS:
//   targetHost              (VC:HostSystem)
//   evacuatePoweredOffVms   (boolean) — also evacuate powered-off
//                                       VMs (DRS will move their
//                                       configuration). Default
//                                       true for safety.
//   timeoutSeconds          (number)  — Max time to wait for the
//                                       MM-enter task. Default 3600
//                                       (1 hour) — vSAN evacuation
//                                       can take a while on heavily
//                                       loaded clusters.
//   vsanDataEvacuationMode  (string)  — "ensureObjectAccessibility"
//                                       (default; preserve all
//                                       data accessibility),
//                                       "evacuateAllData" (full
//                                       evacuation; safer but
//                                       slower), or "noAction"
//                                       (don't migrate vSAN data;
//                                       NOT RECOMMENDED for
//                                       VxRail).
//
// RETURNS: Properties — {
//            success     (boolean)
//            durationSec (number)
//            taskState   (string)
//            error       (string)
//          }
//
// REQUIREMENT TRACE:
//   Implements: FR-19 step 5 (MM_ENTER), AD-04 / AD-09 cluster
//               continuation states.
//
// NOTES:
//   - host.enterMaintenanceMode_Task() returns a VcTask. We poll
//     the task using getTaskResult helper for the timeout window.
//   - The MM-enter SDK call accepts an optional
//     HostMaintenanceSpec parameter. For vSAN-enabled clusters
//     this is where vSAN data evacuation mode is specified.
//   - Default mode is "ensureObjectAccessibility" — vSAN keeps
//     all object access intact during the patch. This is the
//     standard VxRail/vSAN MM-enter mode and aligns with the
//     KB 000345284 procedure.
//   - "evacuateAllData" fully migrates ALL vSAN object copies off
//     the host. Slower but allows the host to be physically
//     removed from the cluster afterward (irrelevant for patching).
//   - "noAction" tells vSAN NOT to migrate data. The host enters
//     MM with vSAN objects still resident — risky for patches
//     that may corrupt local storage, but harmless for the KB
//     procedure which only writes to bootbank.
//   - Throws on timeout; returns success=false with error message
//     for non-timeout failures (so cluster-level cleanup can
//     classify the host as failed and choose to halt or continue
//     per AD-09).
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-HOST]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

if (arguments.length < 1) {
    throw new Error(
        "enterMaintenanceMode requires 1-4 inputs: " +
        "(targetHost, [evacuatePoweredOffVms], [timeoutSeconds], [vsanDataEvacuationMode])."
    );
}
var targetHost             = arguments[0];
var evacuatePoweredOffVms  = arguments.length >= 2 ? arguments[1] : true;
var timeoutSeconds         = arguments.length >= 3 ? arguments[2] : 3600;
var vsanDataEvacuationMode = arguments.length >= 4 ? arguments[3] : "ensureObjectAccessibility";

if (targetHost == null) {
    throw new Error("enterMaintenanceMode: 'targetHost' must not be null.");
}
if (typeof evacuatePoweredOffVms !== "boolean") evacuatePoweredOffVms = true;
if (typeof timeoutSeconds !== "number" || timeoutSeconds < 60) timeoutSeconds = 3600;
if (typeof vsanDataEvacuationMode !== "string"
    || (vsanDataEvacuationMode !== "ensureObjectAccessibility"
        && vsanDataEvacuationMode !== "evacuateAllData"
        && vsanDataEvacuationMode !== "noAction")) {
    vsanDataEvacuationMode = "ensureObjectAccessibility";
}

var result = new Properties();
result.put("success", false);
result.put("durationSec", 0);
result.put("taskState", "(unknown)");
result.put("error", "");

var hostFqdn = String(targetHost.name);
var startMs = (new Date()).getTime();

// -------------------------------------------------------------------
// Build the HostMaintenanceSpec for vSAN evacuation.
// -------------------------------------------------------------------

var spec = null;
try {
    spec = new VcHostMaintenanceSpec();
    var vsanMode = new VcVsanHostDecommissionMode();
    vsanMode.objectAction = vsanDataEvacuationMode;
    spec.vsanMode = vsanMode;
} catch (e) {
    // Spec construction shouldn't fail in normal operation. If it
    // does, fall back to passing null spec — host enters MM with
    // vCenter default behavior.
    spec = null;
    auditLogger.auditLog(
        LOG_PREFIX, "MM_ENTER", "WARN",
        "Could not build HostMaintenanceSpec; using default | error=" + e.message
    );
}

// -------------------------------------------------------------------
// Invoke MM-enter task. Signature:
//   enterMaintenanceMode_Task(timeout:int, evacuatePoweredOffVms:bool, maintenanceSpec)
// timeout in seconds, 0 = no SDK-side timeout (we manage timeout
// ourselves via task polling).
// -------------------------------------------------------------------

var task = null;
try {
    task = targetHost.enterMaintenanceMode_Task(0, evacuatePoweredOffVms, spec);
} catch (e) {
    result.put("error", "enterMaintenanceMode_Task threw: " + e.message);
    auditLogger.auditLog(
        LOG_PREFIX, "MM_ENTER", "FAIL",
        "Could not start MM-enter task | host=" + hostFqdn +
        " | error=" + e.message
    );
    return result;
}

if (task == null) {
    result.put("error", "enterMaintenanceMode_Task returned null");
    return result;
}

auditLogger.auditLog(
    LOG_PREFIX, "MM_ENTER", "OK",
    "MM-enter task started | host=" + hostFqdn +
    " | mode=" + vsanDataEvacuationMode +
    " | evacuatePoweredOff=" + evacuatePoweredOffVms +
    " | timeoutSec=" + timeoutSeconds
);

// -------------------------------------------------------------------
// Poll task to completion.
// -------------------------------------------------------------------

var pollIntervalMs = 5000;
var deadlineMs = startMs + (timeoutSeconds * 1000);

while (true) {
    var nowMs = (new Date()).getTime();
    if (nowMs >= deadlineMs) {
        result.put("error", "MM-enter task timed out after " + timeoutSeconds + "s");
        result.put("taskState", "timedout");
        result.put("durationSec", Math.round((nowMs - startMs) / 1000));
        auditLogger.auditLog(
            LOG_PREFIX, "MM_ENTER", "FAIL",
            "MM-enter task timed out | host=" + hostFqdn
        );
        return result;
    }

    var info = null;
    try {
        info = task.info;
    } catch (e) {
        // Transient SDK error reading task info — wait and retry.
        System.sleep(pollIntervalMs);
        continue;
    }

    if (info == null) {
        System.sleep(pollIntervalMs);
        continue;
    }

    var stateStr = "(unknown)";
    try {
        stateStr = info.state != null
            ? (typeof info.state === "string" ? info.state : String(info.state.value))
            : "(unknown)";
    } catch (e) {
        stateStr = "(unknown)";
    }

    if (stateStr === "success") {
        result.put("success", true);
        result.put("taskState", stateStr);
        result.put("durationSec", Math.round((nowMs - startMs) / 1000));
        auditLogger.auditLog(
            LOG_PREFIX, "MM_ENTER", "DONE",
            "Host entered MM | host=" + hostFqdn +
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
            LOG_PREFIX, "MM_ENTER", "FAIL",
            "MM-enter task failed | host=" + hostFqdn +
            " | error=" + errMsg
        );
        return result;
    }

    // Still running.
    System.sleep(pollIntervalMs);
}
