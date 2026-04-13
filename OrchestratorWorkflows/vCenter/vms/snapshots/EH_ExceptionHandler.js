/**
 * ─────────────────────────────────────────────────────────────────────────────
 * EXCEPTION HANDLER SCRIPTABLE TASK
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles all errors thrown by ST-01 through ST-09.
 * Connect the error output of every scriptable task to this element.
 *
 * CLASSIFICATION:
 *   MUTEX_ABORT  Lock held by another run. This run never started. Lock is not ours.
 *   CLEAN_EXIT   No snapshots found. ST-04 already logged and released the lock.
 *   ERROR        Unexpected failure. We may hold the lock. Must release and log.
 *
 * ── INPUTS ───────────────────────────────────────────────────────────────────
 *   Name              vRO Type                  Source
 *   ──────────────────────────────────────────────────────────────────────────
 *   errorCode         string                    vRO built-in exception variable
 *                                               (bind via Exception element input tab)
 *   lockEl            ConfigurationElement      Attribute: lockEl
 *                                               (may be null if error before ST-02)
 *   runId             string                    Attribute: runId
 *                                               (may be empty if error before ST-01)
 *   runLog            string                    Attribute: runLog
 *   dryRun            boolean                   Workflow Input: dryRun
 *   maxAgeMinutes     number                    Workflow Input: maxAgeMinutes
 *   nameMatchString   string                    Workflow Input: nameMatchString
 *   descIgnoreString  string                    Workflow Input: descIgnoreString
 *
 * ── OUTPUTS ──────────────────────────────────────────────────────────────────
 *   Name              vRO Type   Description
 *   ──────────────────────────────────────────────────────────────────────────
 *   workflowOutcome   string     MUTEX_ABORT | CLEAN_EXIT | ERROR
 *   runSummaryJson    string     JSON object -- minimal run summary for this exit path
 *
 * ── RE-THROW BEHAVIOUR ───────────────────────────────────────────────────────
 *   CLEAN_EXIT and MUTEX_ABORT : workflow ends in SUCCESS state (no re-throw)
 *   ERROR                      : re-throws so vRO marks the run as FAILED
 */
var LOG = {
    ok:     function(p,m){ System.log(  "[SNAPSHOT-CLEANUP] ["+p+"] [OK]      "+m); },
    warn:   function(p,m){ System.warn( "[SNAPSHOT-CLEANUP] ["+p+"] [WARN]    "+m); },
    fail:   function(p,m){ System.error("[SNAPSHOT-CLEANUP] ["+p+"] [FAIL]    "+m); },
    result: function(p,m){ System.log(  "[SNAPSHOT-CLEANUP] ["+p+"] [RESULT]  "+m); }
};

var errorMsg     = errorCode || "Unknown error";
var isMutexAbort = errorMsg.indexOf("ABORT: Another run is active") === 0;
var isCleanExit  = errorMsg.indexOf("CLEAN_EXIT:") === 0;
var isRealError  = !isMutexAbort && !isCleanExit;

if (isMutexAbort) {
    workflowOutcome = "MUTEX_ABORT";
    LOG.warn("ERROR","This run was blocked because another cleanup run is already in progress. "
            +"No action was taken. If you are certain no other run is active, check "
            +"SnapshotCleanup/RuntimeState and clear the runLock attribute if needed.");

} else if (isCleanExit) {
    workflowOutcome = "CLEAN_EXIT";
    // ST-04 already wrote the result log and released the lock -- nothing to do here
    LOG.ok("FINALISE","Clean exit -- no eligible snapshots were found. No action taken.");

} else {
    workflowOutcome = "ERROR";
    LOG.fail("ERROR","An unexpected error stopped the workflow: " + errorMsg);

    // Release mutex if we hold it
    if (lockEl) {
        try {
            var held = lockEl.getAttributeWithKey("runLock").value || "";
            if (held === runId) {
                lockEl.setAttributeWithKey("runLock","");
                LOG.ok("ERROR","Lock released by error handler -- future runs can proceed.");
            } else if (held !== "") {
                LOG.warn("ERROR","Lock is held by a different run ID ('" + held + "') -- not releasing.");
            }
        } catch (le) {
            LOG.fail("ERROR","ACTION REQUIRED: Could not release the lock. "
                    +"Go to SnapshotCleanup/RuntimeState and clear runLock manually. "
                    +"Error: " + le.message);
        }
    } else {
        LOG.warn("ERROR","The lock was never acquired (error occurred at startup). No lock to release.");
    }

    // Tally partial results and write result entry
    var logArr = JSON.parse(runLog || "[]");
    var counts = { deleted:0, dry_run:0, skipped:0, deferred:0, error:0, enum_error:0 };
    for each (var e in logArr) { if (counts.hasOwnProperty(e.action)) counts[e.action]++; }

    LOG.result("ERROR","================================================");
    LOG.result("ERROR","  SNAPSHOT CLEANUP -- STOPPED DUE TO ERROR");
    LOG.result("ERROR","  Run ID      : " + (runId || "Not yet assigned"));
    LOG.result("ERROR","  Error        : " + errorMsg.replace(/\|/g,"/"));
    LOG.result("ERROR","  ── Partial results before error ───────────");
    LOG.result("ERROR","  Deleted      : " + counts.deleted  + " snapshot(s)");
    LOG.result("ERROR","  Dry-run      : " + counts.dry_run  + " snapshot(s)");
    LOG.result("ERROR","  Skipped      : " + counts.skipped  + " snapshot(s)");
    LOG.result("ERROR","  Deferred     : " + counts.deferred + " snapshot(s)");
    LOG.result("ERROR","  Errors       : " + (counts.error + 1) + " (including this one)");
    LOG.result("ERROR","  ── What to do ─────────────────────────────");
    LOG.result("ERROR","  1. Check the [FAIL] log entries above for detail");
    LOG.result("ERROR","  2. Confirm the lock is cleared (SnapshotCleanup/RuntimeState > runLock)");
    LOG.result("ERROR","  3. Fix the issue and re-run when ready");
    LOG.result("ERROR","================================================");
}

runSummaryJson = JSON.stringify({
    runId:        runId || "UNKNOWN",
    completedAt:  new Date().toISOString(),
    outcome:      workflowOutcome,
    errorMessage: isRealError ? errorMsg : null
}, null, 2);

// Re-throw real errors so vRO marks the run as failed in the Runs tab
if (isRealError) throw new Error(errorMsg);
