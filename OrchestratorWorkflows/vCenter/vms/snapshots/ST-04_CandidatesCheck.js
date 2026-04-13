/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ST-04  CANDIDATES CHECK  (EARLY EXIT GATE)
 * ─────────────────────────────────────────────────────────────────────────────
 * If no eligible snapshots were found: writes the result log entry,
 * releases the lock, and throws CLEAN_EXIT so the workflow ends cleanly.
 * If snapshots exist: records the count and continues to ST-05.
 *
 * ── INPUTS ───────────────────────────────────────────────────────────────────
 *   Name               vRO Type                  Source
 *   ──────────────────────────────────────────────────────────────────────────
 *   allCandidatesJson  string                    Attribute: allCandidatesJson
 *   runLog             string                    Attribute: runLog
 *   runId              string                    Attribute: runId
 *   lockEl             ConfigurationElement      Attribute: lockEl
 *   dryRun             boolean                   Workflow Input: dryRun
 *   maxAgeMinutes      number                    Workflow Input: maxAgeMinutes
 *   nameMatchString    string                    Workflow Input: nameMatchString
 *   descIgnoreString   string                    Workflow Input: descIgnoreString
 *
 * ── OUTPUTS ──────────────────────────────────────────────────────────────────
 *   Name            vRO Type   Description
 *   ──────────────────────────────────────────────────────────────────────────
 *   candidateCount  number     Total number of eligible snapshots found
 *
 * ── THROWS ───────────────────────────────────────────────────────────────────
 *   "CLEAN_EXIT:..."  Lock already released by this task. EH ends workflow cleanly.
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
