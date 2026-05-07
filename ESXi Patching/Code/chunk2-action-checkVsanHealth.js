// ===================================================================
// ACTION:    checkVsanHealth
// MODULE:    com.broadcom.pso.vc.esxi.remediation.preflight
// PURPOSE:   Run vSAN cluster health checks and return findings
//            filtered to a caller-supplied subset of health groups.
//            Used at form-time with the curated subset (from CE-01)
//            and at workflow-start-time with the full set when the
//            operator has selected the showAllVsanHealthGroups
//            advanced toggle.
//
// PHASE:     VALIDATE
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-PREFLIGHT]
//
// INPUTS:
//   cluster        (VC:ClusterComputeResource)
//   groupsToCheck  (Array/string) — Group keys to include. Pass the
//                                    curated subset for typical use,
//                                    or the full list when advanced
//                                    inspection is requested. If
//                                    null or empty, defaults to the
//                                    project's curated subset:
//                                      ["clusterStatus","data",
//                                       "network","physicalDisk",
//                                       "limits"]
//
// RETURNS: Properties — {
//            healthy        (boolean) — true iff every check in the
//                                       requested groups is "green".
//            overallHealth  (string)  — best/worst summary across
//                                       the requested groups.
//            findings       (Array/Properties) — one entry per
//                                       NON-green check:
//                                       { group, testName, testId,
//                                         status, message }
//            groupSummaries (Array/Properties) — one entry per
//                                       requested group:
//                                       { group, status, testCount,
//                                         failingCount }
//            reason         (string)
//            error          (string)  — non-empty if probe failed.
//          }
//
// REQUIREMENT TRACE:
//   Implements: FR-15, FR-16, AD-12 (curated subset by default,
//               full set via advanced toggle).
//
// NOTES:
//   - vSAN health groups (the field is internally called "category"
//     in some SDK versions). Common group keys:
//       clusterStatus, data, network, physicalDisk, limits, hcl,
//       iSCSI, performance, encryption, stretchedCluster.
//     The curated subset includes the operationally-most-relevant
//     ones for an operator about to take a host out of service.
//   - The vSAN Management API entry point is
//     VsanVcClusterHealthSystem.queryClusterHealthSummary which
//     returns a structure of test groups, each with test results.
//     Section 3h.2 marks the API access pattern UNVERIFIED.
//   - Status values typically include "green", "yellow", "red",
//     "unknown". This action treats anything other than "green" /
//     "skipped" as a finding.
//   - The action is permissive on probe failure (returns healthy=
//     true with error populated) consistent with other vSAN-related
//     checks. Callers should not block solely on a vSAN health
//     probe failure.
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-PREFLIGHT]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

if (arguments.length < 1) {
    throw new Error("checkVsanHealth requires 1-2 inputs: (cluster, [groupsToCheck]).");
}
var cluster = arguments[0];
var groupsToCheck = arguments.length >= 2 ? arguments[1] : null;

if (cluster == null) {
    throw new Error("checkVsanHealth: 'cluster' must not be null.");
}

// Default to curated subset if no groups specified.
if (groupsToCheck == null || !(groupsToCheck instanceof Array) || groupsToCheck.length === 0) {
    groupsToCheck = ["clusterStatus", "data", "network", "physicalDisk", "limits"];
}

// Build a fast lookup set for membership checks.
var groupSet = {};
for (var gi = 0; gi < groupsToCheck.length; gi++) {
    groupSet[String(groupsToCheck[gi])] = true;
}

var result = new Properties();
result.put("healthy", true);
result.put("overallHealth", "(unknown)");
result.put("findings", []);
result.put("groupSummaries", []);
result.put("reason", "Initial state");
result.put("error", "");

// -------------------------------------------------------------------
// Probe vSAN health summary. Wrapped in try/catch — Section 3h.2
// marks this API path unverified.
// -------------------------------------------------------------------

var summary = null;
try {
    var sdkConn = cluster.sdkConnection;
    if (sdkConn == null) {
        throw new Error("Cluster has no SDK connection");
    }

    // Try several plausible accessors for the vSAN cluster health
    // system. The exact name varies between vSphere/vRO versions.
    var healthSystem = null;
    if (sdkConn.vsanClusterHealthSystem != null) {
        healthSystem = sdkConn.vsanClusterHealthSystem;
    } else if (sdkConn.vsanHealthSystem != null) {
        healthSystem = sdkConn.vsanHealthSystem;
    }

    if (healthSystem != null) {
        // queryClusterHealthSummary signature varies. Some
        // versions take (cluster, includeObjUuids, fields,
        // fetchFromCache, perspective); others take just (cluster).
        // Try the simplest first.
        try {
            summary = healthSystem.queryClusterHealthSummary(cluster);
        } catch (innerErr) {
            try {
                // Try the longer signature with cached=true.
                summary = healthSystem.queryClusterHealthSummary(
                    cluster, null, null, true, "defaultView"
                );
            } catch (innerErr2) {
                throw new Error("queryClusterHealthSummary failed both signatures: " + innerErr2.message);
            }
        }
    }
} catch (e) {
    // Permissive failure path.
    result.put("reason", "vSAN health probe failed; treating cluster as healthy");
    result.put("error", e.message);
    auditLogger.auditLog(
        LOG_PREFIX, "VALIDATE", "WARN",
        "vSAN health probe threw | cluster=" + cluster.name +
        " | error=" + e.message
    );
    return result;
}

if (summary == null) {
    result.put("reason", "vSAN health summary not returned; treating cluster as healthy");
    result.put("error", "queryClusterHealthSummary returned null");
    auditLogger.auditLog(
        LOG_PREFIX, "VALIDATE", "WARN",
        "vSAN health summary null | cluster=" + cluster.name
    );
    return result;
}

// -------------------------------------------------------------------
// Walk the summary structure. The shape (per vSphere docs) is
// roughly:
//   summary.groups[] — array of VsanClusterHealthGroup
//     each with: groupId, groupName, groupHealth (status),
//                groupTests[]
//     each test: testName, testId, testHealth (status), ...
// -------------------------------------------------------------------

var findings = [];
var groupSummaries = [];
var allGreen = true;

var groups = summary.groups;
if (groups == null) groups = [];

for (var g = 0; g < groups.length; g++) {
    var grp = groups[g];
    if (grp == null) continue;

    var groupId = grp.groupId != null ? String(grp.groupId) : "(unknown)";
    if (!groupSet.hasOwnProperty(groupId)) {
        continue; // not in caller's requested groups
    }

    var groupHealth = "(unknown)";
    try {
        if (grp.groupHealth != null) {
            groupHealth = typeof grp.groupHealth === "string"
                ? grp.groupHealth
                : String(grp.groupHealth.value);
        }
    } catch (e) {
        groupHealth = "(unknown)";
    }

    var tests = grp.groupTests;
    if (tests == null) tests = [];

    var failingInGroup = 0;

    for (var ti = 0; ti < tests.length; ti++) {
        var test = tests[ti];
        if (test == null) continue;

        var testHealth = "(unknown)";
        try {
            if (test.testHealth != null) {
                testHealth = typeof test.testHealth === "string"
                    ? test.testHealth
                    : String(test.testHealth.value);
            }
        } catch (e) {
            testHealth = "(unknown)";
        }

        if (testHealth === "green" || testHealth === "skipped") {
            continue; // healthy, ignore
        }

        failingInGroup++;
        allGreen = false;

        findings.push({
            group: groupId,
            testName: test.testName != null ? String(test.testName) : "(unknown)",
            testId: test.testId != null ? String(test.testId) : "(unknown)",
            status: testHealth,
            message: test.testShortDescription != null
                ? String(test.testShortDescription)
                : ""
        });
    }

    groupSummaries.push({
        group: groupId,
        status: groupHealth,
        testCount: tests.length,
        failingCount: failingInGroup
    });
}

result.put("healthy", allGreen);
result.put("overallHealth", allGreen ? "green" : "issues");
result.put("findings", findings);
result.put("groupSummaries", groupSummaries);
result.put("reason", allGreen
    ? "All requested vSAN health groups green"
    : findings.length + " non-green vSAN health finding(s) across "
       + groupSummaries.length + " checked group(s)");

auditLogger.auditLog(
    LOG_PREFIX, "VALIDATE", allGreen ? "OK" : "WARN",
    "vSAN health check | cluster=" + cluster.name + " | " + result.get("reason")
);

return result;
