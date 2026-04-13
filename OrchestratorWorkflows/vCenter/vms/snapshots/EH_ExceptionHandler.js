/**
 * ─────────────────────────────────────────────────────────────────────────────
 * EXCEPTION HANDLER SCRIPTABLE TASK
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles all errors thrown by ST-01 through ST-09. Connect the error output
 * of every scriptable task on the canvas to this Exception Handler element.
 *
 * Classifies each error into one of three categories and responds accordingly:
 *
 *   MUTEX_ABORT  Another run holds the lock. This run never started and took
 *                no action. The lock belongs to the other run — do not release it.
 *                Workflow ends in success state. No result log entry is written
 *                (the run never started, so there is nothing to summarise).
 *
 *   CLEAN_EXIT   No eligible snapshots were found. ST-04 already wrote the result
 *                log entry and released the lock before throwing this sentinel.
 *                Nothing further to do here. Workflow ends in success state.
 *
 *   ERROR        An unexpected exception occurred. This run may hold the lock.
 *                Releases the lock (if held), writes a partial result log entry
 *                showing whatever was completed before the error, and re-throws
 *                so vRO marks the workflow run as FAILED in the Runs tab.
 *
 * ── INPUTS ───────────────────────────────────────────────────────────────────
 *   Name              vRO Type                Source / Description
 *   ─────────────────────────────────────────────────────────────────────────────────────────────
 *   errorCode         string                  vRO built-in exception variable.
 *                                             Bind this via the Exception element's own Input
 *                                             Bindings tab (not the standard binding UI).
 *                                             Contains the message from the thrown Error object.
 *                                             May be null if vRO could not capture the message.
 *   lockEl            ConfigurationElement    Attribute: lockEl
 *                                             Reference to SnapshotCleanup/RuntimeState.
 *                                             May be null if the error occurred before ST-02
 *                                             completed (i.e., before the lock was acquired).
 *                                             The task checks lockEl for null before attempting
 *                                             to release.
 *   runId             string                  Attribute: runId
 *                                             May be empty string if the error occurred in
 *                                             ST-01 before the run ID was generated. The task
 *                                             defaults to "UNKNOWN" in that case.
 *   runLog            string                  Attribute: runLog
 *                                             Whatever log entries were accumulated before the
 *                                             error. May be empty "[]" if the error occurred
 *                                             early. Used to compute partial result counts for
 *                                             the ERROR result block.
 *   dryRun            boolean                 Workflow Input: dryRun
 *                                             Included in the ERROR result block for context.
 *   maxAgeMinutes     number                  Workflow Input: maxAgeMinutes
 *                                             Included in the ERROR result block for context.
 *   nameMatchString   string                  Workflow Input: nameMatchString
 *                                             Included in the ERROR result block for context.
 *   descIgnoreString  string                  Workflow Input: descIgnoreString
 *                                             Included in the ERROR result block for context.
 *
 * ── OUTPUTS ──────────────────────────────────────────────────────────────────
 *   Name              vRO Type  Description
 *   ─────────────────────────────────────────────────────────────────────────────────────────────
 *   workflowOutcome   string    Classification of this exit: MUTEX_ABORT, CLEAN_EXIT, or ERROR.
 *                               Bound to the workflow output attribute so the outcome is visible
 *                               in the vRO execution details pane and accessible to calling
 *                               workflows or vRO scheduled run monitoring.
 *   runSummaryJson    string    Minimal JSON summary for this exit path containing: runId,
 *                               completedAt timestamp, outcome, and errorMessage (null for
 *                               MUTEX_ABORT and CLEAN_EXIT, populated for ERROR). Bound to
 *                               the workflow output attribute.
 *
 * ── RE-THROW BEHAVIOUR ───────────────────────────────────────────────────────
 *   CLEAN_EXIT and MUTEX_ABORT : no re-throw — workflow ends in SUCCESS state.
 *   ERROR                      : re-throws the original error — vRO marks the
 *                                run as FAILED in the Runs tab and sends failure
 *                                notifications if configured.
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
