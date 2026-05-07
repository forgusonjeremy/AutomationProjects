// ===================================================================
// ACTION:    verifyPatchedBuild
// MODULE:    com.broadcom.pso.vc.esxi.remediation.host
// PURPOSE:   After reboot, confirm the host's running ESXi build
//            matches what the depot was supposed to install. This
//            catches cases where:
//              * The patch failed silently and the host rebooted
//                with the OLD build.
//              * The host rebooted from a non-active partition
//                (e.g. failed to commit; rolled back).
//              * The wrong depot was applied somehow.
//
//            The action reads the build from the live host's
//            config.product.build, compares to the expected build
//            (from the depot filename), and additionally captures
//            the post-install build for the run summary.
//
// PHASE:     VERIFY_BUILD
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-HOST]
//
// INPUTS:
//   targetHost     (VC:HostSystem)
//   expectedBuild  (string) — Build number extracted from depot
//                              filename (e.g. "24585300"). Pass
//                              null/empty to skip the comparison.
//   beforeBuild    (string) — Build number captured pre-patch.
//                              Used to confirm the build CHANGED
//                              (additional defense — even if
//                              expectedBuild matches, if
//                              currentBuild === beforeBuild we
//                              know nothing actually changed).
//
// RETURNS: Properties — {
//            verified           (boolean)
//            currentBuild       (string)
//            currentVersion     (string)
//            buildChanged       (boolean) — current != before
//            buildMatchesExpected (boolean) — current == expected
//            reason             (string)
//          }
//
// REQUIREMENT TRACE:
//   Implements: FR-19 step 9 (VERIFY_BUILD), defense-in-depth
//               check that the patch took effect.
//
// NOTES:
//   - The action reads via the SDK (host.config.product.*) — NOT
//     SSH. After reboot, vCenter may re-establish the host
//     connection with slight lag; we wait briefly if config.product
//     is null.
//   - When expectedBuild is null/empty, the action returns
//     buildMatchesExpected=true automatically (treating the check
//     as not applicable). The buildChanged check still applies.
//   - Verified = true requires BOTH:
//       buildChanged == true
//       AND (expectedBuild empty OR buildMatchesExpected == true)
//   - If config.product is unreadable after a reasonable wait
//     (60s), the action returns verified=false with reason
//     describing the SDK lag. Caller should treat this as
//     reconnect failure — host is online but vCenter doesn't yet
//     have full inventory. The cluster-level cleanup logic in
//     AD-09 already covers this case.
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-HOST]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

if (arguments.length < 1) {
    throw new Error(
        "verifyPatchedBuild requires 1-3 inputs: " +
        "(targetHost, [expectedBuild], [beforeBuild])."
    );
}
var targetHost    = arguments[0];
var expectedBuild = arguments.length >= 2 ? arguments[1] : "";
var beforeBuild   = arguments.length >= 3 ? arguments[2] : "";

if (targetHost == null) {
    throw new Error("verifyPatchedBuild: 'targetHost' must not be null.");
}
if (typeof expectedBuild !== "string") expectedBuild = String(expectedBuild != null ? expectedBuild : "");
if (typeof beforeBuild !== "string") beforeBuild = String(beforeBuild != null ? beforeBuild : "");

var hostFqdn = String(targetHost.name);

var result = new Properties();
result.put("verified", false);
result.put("currentBuild", "");
result.put("currentVersion", "");
result.put("buildChanged", false);
result.put("buildMatchesExpected", false);
result.put("reason", "Initial state");

// -------------------------------------------------------------------
// Wait briefly for host.config.product to populate after reboot.
// -------------------------------------------------------------------

var deadlineMs = (new Date()).getTime() + 60000;
var product = null;

while ((new Date()).getTime() < deadlineMs) {
    try {
        if (targetHost.config != null && targetHost.config.product != null) {
            product = targetHost.config.product;
            break;
        }
    } catch (e) {
        product = null;
    }
    System.sleep(5000);
}

if (product == null) {
    result.put("reason", "host.config.product unavailable after 60s wait");
    auditLogger.auditLog(
        LOG_PREFIX, "VERIFY_BUILD", "FAIL",
        "Could not read product info | host=" + hostFqdn
    );
    return result;
}

var currentVersion = "";
var currentBuild = "";
try {
    currentVersion = String(product.version);
    currentBuild = String(product.build);
} catch (e) {
    result.put("reason", "Could not read product fields: " + e.message);
    return result;
}

result.put("currentVersion", currentVersion);
result.put("currentBuild", currentBuild);

// -------------------------------------------------------------------
// Compute boolean checks.
// -------------------------------------------------------------------

var buildChanged = (beforeBuild.length === 0)
    ? true
    : (currentBuild !== beforeBuild);
result.put("buildChanged", buildChanged);

var buildMatchesExpected = (expectedBuild.length === 0)
    ? true
    : (currentBuild === expectedBuild);
result.put("buildMatchesExpected", buildMatchesExpected);

var verified = buildChanged && buildMatchesExpected;
result.put("verified", verified);

var reason;
if (verified) {
    reason = "Patched | currentBuild=" + currentBuild +
             (beforeBuild.length > 0 ? " (was " + beforeBuild + ")" : "") +
             (expectedBuild.length > 0 ? " | matches expected " + expectedBuild : "");
} else if (!buildChanged) {
    reason = "Build did NOT change | currentBuild=" + currentBuild +
             " | beforeBuild=" + beforeBuild +
             " — the patch did not take effect";
} else {
    reason = "Build changed but does not match expected | " +
             "currentBuild=" + currentBuild +
             " | expectedBuild=" + expectedBuild +
             " — wrong depot may have been applied";
}
result.put("reason", reason);

auditLogger.auditLog(
    LOG_PREFIX, "VERIFY_BUILD", verified ? "DONE" : "FAIL",
    "Build verification | host=" + hostFqdn + " | " + reason
);

return result;
