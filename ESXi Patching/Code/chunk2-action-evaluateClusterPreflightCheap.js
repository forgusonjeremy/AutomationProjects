// ===================================================================
// ACTION:    evaluateClusterPreflightCheap
// MODULE:    com.broadcom.pso.vc.esxi.remediation.preflight
// PURPOSE:   Run the cheap form-time pre-flight checks on a single
//            cluster and aggregate results into a structured finding.
//            "Cheap" means no vSAN resync probe and no recent-task
//            history (those are workflow-start-time only — too slow
//            to run on every form-time cluster picker render).
//
//            This action is invoked once per cluster as part of the
//            form-time validation sweep that produces the
//            Validation Summary text area (per AD-12).
//
// PHASE:     VALIDATE (form-time)
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-PREFLIGHT]
//
// INPUTS:
//   cluster                  (VC:ClusterComputeResource)
//   depotName                (string)  — Selected depot's name for
//                                         version-mismatch check.
//                                         Pass empty string to
//                                         skip depot version check.
//   smallClusterAcknowledged (boolean) — True if Ack2 is checked.
//   ignoreWarnings           (boolean) — True if operator ticked
//                                         the silence-warnings option.
//
// RETURNS: Properties — {
//            status        (string)  — "READY" | "WARNING" | "BLOCKED"
//            findings      (Array/Properties) — entries:
//                          { severity: "CRITICAL"|"WARNING"|"INFO",
//                            check:    string (which sub-check),
//                            message:  string }
//            clusterType   (string)  — VXRAIL/POWERFLEX/etc.
//            hostCount     (number)
//          }
//
// REQUIREMENT TRACE:
//   Implements: FR-15 (form-time checks), FR-17 (block conditions),
//               FR-18 (warn conditions), AD-12 (validation summary
//               source), AD-04 (3-node BLOCKED, 4-node ACK,
//               5+ READY).
//
// CHECKS PERFORMED:
//   1. Cluster type identification (CRITICAL if not VXRAIL).
//   2. Host count vs. AD-04 hybrid policy.
//   3. ESXi 8.x verification (CRITICAL if any pre-8 hosts).
//   4. HA enabled and healthy (CRITICAL if not).
//   5. DRS enabled and fully automated (CRITICAL if not).
//   6. Host connection states (CRITICAL if any disconnected/MM
//      at form time — these would prevent the run from starting
//      cleanly).
//   7. Lockdown mode enumeration (WARNING if some hosts locked
//      down; CRITICAL if all hosts locked down).
//   8. vSAN health (curated subset; WARNING on findings).
//   9. DRS migration constraints (WARNING on findings).
//  10. Depot version compatibility (CRITICAL for major mismatch
//      since C-14 limits us to within-major).
//
// NOTES:
//   - "CRITICAL" findings always set status BLOCKED.
//   - "WARNING" findings set status WARNING unless ignoreWarnings=
//     true AND the warning is non-blocking (i.e. silenceable per
//     FR-18). The 4-node-without-Ack case is NOT silenceable —
//     it is a CRITICAL finding regardless of ignoreWarnings.
//   - The action does NOT call vSAN resync (workflow-start only)
//     or recent-task probe (workflow-start only). Those expensive
//     checks happen later in the lifecycle.
//   - Aggregation is conservative: any CRITICAL → BLOCKED,
//     any WARNING (after silence-handling) → WARNING, otherwise
//     READY.
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-PREFLIGHT]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

if (arguments.length < 4) {
    throw new Error(
        "evaluateClusterPreflightCheap requires 4 inputs: " +
        "(cluster, depotName, smallClusterAcknowledged, ignoreWarnings)."
    );
}
var cluster                  = arguments[0];
var depotName                = arguments[1];
var smallClusterAcknowledged = arguments[2];
var ignoreWarnings           = arguments[3];

if (cluster == null) {
    throw new Error("evaluateClusterPreflightCheap: 'cluster' must not be null.");
}
if (typeof depotName !== "string") depotName = "";
if (typeof smallClusterAcknowledged !== "boolean") smallClusterAcknowledged = false;
if (typeof ignoreWarnings !== "boolean") ignoreWarnings = false;

var detect = System.getModule("com.broadcom.pso.vc.esxi.remediation.detect");
var preflight = System.getModule("com.broadcom.pso.vc.esxi.remediation.preflight");

var findings = [];

// ---- Check 1: cluster type ----
var clusterType = detect.identifyClusterType(cluster);
if (clusterType !== "VXRAIL") {
    findings.push({
        severity: "CRITICAL",
        check: "ClusterType",
        message: "Cluster type is " + clusterType + ", not VXRAIL. Out of scope per AD-06."
    });
}

// ---- Check 2: cluster size (AD-04) ----
var hosts = cluster.host;
var hostCount = hosts != null ? hosts.length : 0;

if (hostCount < 3) {
    findings.push({
        severity: "CRITICAL",
        check: "ClusterSize",
        message: "Cluster has " + hostCount + " host(s). Minimum 4 required."
    });
} else if (hostCount === 3) {
    findings.push({
        severity: "CRITICAL",
        check: "ClusterSize",
        message: "3-node cluster blocked per AD-04 hybrid policy. Minimum 4 hosts required."
    });
} else if (hostCount === 4) {
    if (smallClusterAcknowledged) {
        findings.push({
            severity: "INFO",
            check: "ClusterSize",
            message: "4-node cluster acknowledged (Ack2). Will be patched at vSAN FTT=1 floor."
        });
    } else {
        findings.push({
            severity: "CRITICAL",
            check: "ClusterSize",
            message: "4-node cluster requires Ack2 acknowledgement. Check the small-cluster acknowledgement box."
        });
    }
}
// 5+ node: no finding needed.

// ---- Check 3: ESXi 8.x ----
if (clusterType === "VXRAIL") {
    var versionCheck = preflight.verifyAllHostsOn8x(cluster);
    if (versionCheck.get("allOn8x") !== true) {
        var nonCompliant = versionCheck.get("nonCompliantHosts");
        var versionList = "";
        for (var v = 0; v < nonCompliant.length; v++) {
            if (versionList.length > 0) versionList += ", ";
            versionList += nonCompliant[v].hostName + "(" + nonCompliant[v].version + ")";
            if (versionList.length > 200) {
                versionList += " [+more]";
                break;
            }
        }
        findings.push({
            severity: "CRITICAL",
            check: "ESXiVersion",
            message: "Cluster contains hosts not on ESXi 8.x: " + versionList
        });
    }
}

// ---- Check 4: HA ----
var haCheck = preflight.checkClusterHaHealth(cluster);
if (haCheck.get("healthy") !== true) {
    findings.push({
        severity: "CRITICAL",
        check: "HA",
        message: haCheck.get("reason")
    });
}

// ---- Check 5: DRS ----
var drsCheck = preflight.checkClusterDrsHealth(cluster);
if (drsCheck.get("healthy") !== true) {
    findings.push({
        severity: "CRITICAL",
        check: "DRS",
        message: drsCheck.get("reason")
    });
}

// ---- Check 6: host connection state ----
var hostsCheck = preflight.checkClusterHostsHealthy(cluster);
if (hostsCheck.get("allHealthy") !== true) {
    findings.push({
        severity: "CRITICAL",
        check: "HostStates",
        message: hostsCheck.get("reason")
    });
}

// ---- Check 7: lockdown ----
var lockdownCheck = preflight.getLockdownModeStatus(cluster);
if (lockdownCheck.get("allLockedDown") === true) {
    findings.push({
        severity: "CRITICAL",
        check: "Lockdown",
        message: "All hosts in lockdown mode. No patchable hosts available."
    });
} else if (lockdownCheck.get("anyLockedDown") === true) {
    var lockdownNormalCount = lockdownCheck.get("hostsLockdownNormal").length;
    var lockdownStrictCount = lockdownCheck.get("hostsLockdownStrict").length;
    findings.push({
        severity: "WARNING",
        check: "Lockdown",
        message: (lockdownNormalCount + lockdownStrictCount) + " host(s) in lockdown — will be skipped (still count toward FTT capacity)."
    });
}

// ---- Check 8: vSAN health (curated only at form time) ----
if (clusterType === "VXRAIL") {
    var vsanCheck = preflight.checkVsanHealth(cluster, null);
    if (vsanCheck.get("healthy") !== true && vsanCheck.get("error") === "") {
        // Real findings (not probe failure).
        findings.push({
            severity: "WARNING",
            check: "vSANHealth",
            message: vsanCheck.get("reason")
        });
    }
    // probe-failure case: silently OK at form time.
}

// ---- Check 9: DRS migration constraints ----
var drsConstraints = preflight.checkDrsMigrationConstraints(cluster);
if (drsConstraints.get("clean") !== true) {
    findings.push({
        severity: "WARNING",
        check: "DRSMigration",
        message: drsConstraints.get("reason")
    });
}

// ---- Check 10: depot version compatibility (only if depot selected) ----
if (depotName !== "") {
    var depotCheck = preflight.checkDepotVersionCompatibility(cluster, depotName);
    if (depotCheck.get("compatible") !== true) {
        // Major version mismatch is CRITICAL (cross-major out of scope).
        findings.push({
            severity: "CRITICAL",
            check: "DepotVersion",
            message: depotCheck.get("reason")
        });
    }
}

// -------------------------------------------------------------------
// Aggregate to status. CRITICAL → BLOCKED. WARNING → WARNING
// (unless ignoreWarnings, in which case demote to INFO and still
// READY — except that 4-node-without-ack is CRITICAL, not WARNING).
// -------------------------------------------------------------------

var hasCritical = false;
var hasWarning = false;

for (var i = 0; i < findings.length; i++) {
    if (findings[i].severity === "CRITICAL") {
        hasCritical = true;
    } else if (findings[i].severity === "WARNING") {
        hasWarning = true;
    }
}

var status;
if (hasCritical) {
    status = "BLOCKED";
} else if (hasWarning && !ignoreWarnings) {
    status = "WARNING";
} else {
    status = "READY";
}

var result = new Properties();
result.put("status", status);
result.put("findings", findings);
result.put("clusterType", clusterType);
result.put("hostCount", hostCount);

auditLogger.auditLog(
    LOG_PREFIX, "VALIDATE", status === "READY" ? "OK" : (status === "WARNING" ? "WARN" : "FAIL"),
    "Cheap preflight | cluster=" + cluster.name +
    " | status=" + status +
    " | findings=" + findings.length
);

return result;
