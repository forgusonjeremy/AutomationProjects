// ===================================================================
// ACTION:    verifyAllHostsOn8x
// MODULE:    com.broadcom.pso.vc.esxi.remediation.preflight
// PURPOSE:   Verify every host in the cluster is running ESXi 8.x.
//            ESXi 7.x and earlier are out of scope per C-14
//            (the AD-08 ephemeral account pattern requires
//            VcHostPosixAccountSpec.shellAccess which is ESXi 8.0+).
//            ESXi 9.x is out of scope per the customer's
//            "VCF 9 will not be managed by VxRail/PowerFlex" stance.
//
// PHASE:     VALIDATE
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-PREFLIGHT]
//
// INPUTS:
//   cluster (VC:ClusterComputeResource)
//
// RETURNS: Properties — {
//            allOn8x      (boolean) — true iff every host is on 8.x
//            hostCount    (number)  — total hosts
//            compliantCount (number) — count on 8.x
//            nonCompliantHosts (Array/Properties) — per-host
//                                  details for any host NOT on 8.x:
//                                  { hostName, hostMoRef, version,
//                                    fullVersion, build }
//          }
//
// REQUIREMENT TRACE:
//   Implements: FR-15 (within-major-version check), FR-17 (block
//               clusters with pre-8.0 hosts), C-14 (ESXi 8.x only).
//
// NOTES:
//   - Reads host.config.product.version (string like "8.0.2") and
//     host.config.product.build (string).
//   - Only the FIRST dot-separated token is checked: "8" → compliant,
//     "7" or "9" → non-compliant. This is conservative — patches
//     applied through this workflow are minor/update-level only,
//     never major (per C-14 / EX-03).
//   - Hosts in disconnected state cannot be queried for version.
//     They are reported as nonCompliant with version="(disconnected)"
//     so they are visible in the validation summary even though we
//     cannot confirm their version.
//   - This action is read-only.
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-PREFLIGHT]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

if (arguments.length < 1) {
    throw new Error("verifyAllHostsOn8x requires 1 input: cluster.");
}
var cluster = arguments[0];

if (cluster == null) {
    throw new Error("verifyAllHostsOn8x: 'cluster' must not be null.");
}

var hosts = cluster.host;
if (hosts == null) {
    hosts = [];
}

var compliantCount = 0;
var nonCompliantHosts = [];

for (var i = 0; i < hosts.length; i++) {
    var host = hosts[i];

    var hostName = "(unknown)";
    var hostMoRef = "(unknown)";
    var version = null;
    var fullVersion = null;
    var build = null;

    // Defensive: a null host slot would only happen on inventory
    // corruption, but skipping is preferable to a NullPointerException.
    if (host == null) {
        continue;
    }

    try {
        hostName = String(host.name);
        hostMoRef = String(host.id);

        // Disconnected hosts will not have a usable host.config.
        // Check connection state before reading config.
        var connState = "(unknown)";
        try {
            connState = String(host.runtime.connectionState.value);
        } catch (e) {
            // Some host objects may not expose runtime — defensive only.
        }

        if (connState !== "connected") {
            nonCompliantHosts.push({
                hostName: hostName,
                hostMoRef: hostMoRef,
                version: "(disconnected)",
                fullVersion: "(disconnected)",
                build: "(disconnected)",
                connectionState: connState
            });
            continue;
        }

        var product = host.config != null ? host.config.product : null;
        if (product == null) {
            nonCompliantHosts.push({
                hostName: hostName,
                hostMoRef: hostMoRef,
                version: "(unavailable)",
                fullVersion: "(unavailable)",
                build: "(unavailable)",
                connectionState: connState
            });
            continue;
        }

        version = String(product.version);
        fullVersion = String(product.fullName);
        build = String(product.build);

    } catch (e) {
        // Could not read host.config.product. Treat as non-compliant
        // and proceed.
        nonCompliantHosts.push({
            hostName: hostName,
            hostMoRef: hostMoRef,
            version: "(error)",
            fullVersion: "(error)",
            build: "(error)",
            error: e.message
        });
        continue;
    }

    // Major version check: split on "." and compare first token.
    var majorToken = version.split(".")[0];
    if (majorToken === "8") {
        compliantCount++;
    } else {
        nonCompliantHosts.push({
            hostName: hostName,
            hostMoRef: hostMoRef,
            version: version,
            fullVersion: fullVersion,
            build: build
        });
    }
}

var allOn8x = (nonCompliantHosts.length === 0);

var result = new Properties();
result.put("allOn8x", allOn8x);
result.put("hostCount", hosts.length);
result.put("compliantCount", compliantCount);
result.put("nonCompliantHosts", nonCompliantHosts);

auditLogger.auditLog(
    LOG_PREFIX, "VALIDATE", allOn8x ? "OK" : "FAIL",
    "ESXi version check | cluster=" + cluster.name +
    " | total=" + hosts.length +
    " | on8x=" + compliantCount +
    " | nonCompliant=" + nonCompliantHosts.length
);

return result;
