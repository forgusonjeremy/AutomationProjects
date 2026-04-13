/**
 * ST-04  CANDIDATES CHECK (EARLY EXIT GATE)
 * ─────────────────────────────────────────────────────────────────────────────
 * If no eligible snapshots were found across any vCenter, this task writes
 * the final result log entry, releases the lock, and exits cleanly.
 * If snapshots were found, execution continues to ST-05.
 *
 * WORKFLOW ATTRIBUTE INPUTS : allCandidatesJson, runLog, runId, lockEl, dryRun,
 *                             maxAgeMinutes, nameMatchString, descIgnoreString
 * WORKFLOW ATTRIBUTE OUTPUTS: candidateCount
 * THROWS: "CLEAN_EXIT:..." -- Exception Handler treats this as success
 */

var LOG = {
    ok:     function(p,m){ System.log(  "[SNAPSHOT-CLEANUP] ["+p+"] [OK]      "+m); },
    warn:   function(p,m){ System.warn( "[SNAPSHOT-CLEANUP] ["+p+"] [WARN]    "+m); },
    fail:   function(p,m){ System.error("[SNAPSHOT-CLEANUP] ["+p+"] [FAIL]    "+m); },
    result: function(p,m){ System.log(  "[SNAPSHOT-CLEANUP] ["+p+"] [RESULT]  "+m); }
};

var cands      = JSON.parse(allCandidatesJson || "[]");
candidateCount = cands.length;

if (candidateCount === 0) {
    var logArr     = JSON.parse(runLog || "[]");
    var enumErrors = logArr.filter(function(e){ return e.action === "enum_error"; }).length;
    var mins       = maxAgeMinutes || 60;
    var ageLabel   = mins >= 1440 ? Math.round(mins/1440)+" day(s)" : mins+" min";

    LOG.ok("INVENTORY","No eligible snapshots found -- nothing to do. Closing this run cleanly.");

    // ── Final result entry (plain English, easily readable) ──────────────────
    LOG.result("FINALISE","================================================");
    LOG.result("FINALISE","  SNAPSHOT CLEANUP COMPLETE");
    LOG.result("FINALISE","  Run ID      : " + runId);
    LOG.result("FINALISE","  Result       : Nothing to clean up");
    LOG.result("FINALISE","  Reason       : No snapshots older than " + ageLabel
              + (nameMatchString ? " matching name '" + nameMatchString + "'" : "")
              + " were found on any vCenter.");
    if (enumErrors > 0)
        LOG.result("FINALISE","  Warnings     : " + enumErrors + " vCenter(s) could not be scanned -- check [FAIL] entries above.");
    LOG.result("FINALISE","  Mode         : " + (dryRun ? "Dry run" : "Live"));
    LOG.result("FINALISE","================================================");

    // Release lock
    try {
        lockEl.setAttributeWithKey("runLock","");
        LOG.ok("FINALISE","Lock released -- workflow complete.");
    } catch (le) {
        LOG.fail("FINALISE","IMPORTANT: Could not release the lock automatically. "
                +"Please go to SnapshotCleanup/RuntimeState and clear the runLock field manually. "
                +"Error: " + le.message);
    }

    throw new Error("CLEAN_EXIT: No snapshot candidates found. Run completed successfully.");
}

LOG.ok("INVENTORY", candidateCount + " snapshot(s) are eligible for cleanup -- continuing...");
