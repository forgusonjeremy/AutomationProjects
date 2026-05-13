// ===================================================================
// ACTION:    checkClusterHostsHealthy
// MODULE:    com.broadcom.pso.vc.esxi.remediation.preflight
// PURPOSE:   Evaluate the connection state of every host in the
//            cluster. Hosts that are disconnected, in maintenance
//            mode, or in standby cannot be reliably patched and
//            their presence may indicate ongoing operations that
//            collide with this workflow.
//
// PHASE:     VALIDATE
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-PREFLIGHT]
//
// INPUTS:
//   cluster (VC:ClusterComputeResource)
//
// RETURNS: Properties — {
//            allHealthy           (boolean)
//            hostsTotal           (number)
//            hostsConnected       (number)
//            hostsDisconnected    (Array/Properties) — { name, moRef }
//            hostsInMaintenanceMode (Array/Properties) — { name, moRef }
//            hostsInStandby       (Array/Properties) — { name, moRef }
//            hostsNotResponding   (Array/Properties) — { name, moRef }
//            reason               (string)
//          }
//
// REQUIREMENT TRACE:
//   Implements: FR-15 (host connection state evaluation), FR-17
//               (block clusters with unhealthy hosts).
//
// NOTES:
//   - Connection state values from vSphere SDK:
//       connected, disconnected, notResponding
//   - Power state values:
//       poweredOn, poweredOff, standBy
//   - In maintenance mode is host.runtime.inMaintenanceMode (boolean).
//   - The action reports individual lists for each problematic state
//     so downstream code can compose granular Validation Summary
//     messages per AD-12.
//   - "Healthy" for purposes of starting a patch run means: connected,
//     powered on, not in MM. A cluster with one host in MM is NOT
//     healthy at workflow start because we cannot tell whether the MM
//     host is leftover from another operation. This is a stricter
//     check than the per-host MM_PRECHECK during patching.
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-PREFLIGHT]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

if (arguments.length < 1) {
    throw new Error("checkClusterHostsHealthy requires 1 input: cluster.");
}
var cluster = arguments[0];

if (cluster == null) {
    throw new Error("checkClusterHostsHealthy: 'cluster' must not be null.");
}

var hosts = cluster.host;
if (hosts == null) hosts = [];

var hostsConnected = 0;
var hostsDisconnected = [];
var hostsInMaintenanceMode = [];
var hostsInStandby = [];
var hostsNotResponding = [];

for (var i = 0; i < hosts.length; i++) {
    var host = hosts[i];
    if (host == null) continue;

    var hostName = "(unknown)";
    var hostMoRef = "(unknown)";

    try {
        hostName = String(host.name);
        hostMoRef = String(host.id);
    } catch (e) {
        // Defensive: skip hosts whose basic identity cannot be read.
        continue;
    }

    var connState = "(unknown)";
    var powerState = "(unknown)";
    var inMM = false;

    try {
        if (host.runtime != null) {
            if (host.runtime.connectionState != null) {
                connState = String(host.runtime.connectionState.value);
            }
            if (host.runtime.powerState != null) {
                powerState = String(host.runtime.powerState.value);
            }
            inMM = host.runtime.inMaintenanceMode === true;
        }
    } catch (e) {
        // Treat unreadable runtime state as disconnected.
        connState = "disconnected";
    }

    var entry = { name: hostName, moRef: hostMoRef };

    if (connState === "disconnected") {
        hostsDisconnected.push(entry);
    } else if (connState === "notResponding") {
        hostsNotResponding.push(entry);
    } else if (inMM) {
        hostsInMaintenanceMode.push(entry);
    } else if (powerState === "standBy") {
        hostsInStandby.push(entry);
    } else if (connState === "connected" && powerState === "poweredOn") {
        hostsConnected++;
    } else {
        // Catch-all: unexpected state. Record under "notResponding"
        // for visibility, since this is not a healthy state.
        hostsNotResponding.push(entry);
    }
}

var allHealthy = (
    hostsDisconnected.length === 0 &&
    hostsInMaintenanceMode.length === 0 &&
    hostsInStandby.length === 0 &&
    hostsNotResponding.length === 0 &&
    hostsConnected > 0
);

var reasonParts = [];
if (hostsConnected === 0) reasonParts.push("no hosts connected");
if (hostsDisconnected.length > 0) reasonParts.push(hostsDisconnected.length + " disconnected");
if (hostsInMaintenanceMode.length > 0) reasonParts.push(hostsInMaintenanceMode.length + " in MM");
if (hostsInStandby.length > 0) reasonParts.push(hostsInStandby.length + " in standby");
if (hostsNotResponding.length > 0) reasonParts.push(hostsNotResponding.length + " not responding");

var reason = allHealthy
    ? "All " + hostsConnected + " hosts connected and operational"
    : "Issues: " + reasonParts.join(", ");

var result = new Properties();
result.put("allHealthy", allHealthy);
result.put("hostsTotal", hosts.length);
result.put("hostsConnected", hostsConnected);
result.put("hostsDisconnected", hostsDisconnected);
result.put("hostsInMaintenanceMode", hostsInMaintenanceMode);
result.put("hostsInStandby", hostsInStandby);
result.put("hostsNotResponding", hostsNotResponding);
result.put("reason", reason);

auditLogger.auditLog(
    LOG_PREFIX, "VALIDATE", allHealthy ? "OK" : "FAIL",
    "Host health check | cluster=" + cluster.name + " | " + reason
);

return result;
