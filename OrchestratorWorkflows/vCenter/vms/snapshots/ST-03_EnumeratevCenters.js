/**
 * ST-03  ENUMERATE vCENTERS & COLLECT CANDIDATES
 * ─────────────────────────────────────────────────────────────────────────────
 * Connects to every registered vCenter and finds all snapshots that match
 * the age, name, and description filter criteria.
 *
 * WORKFLOW ATTRIBUTE INPUTS : runId, runLog, maxAgeMinutes, nameMatchString, descIgnoreString
 * WORKFLOW ATTRIBUTE OUTPUTS: allCandidatesJson, runLog
 */

var LOG = {
    ok:   function(p,m){ System.log(  "[SNAPSHOT-CLEANUP] ["+p+"] [OK]      "+m); },
    skip: function(p,m){ System.log(  "[SNAPSHOT-CLEANUP] ["+p+"] [SKIP]    "+m); },
    warn: function(p,m){ System.warn( "[SNAPSHOT-CLEANUP] ["+p+"] [WARN]    "+m); },
    fail: function(p,m){ System.error("[SNAPSHOT-CLEANUP] ["+p+"] [FAIL]    "+m); }
};

var MODULE    = "com.company.snapshotcleanup";
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
            var raw   = System.getModule(MODULE).getSnapshotCandidates(
                            vc, maxAgeMinutes || 60,
                            nameMatchString  || "",
                            descIgnoreString || "");
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
