// ===================================================================
// ACTION:    waitForHostReconnect
// MODULE:    com.broadcom.pso.vc.esxi.remediation.host
// PURPOSE:   After rebootHost has been called, poll the host's
//            connection state until either:
//              * The host is fully connected (success)
//              * The reboot budget elapses (timeout / failure)
//
//            The polling pattern is two-phase:
//              Phase A — wait for host to GO OFFLINE (i.e.
//                        connectionState transitions away from
//                        "connected"). Confirms the reboot
//                        actually started. ~60 second budget.
//              Phase B — wait for host to COME BACK ONLINE
//                        (connectionState back to "connected"
//                        AND host.runtime.bootTime is recent).
//                        Up to rebootBudgetSeconds.
//
// PHASE:     RECONNECT
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-HOST]
//
// INPUTS:
//   targetHost           (VC:HostSystem)
//   rebootBudgetSeconds  (number) — Total budget for the host to
//                                    return. Default 1500 (25 min).
//   beforeBootTime       (Date)   — host.runtime.bootTime captured
//                                    BEFORE rebootHost was called.
//                                    Used to confirm the host
//                                    actually rebooted (current
//                                    boot time differs from
//                                    captured value).
//
// RETURNS: Properties — {
//            success           (boolean)
//            wentOffline       (boolean) — Phase A succeeded
//            cameBackOnline    (boolean) — Phase B succeeded
//            bootTimeChanged   (boolean) — bootTime differs from
//                                           the captured value
//            durationSec       (number)
//            reason            (string)
//          }
//
// REQUIREMENT TRACE:
//   Implements: FR-19 step 8 (RECONNECT phase), C-10 (default 25
//               min reboot budget).
//
// NOTES:
//   - The action polls every 15 seconds during Phase A and every
//     30 seconds during Phase B.
//   - Phase A timeout (60 seconds) is short because the reboot
//     should start within seconds. If the host is still
//     "connected" after 60 seconds, the reboot didn't actually
//     start — a hardware or firmware issue has wedged it.
//   - Phase B's success criterion is BOTH connection state
//     AND boot time differing. Just connection state isn't
//     enough — vCenter sometimes reports a host as connected
//     before its services are fully back, leading to false-
//     positive "online" detection. The bootTime change is
//     definitive.
//   - If beforeBootTime is null/undefined, we skip the boot-
//     time check and rely solely on connection state. This
//     should not happen in normal workflow operation but is
//     a defensive fallback.
//   - The action does NOT verify that the patch was actually
//     applied — that's verifyPatchedBuild's job.
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-HOST]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

if (arguments.length < 1) {
    throw new Error(
        "waitForHostReconnect requires 1-3 inputs: " +
        "(targetHost, [rebootBudgetSeconds], [beforeBootTime])."
    );
}
var targetHost          = arguments[0];
var rebootBudgetSeconds = arguments.length >= 2 ? arguments[1] : 1500;
var beforeBootTime      = arguments.length >= 3 ? arguments[2] : null;

if (targetHost == null) {
    throw new Error("waitForHostReconnect: 'targetHost' must not be null.");
}
if (typeof rebootBudgetSeconds !== "number" || rebootBudgetSeconds < 60) {
    rebootBudgetSeconds = 1500;
}

var hostFqdn = String(targetHost.name);

var result = new Properties();
result.put("success", false);
result.put("wentOffline", false);
result.put("cameBackOnline", false);
result.put("bootTimeChanged", false);
result.put("durationSec", 0);
result.put("reason", "Initial state");

var startMs = (new Date()).getTime();

auditLogger.auditLog(
    LOG_PREFIX, "RECONNECT", "OK",
    "Starting reconnect wait | host=" + hostFqdn +
    " | budgetSec=" + rebootBudgetSeconds +
    " | beforeBootTime=" + (beforeBootTime != null ? beforeBootTime.toString() : "(null)")
);

// -------------------------------------------------------------------
// Helper: read connection state safely.
// -------------------------------------------------------------------
function getConnState(host) {
    try {
        if (host.runtime != null && host.runtime.connectionState != null) {
            return String(host.runtime.connectionState.value);
        }
    } catch (e) { /* return unknown */ }
    return "(unknown)";
}

function getBootTime(host) {
    try {
        if (host.runtime != null && host.runtime.bootTime != null) {
            return host.runtime.bootTime;
        }
    } catch (e) { /* return null */ }
    return null;
}

// -------------------------------------------------------------------
// Phase A: wait for host to go offline (connection state transitions
// away from "connected").
// -------------------------------------------------------------------

var phaseATimeoutMs = 60 * 1000;
var phaseADeadlineMs = startMs + phaseATimeoutMs;

while ((new Date()).getTime() < phaseADeadlineMs) {
    var stA = getConnState(targetHost);
    if (stA !== "connected") {
        result.put("wentOffline", true);
        auditLogger.auditLog(
            LOG_PREFIX, "RECONNECT", "OK",
            "Host went offline | host=" + hostFqdn + " | state=" + stA
        );
        break;
    }
    System.sleep(15000);
}

if (result.get("wentOffline") !== true) {
    result.put("reason",
        "Host did not go offline within Phase A (60s); reboot may not have started"
    );
    result.put("durationSec",
        Math.round(((new Date()).getTime() - startMs) / 1000));
    auditLogger.auditLog(
        LOG_PREFIX, "RECONNECT", "FAIL",
        "Phase A timed out | host=" + hostFqdn
    );
    return result;
}

// -------------------------------------------------------------------
// Phase B: wait for host to come back online AND for bootTime to
// have changed (if we have a beforeBootTime).
// -------------------------------------------------------------------

var phaseBDeadlineMs = startMs + (rebootBudgetSeconds * 1000);

while ((new Date()).getTime() < phaseBDeadlineMs) {
    var stB = getConnState(targetHost);

    if (stB === "connected") {
        // Connection restored. Check bootTime if we have a baseline.
        var nowBoot = getBootTime(targetHost);
        var bootChanged = false;

        if (beforeBootTime == null) {
            // No baseline; trust connection state alone.
            bootChanged = true;
        } else if (nowBoot != null) {
            // Compare epoch ms.
            try {
                if (nowBoot.getTime() !== beforeBootTime.getTime()) {
                    bootChanged = true;
                }
            } catch (e) {
                // Compare failed; treat as changed (permissive).
                bootChanged = true;
            }
        }

        if (bootChanged) {
            result.put("cameBackOnline", true);
            result.put("bootTimeChanged", true);
            result.put("success", true);
            result.put("durationSec",
                Math.round(((new Date()).getTime() - startMs) / 1000));
            result.put("reason",
                "Host reconnected | durationSec=" + result.get("durationSec")
            );
            auditLogger.auditLog(
                LOG_PREFIX, "RECONNECT", "DONE",
                "Host back online and rebooted | host=" + hostFqdn +
                " | durationSec=" + result.get("durationSec")
            );
            return result;
        }
        // Otherwise — still connected but bootTime not changed
        // yet. Could be transient SDK lag; keep waiting.
    }

    System.sleep(30000);
}

result.put("durationSec",
    Math.round(((new Date()).getTime() - startMs) / 1000));
result.put("reason",
    "Reboot budget exhausted | budgetSec=" + rebootBudgetSeconds +
    " | wentOffline=" + result.get("wentOffline") +
    " | cameBackOnline=" + result.get("cameBackOnline")
);
auditLogger.auditLog(
    LOG_PREFIX, "RECONNECT", "FAIL",
    "Reconnect wait exhausted budget | host=" + hostFqdn +
    " | budgetSec=" + rebootBudgetSeconds
);
return result;
