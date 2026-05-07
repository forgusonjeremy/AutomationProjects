// ===================================================================
// ACTION:    getLockdownModeStatus
// MODULE:    com.broadcom.pso.vc.esxi.remediation.preflight
// PURPOSE:   Enumerate the lockdown mode state of every host in the
//            cluster. Lockdown mode prevents the workflow from
//            creating an ephemeral local user account on the host
//            (per AD-08), so lockdown hosts cannot be patched but
//            they DO continue to count toward FTT/HA capacity since
//            they remain online and serve workloads.
//
// PHASE:     VALIDATE / DISCOVER
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-PREFLIGHT]
//
// INPUTS:
//   cluster (VC:ClusterComputeResource)
//
// RETURNS: Properties — {
//            hostsTotal           (number)
//            hostsLockdownDisabled (Array/Properties) —
//                                  patchable hosts (lockdown off)
//            hostsLockdownNormal   (Array/Properties) —
//                                  not patchable, reachable from vCenter
//            hostsLockdownStrict   (Array/Properties) —
//                                  not patchable, no DCUI either
//            allLockedDown         (boolean) — true iff zero hosts
//                                  have lockdown disabled (workflow
//                                  cannot proceed at all)
//            anyLockedDown         (boolean) — true iff at least one
//                                  host is locked down (warning)
//          }
//          Each host entry: { name: string, moRef: string,
//                             mode: "lockdownDisabled"|"lockdownNormal"|"lockdownStrict" }
//
// REQUIREMENT TRACE:
//   Implements: FR-15 (lockdown mode enumeration), FR-17 (block
//               clusters with all hosts locked down — no patchable
//               hosts), FR-18 (warn when some hosts locked down),
//               FR-29, AD-09 (lockdown hosts skipped, contribute to
//               capacity).
//
// NOTES:
//   - Lockdown state is at host.config.adminDisabled (boolean,
//     deprecated) and host.config.lockdownMode (modern enum). We
//     read lockdownMode preferentially.
//   - lockdownMode enum values:
//       lockdownDisabled — normal operation; we can SSH in.
//       lockdownNormal   — user accounts on Exception Users list
//                          can still log in via vSphere; root SSH
//                          is blocked even with credentials.
//       lockdownStrict   — even DCUI access is blocked; the host is
//                          fully managed only via vCenter.
//     The KB 000345284 procedure requires SSH login as a local
//     account, which is blocked by both Normal and Strict modes.
//     We treat both as "skip this host."
//   - Disconnected hosts are reported with mode="(disconnected)"
//     so they appear in summary output.
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-PREFLIGHT]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

if (arguments.length < 1) {
    throw new Error("getLockdownModeStatus requires 1 input: cluster.");
}
var cluster = arguments[0];

if (cluster == null) {
    throw new Error("getLockdownModeStatus: 'cluster' must not be null.");
}

var hosts = cluster.host;
if (hosts == null) hosts = [];

var hostsLockdownDisabled = [];
var hostsLockdownNormal = [];
var hostsLockdownStrict = [];
var hostsDisconnected = [];

for (var i = 0; i < hosts.length; i++) {
    var host = hosts[i];
    if (host == null) continue;

    var hostName = String(host.name);
    var hostMoRef = String(host.id);

    var connState = "(unknown)";
    try {
        if (host.runtime != null && host.runtime.connectionState != null) {
            connState = String(host.runtime.connectionState.value);
        }
    } catch (e) {
        connState = "(unknown)";
    }

    if (connState !== "connected") {
        hostsDisconnected.push({
            name: hostName,
            moRef: hostMoRef,
            mode: "(disconnected)"
        });
        continue;
    }

    var mode = "(unknown)";
    try {
        if (host.config != null && host.config.lockdownMode != null) {
            // lockdownMode may surface as a string OR an enum object.
            if (typeof host.config.lockdownMode === "string") {
                mode = host.config.lockdownMode;
            } else if (host.config.lockdownMode.value != null) {
                mode = String(host.config.lockdownMode.value);
            }
        } else if (host.config != null && host.config.adminDisabled === true) {
            // Legacy fallback: deprecated boolean field equates to
            // the old lockdown-on / lockdown-off semantics. We map
            // adminDisabled=true to lockdownNormal as a safe default.
            mode = "lockdownNormal";
        } else {
            mode = "lockdownDisabled";
        }
    } catch (e) {
        // Could not read; treat as locked down (failing safe).
        mode = "lockdownNormal";
    }

    var entry = { name: hostName, moRef: hostMoRef, mode: mode };

    if (mode === "lockdownDisabled") {
        hostsLockdownDisabled.push(entry);
    } else if (mode === "lockdownNormal") {
        hostsLockdownNormal.push(entry);
    } else if (mode === "lockdownStrict") {
        hostsLockdownStrict.push(entry);
    } else {
        // Unknown mode: treat as Normal lockdown (failing safe).
        entry.mode = "lockdownNormal";
        hostsLockdownNormal.push(entry);
    }
}

var lockedDownCount = hostsLockdownNormal.length + hostsLockdownStrict.length;
var allLockedDown = (hosts.length > 0 && hostsLockdownDisabled.length === 0);
var anyLockedDown = (lockedDownCount > 0);

var result = new Properties();
result.put("hostsTotal", hosts.length);
result.put("hostsLockdownDisabled", hostsLockdownDisabled);
result.put("hostsLockdownNormal", hostsLockdownNormal);
result.put("hostsLockdownStrict", hostsLockdownStrict);
result.put("hostsDisconnected", hostsDisconnected);
result.put("allLockedDown", allLockedDown);
result.put("anyLockedDown", anyLockedDown);

auditLogger.auditLog(
    LOG_PREFIX, "VALIDATE", anyLockedDown ? "WARN" : "OK",
    "Lockdown check | cluster=" + cluster.name +
    " | total=" + hosts.length +
    " | disabled=" + hostsLockdownDisabled.length +
    " | normal=" + hostsLockdownNormal.length +
    " | strict=" + hostsLockdownStrict.length
);

return result;
