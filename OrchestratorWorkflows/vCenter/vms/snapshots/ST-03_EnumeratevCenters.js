/**
 * ST-03  ENUMERATE vCENTERS & COLLECT CANDIDATES
 * ─────────────────────────────────────────────────────────────────────────────
 * Calls getSnapshotCandidates for every registered vCenter SDK connection.
 * Merges all results into a single flat JSON array annotated with vcenterName.
 * Per-vCenter enumeration errors are caught, logged, and non-fatal.
 *
 * WORKFLOW ATTRIBUTE INPUTS:
 *   runId, runLog, maxAgeMinutes, nameMatchString, descIgnoreString
 *
 * WORKFLOW ATTRIBUTE OUTPUTS:
 *   allCandidatesJson (string), runLog (string — updated with any enum_errors)
 */

var MODULE      = "com.company.snapshotcleanup";
var logEntries  = JSON.parse(runLog || "[]");
var allCandidates = [];

var allVcenters = VcPlugin.allSdkConnections;
if (!allVcenters || allVcenters.length === 0) {
    System.warn("[ST-03] No vCenter connections found in vRO inventory.");
    allCandidatesJson = "[]";
    runLog = JSON.stringify(logEntries);
} else {
    System.log("[ST-03] Found " + allVcenters.length + " vCenter connection(s).");

    for each (var vc in allVcenters) {
        var vcName = vc.name || vc.url;
        System.log("[ST-03] Enumerating: " + vcName);
        try {
            var raw        = System.getModule(MODULE).getSnapshotCandidates(
                                 vc, maxAgeMinutes || 60,
                                 nameMatchString  || "",
                                 descIgnoreString || "");
            var candidates = JSON.parse(raw);
            System.log("[ST-03]   -> " + candidates.length + " candidate(s)");
            for each (var c in candidates) c.vcenterName = vcName;
            allCandidates = allCandidates.concat(candidates);
        } catch (e) {
            System.error("[ST-03] Enumeration failed for " + vcName + ": " + e.message);
            logEntries.push({
                timestampMs: new Date().getTime(), runId: runId,
                vCenter: vcName, vmName: "", vmPowerState: "",
                snapshotName: "", snapshotDesc: "", snapshotAgeMinutes: 0,
                action: "enum_error", success: false, skipReason: null,
                datastoreMoRefs: [], durationMs: 0, error: e.message
            });
        }
    }

    allCandidatesJson = JSON.stringify(allCandidates);
    runLog = JSON.stringify(logEntries);
    System.log("[ST-03] Total candidates: " + allCandidates.length);
}
