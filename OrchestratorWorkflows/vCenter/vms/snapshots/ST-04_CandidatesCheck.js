/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ST-04  CANDIDATES CHECK  (EARLY EXIT GATE)
 * ─────────────────────────────────────────────────────────────────────────────
 * Checks whether any eligible snapshots were found. If none: writes the
 * structured result log entry, releases the mutex lock, and throws a
 * CLEAN_EXIT sentinel so the Exception Handler ends the workflow in a
 * success state without logging an error. If candidates exist, records
 * the count and passes control to ST-05.
 *
 * This task owns the result log entry and lock release for the no-candidates
 * path so that ST-09 only runs when there is actual work to report.
 *
 * ── INPUTS ───────────────────────────────────────────────────────────────────
 *   Name               vRO Type                Source / Description
 *   ─────────────────────────────────────────────────────────────────────────────────────────────
 *   allCandidatesJson  string                  Attribute: allCandidatesJson
 *                                              The merged candidate list from ST-03.
 *                                              Parsed to determine whether any candidates exist.
 *   runLog             string                  Attribute: runLog
 *                                              Inspected for enum_error count to include in the
 *                                              result summary when exiting cleanly.
 *   runId              string                  Attribute: runId
 *                                              Included in the result log entry and in the
 *                                              lock release log message.
 *   lockEl             ConfigurationElement    Attribute: lockEl
 *                                              Used to clear runLock on clean exit. This task
 *                                              must release the lock before throwing CLEAN_EXIT
 *                                              because the Exception Handler does not release
 *                                              on CLEAN_EXIT (ST-04 already handled it).
 *   dryRun             boolean                 Workflow Input: dryRun
 *                                              Included in the result log entry so the reader
 *                                              knows whether the run was live or a dry run.
 *   maxAgeMinutes      number                  Workflow Input: maxAgeMinutes
 *                                              Included in the result entry to show what age
 *                                              filter was active when no candidates were found.
 *   nameMatchString    string                  Workflow Input: nameMatchString
 *                                              Included in the result entry for context.
 *   descIgnoreString   string                  Workflow Input: descIgnoreString
 *                                              Included in the result entry for context.
 *
 * ── OUTPUTS ──────────────────────────────────────────────────────────────────
 *   Name            vRO Type  Description
 *   ─────────────────────────────────────────────────────────────────────────────────────────────
 *   candidateCount  number    Total number of eligible snapshots found across all vCenters.
 *                             Zero triggers the clean exit path in this task. A positive value
 *                             means the workflow continues to ST-05.
 *
 * ── THROWS ───────────────────────────────────────────────────────────────────
 *   "CLEAN_EXIT:..."    No candidates found. Lock already released by this task.
 *                       Exception Handler receives this, sets outcome = CLEAN_EXIT,
 *                       and ends the workflow in a success state without re-throwing.
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
