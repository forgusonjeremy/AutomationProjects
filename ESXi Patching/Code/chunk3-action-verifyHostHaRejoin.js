// ===================================================================
// ACTION:    verifyHostHaRejoin
// MODULE:    com.broadcom.pso.vc.esxi.remediation.host
// PURPOSE:   After the host has reconnected and verified its
//            patched build, confirm it has successfully rejoined
//            the cluster's HA setup. HA rejoin is what makes the
//            host count toward FTT capacity again — a host that
//            is online but has NOT rejoined HA is unusable for
//            VM placement and effectively lowers cluster
//            redundancy.
//
//            Per AD-09, an HA_REJOIN failure classifies the host
//            as "unusable" — even though the patch may have
//            installed correctly. The cluster-level logic counts
//            HA_REJOIN failures separately for residual capacity
//            decisions (per AD-09 / FR-27).
//
// PHASE:     HA_REJOIN
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-HOST]
//
// INPUTS:
//   targetHost     (VC:HostSystem)
//   timeoutSeconds (number) — Default 600 (10 min). HA agent
//                              re-init usually happens in 1-2
//                              minutes; longer timeout is for
//                              loaded clusters.
//
// RETURNS: Properties — {
//            rejoined          (boolean)
//            haAgentState      (string)
//            durationSec       (number)
//            reason            (string)
//          }
//
// REQUIREMENT TRACE:
//   Implements: FR-19 step 11 (HA_REJOIN), AD-09 (HA_REJOIN
//               failures excluded from residual capacity), FR-27.
//
// NOTES:
//   - HA agent state is at host.runtime.dasHostState.state. Values:
//       uninitialized, initializationError, agentUnreachable,
//       hostUnreachable, primary, secondary, master, slave,
//       fdmUnreachable, networkLost, networkPartitionedFromMaster,
//       networkIsolated.
//     The "good" values are "primary", "secondary", "master",
//     "slave" — meaning the host has joined HA and has a role.
//   - On clusters where HA is disabled, dasHostState may be
//     null. We treat null as "rejoin not applicable" → success.
//   - The state transitions during HA re-init: typically
//     uninitialized → initializing → master/slave. We poll
//     every 10 seconds until we see one of the good states.
//   - timeoutSeconds defaults to 600. After this, return
//     rejoined=false with the most recently observed state.
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-HOST]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

if (arguments.length < 1) {
    throw new Error("verifyHostHaRejoin requires 1-2 inputs: (targetHost, [timeoutSeconds]).");
}
var targetHost     = arguments[0];
var timeoutSeconds = arguments.length >= 2 ? arguments[1] : 600;

if (targetHost == null) {
    throw new Error("verifyHostHaRejoin: 'targetHost' must not be null.");
}
if (typeof timeoutSeconds !== "number" || timeoutSeconds < 30) timeoutSeconds = 600;

var hostFqdn = String(targetHost.name);

var result = new Properties();
result.put("rejoined", false);
result.put("haAgentState", "(unknown)");
result.put("durationSec", 0);
result.put("reason", "Initial state");

var startMs = (new Date()).getTime();
var deadlineMs = startMs + (timeoutSeconds * 1000);

// Healthy state values that indicate successful rejoin.
var healthyStates = ["primary", "secondary", "master", "slave"];

while ((new Date()).getTime() < deadlineMs) {
    var state = "(unknown)";
    var dasHostStatePresent = false;

    try {
        if (targetHost.runtime != null && targetHost.runtime.dasHostState != null) {
            dasHostStatePresent = true;
            if (targetHost.runtime.dasHostState.state != null) {
                state = typeof targetHost.runtime.dasHostState.state === "string"
                    ? targetHost.runtime.dasHostState.state
                    : String(targetHost.runtime.dasHostState.state.value);
            }
        }
    } catch (e) {
        state = "(unknown)";
    }

    // If dasHostState is absent, HA isn't active — treat as no-op rejoin.
    if (!dasHostStatePresent) {
        result.put("rejoined", true);
        result.put("haAgentState", "(not applicable)");
        result.put("durationSec",
            Math.round(((new Date()).getTime() - startMs) / 1000));
        result.put("reason", "HA not active on cluster; no rejoin required");
        auditLogger.auditLog(
            LOG_PREFIX, "HA_REJOIN", "OK",
            "HA not active; no rejoin required | host=" + hostFqdn
        );
        return result;
    }

    result.put("haAgentState", state);

    // Check if state is healthy.
    var healthy = false;
    for (var i = 0; i < healthyStates.length; i++) {
        if (state === healthyStates[i]) {
            healthy = true;
            break;
        }
    }

    if (healthy) {
        result.put("rejoined", true);
        result.put("durationSec",
            Math.round(((new Date()).getTime() - startMs) / 1000));
        result.put("reason",
            "Host rejoined HA | state=" + state +
            " | durationSec=" + result.get("durationSec")
        );
        auditLogger.auditLog(
            LOG_PREFIX, "HA_REJOIN", "DONE",
            "Host rejoined HA | host=" + hostFqdn + " | state=" + state
        );
        return result;
    }

    System.sleep(10000);
}

result.put("durationSec",
    Math.round(((new Date()).getTime() - startMs) / 1000));
result.put("reason",
    "HA rejoin timed out after " + timeoutSeconds + "s | last observed state=" +
    result.get("haAgentState")
);
auditLogger.auditLog(
    LOG_PREFIX, "HA_REJOIN", "FAIL",
    "HA rejoin timed out | host=" + hostFqdn +
    " | timeoutSec=" + timeoutSeconds +
    " | lastState=" + result.get("haAgentState")
);
return result;
