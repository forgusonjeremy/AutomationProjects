// ===================================================================
// ACTION:    checkDepotVersionCompatibility
// MODULE:    com.broadcom.pso.vc.esxi.remediation.preflight
// PURPOSE:   Compare the major version of the depot ZIP filename
//            (e.g. "VMware-ESXi-8.0U3-24585300-depot.zip" → "8.0")
//            against the major version of every host in the cluster
//            (host.config.product.version). Flags clusters where
//            the depot does not match host versions, which would
//            either silently fail the patch (mismatched major) or
//            cross a major version boundary (out of scope per
//            EX-03 / C-14).
//
// PHASE:     VALIDATE
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-PREFLIGHT]
//
// INPUTS:
//   cluster     (VC:ClusterComputeResource)
//   depotName   (string) — The CL item filename or item name; the
//                          action parses out the version. Acceptable
//                          formats:
//                            VMware-ESXi-<version>-<build>-depot.zip
//                          where <version> is something like
//                            "8.0U3" (VMware update style)
//                          or
//                            "8.0.3" (point release style)
//
// RETURNS: Properties — {
//            compatible       (boolean)
//            depotMajor       (string) — e.g. "8"
//            depotVersion     (string) — full extracted version
//                                         (e.g. "8.0U3")
//            depotBuild       (string) — extracted build number
//            hostsByVersion   (Properties) — version-string → count
//            mismatchedHosts  (Array/Properties) — entries
//                              { name, moRef, version, build }
//            reason           (string)
//          }
//
// REQUIREMENT TRACE:
//   Implements: FR-15 (depot version compatibility check), FR-18
//               (warning silenceable for non-blocking mismatches).
//
// NOTES:
//   - Major version is the FIRST dot-separated token.
//   - Mismatched-major depots produce a hard mismatch (compatible
//     = false). Within-major version differences (e.g. depot 8.0U3
//     applied to a host on 8.0U2) are EXPECTED — that's exactly
//     what patching does — and are NOT flagged as mismatches.
//     The action's purpose is to catch the foot-gun where someone
//     accidentally selects a 7.x depot for an 8.x cluster.
//   - The action is parser-tolerant. If the depot filename does
//     not match the expected pattern, it returns compatible=true
//     with depotMajor="(unknown)" and a reason indicating parser
//     failure. We err on the side of permissiveness because the
//     workflow's PATCH_LIST phase (FR-19 step 6) does authoritative
//     validation by inspecting the depot's metadata — better to
//     pass a parser-tolerable mismatch through to that step than
//     to refuse a perfectly-good cluster because of a non-standard
//     filename.
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-PREFLIGHT]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

if (arguments.length < 2) {
    throw new Error(
        "checkDepotVersionCompatibility requires 2 inputs: (cluster, depotName)."
    );
}
var cluster = arguments[0];
var depotName = arguments[1];

if (cluster == null) {
    throw new Error("checkDepotVersionCompatibility: 'cluster' must not be null.");
}
if (typeof depotName !== "string" || depotName.length === 0) {
    throw new Error("checkDepotVersionCompatibility: 'depotName' must be a non-empty string.");
}

var result = new Properties();
result.put("compatible", true);
result.put("depotMajor", "(unknown)");
result.put("depotVersion", "");
result.put("depotBuild", "");
result.put("hostsByVersion", new Properties());
result.put("mismatchedHosts", []);
result.put("reason", "Initial state");

// -------------------------------------------------------------------
// Parse the depot filename. Expected pattern:
//   VMware-ESXi-<version>-<build>-depot.zip
// where <version> is one or more groups separated by dots/letters
// (e.g. "8.0U3", "8.0.3"), and <build> is digits.
//
// The regex below is permissive — it captures the version group as
// "anything between -ESXi- and the next -<digits>-depot".
// -------------------------------------------------------------------

var depotMajor = "(unknown)";
var depotVersion = "";
var depotBuild = "";

var pattern = /VMware-ESXi-([0-9][0-9A-Za-z\.]*)-(\d+)-depot/;
var match = pattern.exec(depotName);

if (match != null) {
    depotVersion = match[1];
    depotBuild = match[2];
    // First dot-separated token of depotVersion is the major.
    depotMajor = depotVersion.split(".")[0];
} else {
    // Parser couldn't find the pattern. Be permissive — return
    // compatible=true with depotMajor unknown so the caller can
    // either continue or warn based on this.
    result.put("reason", "Could not parse depot filename '" + depotName +
                          "' for version comparison; permitting.");
    auditLogger.auditLog(
        LOG_PREFIX, "VALIDATE", "WARN",
        "Depot filename parse failed | cluster=" + cluster.name +
        " | depotName=" + depotName
    );
    return result;
}

result.put("depotMajor", depotMajor);
result.put("depotVersion", depotVersion);
result.put("depotBuild", depotBuild);

// -------------------------------------------------------------------
// Walk hosts and compare major version.
// -------------------------------------------------------------------

var hosts = cluster.host;
if (hosts == null) hosts = [];

var hostsByVersion = new Properties();
var mismatchedHosts = [];

for (var i = 0; i < hosts.length; i++) {
    var host = hosts[i];
    if (host == null) continue;

    var hostName = "(unknown)";
    var hostMoRef = "(unknown)";
    var hostVersion = "(unknown)";
    var hostBuild = "(unknown)";
    var hostMajor = "(unknown)";

    try {
        hostName = String(host.name);
        hostMoRef = String(host.id);
    } catch (e) {
        continue;
    }

    var connState = "(unknown)";
    try {
        if (host.runtime != null && host.runtime.connectionState != null) {
            connState = String(host.runtime.connectionState.value);
        }
    } catch (e) { /* continue */ }

    if (connState !== "connected") {
        // Disconnected hosts can't be compared; flag conservatively.
        mismatchedHosts.push({
            name: hostName,
            moRef: hostMoRef,
            version: "(disconnected)",
            build: "(disconnected)"
        });
        continue;
    }

    try {
        if (host.config != null && host.config.product != null) {
            hostVersion = String(host.config.product.version);
            hostBuild = String(host.config.product.build);
            hostMajor = hostVersion.split(".")[0];
        }
    } catch (e) {
        hostVersion = "(unavailable)";
        hostMajor = "(unavailable)";
    }

    // Tally version distribution.
    var prevCount = hostsByVersion.get(hostVersion);
    hostsByVersion.put(hostVersion, prevCount != null ? Number(prevCount) + 1 : 1);

    if (hostMajor !== depotMajor) {
        mismatchedHosts.push({
            name: hostName,
            moRef: hostMoRef,
            version: hostVersion,
            build: hostBuild
        });
    }
}

result.put("hostsByVersion", hostsByVersion);
result.put("mismatchedHosts", mismatchedHosts);

var compatible = (mismatchedHosts.length === 0);
result.put("compatible", compatible);

var reason;
if (compatible) {
    reason = "Depot major version " + depotMajor + " matches all " + hosts.length + " host(s)";
} else {
    reason = "Depot major version " + depotMajor + " does NOT match " +
             mismatchedHosts.length + " of " + hosts.length + " host(s)";
}
result.put("reason", reason);

auditLogger.auditLog(
    LOG_PREFIX, "VALIDATE", compatible ? "OK" : "WARN",
    "Depot version check | cluster=" + cluster.name +
    " | depot=" + depotVersion + "/" + depotBuild + " | " + reason
);

return result;
