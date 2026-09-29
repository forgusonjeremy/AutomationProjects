/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ST-03 ENUMERATE vCENTERS & COLLECT CANDIDATES
 * ─────────────────────────────────────────────────────────────────────────────
 * Iterates over every vCenter SDK connection registered in the embedded vRO
 * appliance and calls getSnapshotCandidates for each one. Results are merged
 * into a single flat JSON array. Each candidate is annotated with the name of
 * its source vCenter so downstream tasks can route deletions back to the
 * correct SDK connection.
 *
 * Per-vCenter errors are caught and logged as enum_error entries in runLog.
 * They do not abort the run — remaining vCenters are still processed.
 *
 * ── INPUTS ───────────────────────────────────────────────────────────────────
 *   Name              vRO Type  Source / Description
 *   ─────────────────────────────────────────────────────────────────────────────────────────────
 *   runId             string    Attribute: runId
 *                               Used to annotate any enum_error log entries with the run ID
 *                               so they can be correlated to this specific execution.
 *   runLog            string    Attribute: runLog
 *                               Passed through and updated if any vCenter scan fails.
 *                               enum_error entries are appended here, not thrown as exceptions.
 *   maxAgeMinutes     number    Workflow Input: maxAgeMinutes
 *                               Passed directly to getSnapshotCandidates. Only snapshots
 *                               older than this value (in minutes) are returned as candidates.
 *   nameMatchString   string    Workflow Input: nameMatchString
 *                               Passed to getSnapshotCandidates. When non-empty, only
 *                               snapshots whose name contains this string are returned.
 *   descIgnoreStrings  string[]  Workflow Input: descIgnoreStrings
 *                               Passed to getSnapshotCandidates. Snapshots whose description
 *                               contains this string are excluded from the returned list.
 *
 * ── OUTPUTS ──────────────────────────────────────────────────────────────────
 *   Name               vRO Type  Description
 *   ─────────────────────────────────────────────────────────────────────────────────────────────
 *   allCandidatesJson  string    JSON array of all eligible snapshot objects found across
 *                                every vCenter. Each object carries: vmMoRef, vmName,
 *                                vmPowerState, snapshotMoRef, snapshotName, snapshotDesc,
 *                                snapshotAgeMinutes, datastoreMoRefs[], parentSnapshotMoRef,
 *                                and vcenterName. Empty array "[]" if nothing was found.
 *   runLog             string    Updated JSON array. Unchanged if all scans succeeded.
 *                                Contains enum_error entries for any vCenter that could
 *                                not be reached or scanned.
 */
var LOG = {
    ok:   function(p,m){ System.log(  "[SNAPSHOT-CLEANUP] ["+p+"] [OK]      "+m); },
    skip: function(p,m){ System.log(  "[SNAPSHOT-CLEANUP] ["+p+"] [SKIP]    "+m); },
    warn: function(p,m){ System.warn( "[SNAPSHOT-CLEANUP] ["+p+"] [WARN]    "+m); },
    fail: function(p,m){ System.error("[SNAPSHOT-CLEANUP] ["+p+"] [FAIL]    "+m); }
};

var MODULE    = "com.broadcom.pso.vc.vm.snapshots";
var logArr    = JSON.parse(runLog || "[]");
var allCands  = [];

var allVCs = VcPlugin.allSdkConnections;
if (!allVCs || allVCs.length === 0) {
    LOG.warn("INVENTORY","No vCenter connections found in vRO inventory. "
            +"Register at least one vCenter under Administration > vCenter Server.");
    allCandidatesJson = "[]";
    runLog = JSON.stringify(logArr);
} else {
    LOG.ok("INVENTORY","Scanning " + allVCs.length + " vCenter(s) for eligible snapshots...");

    for each (var vc in allVCs) {
        var vcName = vc.name || vc.url;
        LOG.ok("INVENTORY","  Connecting to: " + vcName);
        try {
            var raw   = System.getModule(MODULE)._getSnapshotCandidatesgetSnapshotCandidates(
                            vc, maxAgeMinutes || 60,
                            nameMatchString  || "",
                            descIgnoreStrings || []);
            var cands = JSON.parse(raw);

            if (cands.length === 0) {
                LOG.ok("INVENTORY","    No eligible snapshots found on " + vcName);
            } else {
                LOG.ok("INVENTORY","    Found " + cands.length + " eligible snapshot(s) on " + vcName);
            }

            for each (var c in cands) c.vcenterName = vcName;
            allCands = allCands.concat(cands);

        } catch (e) {
            LOG.fail("INVENTORY","    Could not scan " + vcName + " -- " + e.message
                    + "  (other vCenters will still be processed)");
            logArr.push({
                timestampMs:new Date().getTime(), runId:runId, vCenter:vcName,
                vmName:"", vmPowerState:"", snapshotName:"", snapshotDesc:"",
                snapshotAgeMinutes:0, action:"enum_error", success:false,
                skipReason:null, datastoreMoRefs:[], durationMs:0, error:e.message
            });
        }
    }

    allCandidatesJson = JSON.stringify(allCands);
    runLog = JSON.stringify(logArr);

    LOG.ok("INVENTORY","Scan complete -- " + allCands.length
          + " eligible snapshot(s) found across all vCenters.");
}
