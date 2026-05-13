// ===================================================================
// ACTION:    identifyClusterType
// MODULE:    com.broadcom.pso.vc.esxi.remediation.detect
// PURPOSE:   Positively classify a cluster as one of:
//              "VXRAIL"       — VxRail-managed cluster (in scope)
//              "POWERFLEX"    — PowerFlex cluster (out of scope per AD-06)
//              "VSAN-ONLY"    — vSAN-enabled but not VxRail (out of scope)
//              "OTHER"        — VMFS/NFS-only or unknown (out of scope)
//
//            The classifier uses positive identification — it only
//            returns VXRAIL or POWERFLEX when it has positive
//            evidence. Ambiguous clusters (e.g. vSAN-enabled with
//            no VxRail attribute) classify as VSAN-ONLY.
//
// PHASE:     DISCOVER
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-DETECT]
//
// INPUTS:
//   cluster (VC:ClusterComputeResource) — Cluster to classify.
//
// RETURNS: string — One of "VXRAIL", "POWERFLEX", "VSAN-ONLY", "OTHER".
//
// REQUIREMENT TRACE:
//   Implements: AD-06 (PowerFlex out of scope), FR-15 (cluster type
//               check), FR-17 (block non-VxRail clusters).
//
// CLASSIFICATION RULES:
//   1. Read custom attributes via getClusterCustomAttributes.
//   2. If "VxRail-IP" custom attribute is present and non-empty
//      → VXRAIL. (Verified detection signal per Section 3h.1.)
//   3. Else if any host in the cluster has the PowerFlex SDC VIB
//      installed → POWERFLEX. (Marked unverified in Section 3h.2;
//      we attempt detection but classify defensively if unsure.)
//   4. Else if vSAN is enabled on the cluster
//      (cluster.configurationEx.vsanConfigInfo.enabled === true)
//      → VSAN-ONLY. (Marked unverified; if API path is wrong, we
//      classify as OTHER which is also out-of-scope, so behavior
//      is acceptable either way.)
//   5. Else → OTHER.
//
// NOTES:
//   - PowerFlex SDC VIB detection is best-effort. The expected VIB
//     name pattern (per Section 3h.2 unverified item) is one of:
//       "scaleio-sdc"
//       "vmware-esx-scaleio-sdc"
//       "powerflex-sdc"
//     We probe for any of these. If detection fails (e.g. the host
//     doesn't expose imageConfigManager or VIB list cannot be
//     enumerated), we do NOT throw — we proceed without the
//     PowerFlex signal and let the result fall through to VSAN-ONLY
//     or OTHER. This is intentional: misclassifying a PowerFlex
//     cluster as VSAN-ONLY still keeps it out of scope (FR-17
//     blocks anything not VXRAIL), which is the safe outcome.
//   - vSAN config path is cluster.configurationEx.vsanConfigInfo.
//     Marked UNVERIFIED in Section 3h.2 — wrap reads in try/catch.
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-DETECT]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

// -------------------------------------------------------------------
// Input validation.
// -------------------------------------------------------------------

if (arguments.length < 1) {
    throw new Error("identifyClusterType requires 1 input: cluster (VC:ClusterComputeResource).");
}
var cluster = arguments[0];

if (cluster == null) {
    throw new Error("identifyClusterType: 'cluster' must not be null.");
}

// -------------------------------------------------------------------
// Step 1: Check for VxRail-IP custom attribute. This is the
// authoritative VxRail signal.
// -------------------------------------------------------------------

var customAttrs = System.getModule("com.broadcom.pso.vc.esxi.remediation.detect")
    .getClusterCustomAttributes(cluster);

var vxRailIp = customAttrs.get("VxRail-IP");
if (vxRailIp != null && String(vxRailIp).length > 0) {
    auditLogger.auditLog(
        LOG_PREFIX, "DISCOVER", "OK",
        "Cluster classified VXRAIL | cluster=" + cluster.name +
        " | VxRail-IP=" + vxRailIp
    );
    return "VXRAIL";
}

// -------------------------------------------------------------------
// Step 2: Check for PowerFlex SDC VIB on any host. Best-effort —
// if detection fails, fall through.
// -------------------------------------------------------------------

var powerflexVibPatterns = ["scaleio-sdc", "vmware-esx-scaleio-sdc", "powerflex-sdc"];
var powerflexDetected = false;

try {
    var hosts = cluster.host; // Array of VcHostSystem
    if (hosts != null) {
        // Only check the first host. PowerFlex requires the SDC VIB
        // on every host in the cluster, so checking one is
        // sufficient. Checking all is wasteful.
        var firstHost = hosts.length > 0 ? hosts[0] : null;
        if (firstHost != null && firstHost.configManager != null) {
            var imageConfigManager = firstHost.configManager.imageConfigManager;
            if (imageConfigManager != null) {
                // fetchSoftwarePackages returns an array of
                // SoftwarePackage objects. Each has .name (e.g.
                // "scaleio-sdc") and .vendor.
                var packages = imageConfigManager.fetchSoftwarePackages();
                if (packages != null) {
                    for (var i = 0; i < packages.length && !powerflexDetected; i++) {
                        var pkg = packages[i];
                        if (pkg == null || pkg.name == null) continue;
                        var pkgName = String(pkg.name).toLowerCase();
                        for (var j = 0; j < powerflexVibPatterns.length; j++) {
                            if (pkgName === powerflexVibPatterns[j]) {
                                powerflexDetected = true;
                                break;
                            }
                        }
                    }
                }
            }
        }
    }
} catch (e) {
    // Detection failed. Log a warning and continue — falling through
    // means the cluster classifies as VSAN-ONLY or OTHER, both of
    // which are also out-of-scope. Failing safe.
    auditLogger.auditLog(
        LOG_PREFIX, "DISCOVER", "WARN",
        "PowerFlex VIB detection threw, treating as not-PowerFlex | " +
        "cluster=" + cluster.name + " | error=" + e.message
    );
}

if (powerflexDetected) {
    auditLogger.auditLog(
        LOG_PREFIX, "DISCOVER", "OK",
        "Cluster classified POWERFLEX | cluster=" + cluster.name +
        " | reason=SDC VIB detected on host"
    );
    return "POWERFLEX";
}

// -------------------------------------------------------------------
// Step 3: Check whether vSAN is enabled. The path is unverified
// (Section 3h.2). Wrap in try/catch and treat exceptions as "not
// vSAN" since the OTHER classification is also out-of-scope.
// -------------------------------------------------------------------

var vsanEnabled = false;
try {
    var configEx = cluster.configurationEx;
    if (configEx != null && configEx.vsanConfigInfo != null) {
        if (configEx.vsanConfigInfo.enabled === true) {
            vsanEnabled = true;
        }
    }
} catch (e) {
    auditLogger.auditLog(
        LOG_PREFIX, "DISCOVER", "WARN",
        "vSAN config probe threw, treating as not-vSAN | " +
        "cluster=" + cluster.name + " | error=" + e.message
    );
}

if (vsanEnabled) {
    auditLogger.auditLog(
        LOG_PREFIX, "DISCOVER", "OK",
        "Cluster classified VSAN-ONLY | cluster=" + cluster.name +
        " | reason=vSAN enabled but no VxRail signal"
    );
    return "VSAN-ONLY";
}

// -------------------------------------------------------------------
// Step 4: Fall-through — classify as OTHER.
// -------------------------------------------------------------------

auditLogger.auditLog(
    LOG_PREFIX, "DISCOVER", "OK",
    "Cluster classified OTHER | cluster=" + cluster.name +
    " | reason=no VxRail/PowerFlex/vSAN signal"
);
return "OTHER";
