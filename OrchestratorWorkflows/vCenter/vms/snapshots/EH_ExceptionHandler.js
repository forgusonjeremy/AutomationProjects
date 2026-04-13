/**
 * EXCEPTION HANDLER SCRIPTABLE TASK
 * ─────────────────────────────────────────────────────────────────────────────
 * Attached to the Exception Handler element on the vRO workflow canvas.
 * Connect the error output of ALL scriptable tasks (ST-01 through ST-09)
 * to this handler.
 *
 * CLASSIFICATION:
 *   MUTEX_ABORT  — another run is active; this run did not start; lock not ours
 *   CLEAN_EXIT   — no candidates found; ST-04 already logged and released lock
 *   ERROR        — unexpected exception; we hold the lock; must release and log
 *
 * WORKFLOW ATTRIBUTE INPUTS:
 *   errorCode (string — vRO built-in exception binding)
 *   lockEl, runId, runLog, dryRun,
 *   maxAgeMinutes, nameMatchString, descIgnoreString
 *
 * WORKFLOW ATTRIBUTE OUTPUTS:
 *   workflowOutcome (string), runSummaryJson (string)
 */

var errorMsg     = errorCode || "Unknown error";
var isMutexAbort = (errorMsg.indexOf("ABORT: Another run is active") === 0);
var isCleanExit  = (errorMsg.indexOf("CLEAN_EXIT:") === 0);
var isRealError  = !isMutexAbort && !isCleanExit;

System.log("[EH] Exception handler invoked. Classification: " +
           (isMutexAbort ? "MUTEX_ABORT" : isCleanExit ? "CLEAN_EXIT" : "ERROR"));

if (isMutexAbort) {
    workflowOutcome = "MUTEX_ABORT";
    System.warn("[EH] MUTEX_ABORT — another run holds the lock; this run did not start.");

} else if (isCleanExit) {
    workflowOutcome = "CLEAN_EXIT";
    System.log("[EH] CLEAN_EXIT — ST-04 already handled lock release and result logging.");

} else {
    workflowOutcome = "ERROR";
    System.error("[EH] ERROR — unhandled exception: " + errorMsg);

    // Release mutex — only if the lock is ours
    if (lockEl) {
        try {
            var held = lockEl.getAttributeWithKey("runLock").value || "";
            if (held === runId) {
                lockEl.setAttributeWithKey("runLock", "");
                System.log("[EH] Mutex released by exception handler: " + runId);
            } else if (held !== "") {
                System.warn("[EH] Lock held by '" + held + "' — not ours, not releasing.");
            }
        } catch (le) {
            System.error("[EH] CRITICAL: Could not release mutex lock! " +
                         "Manual clear required. Error: " + le.message);
        }
    } else {
        System.warn("[EH] lockEl is null — error occurred before ST-02 acquired the lock.");
    }

    // Emit result log entry for real errors with partial counts
    var logEntries = JSON.parse(runLog || "[]");
    var counts = { deleted: 0, dry_run: 0, skipped: 0, deferred: 0, error: 0, enum_error: 0 };
    for each (var e in logEntries) {
        if (counts.hasOwnProperty(e.action)) counts[e.action]++;
    }

    System.log(
        "Snapshot Cleanup Result" +
        " | runId="        + (runId || "UNKNOWN") +
        " | outcome=ERROR" +
        " | dryRun="       + (dryRun || false) +
        " | ageThreshold=" + (maxAgeMinutes    || 60)    + "min" +
        " | nameFilter="   + (nameMatchString  || "none") +
        " | descIgnore="   + (descIgnoreString || "none") +
        " | deleted="      + counts.deleted +
        " | dryRun_count=" + counts.dry_run +
        " | skipped="      + counts.skipped +
        " | deferred="     + counts.deferred +
        " | errors="       + (counts.error + 1) +
        " | enumErrors="   + counts.enum_error +
        " | total="        + logEntries.length +
        " | errorMessage=" + errorMsg.replace(/\|/g, "/")
    );
}

runSummaryJson = JSON.stringify({
    runId:        runId || "UNKNOWN",
    completedAt:  new Date().toISOString(),
    outcome:      workflowOutcome,
    errorMessage: isRealError ? errorMsg : null
}, null, 2);

// Re-throw real errors so vRO marks the run as failed
// CLEAN_EXIT and MUTEX_ABORT end cleanly without an error state
if (isRealError) throw new Error(errorMsg);
