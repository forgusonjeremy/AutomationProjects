/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ST-09  RELEASE MUTEX & FINALISE
 * ─────────────────────────────────────────────────────────────────────────────
 * The final task in the normal execution path. Performs three actions:
 *   1. Releases the mutex lock so future runs are not blocked.
 *   2. Tallies all log entries from runLog into summary counts.
 *   3. Writes the single human-readable "SNAPSHOT CLEANUP COMPLETE" result
 *      block to the vRO workflow log (ingested by Aria Ops for Logs).
 *
 * This task MUST always execute. It is connected to ST-07's success output
 * AND to the Exception Handler's success output so that the lock is released
 * regardless of how the workflow exits.
 *
 * ── INPUTS ───────────────────────────────────────────────────────────────────
 *   Name              vRO Type                Source / Description
 *   ─────────────────────────────────────────────────────────────────────────────────────────────
 *   lockEl            ConfigurationElement    Attribute: lockEl
 *                                             Live reference to SnapshotCleanup/RuntimeState.
 *                                             The task calls setAttributeWithKey("runLock", "")
 *                                             on this object to release the mutex.
 *   runId             string                  Attribute: runId
 *                                             Printed in the result block so the log entry
 *                                             can be matched to a specific vRO execution.
 *   runLog            string                  Attribute: runLog
 *                                             The complete JSON array of all per-snapshot log
 *                                             entries accumulated during ST-03 through ST-07.
 *                                             Parsed here to compute summary counts and extract
 *                                             unique vCenter and datastore names.
 *   dryRun            boolean                 Workflow Input: dryRun
 *                                             Included in the result block so the reader knows
 *                                             whether the run was live or a simulation.
 *   maxAgeMinutes     number                  Workflow Input: maxAgeMinutes
 *                                             Included in the result block to show what age
 *                                             filter was active for this run.
 *   nameMatchString   string                  Workflow Input: nameMatchString
 *                                             Included in the result block for full filter context.
 *   descIgnoreStrings  string[]                Workflow Input: descIgnoreStrings
 *                                             Included in the result block for full filter context.
 *
 * ── OUTPUTS ──────────────────────────────────────────────────────────────────
 *   Name            vRO Type  Description
 *   ─────────────────────────────────────────────────────────────────────────────────────────────
 *   runSummaryJson  string    Structured JSON object containing: runId, completedAt,
 *                             outcome, dryRun flag, lockReleased flag, active filters,
 *                             per-action counts (deleted, dry_run, skipped, deferred,
 *                             errors, enumErrors, total), list of vCenters processed,
 *                             and count of unique datastores evaluated. Bound to the
 *                             workflow output attribute so it is visible in the vRO
 *                             execution details pane and accessible to calling workflows.
 */
var LOG = {
    ok:     function(p,m){ System.log(  "[SNAPSHOT-CLEANUP] ["+p+"] [OK]      "+m); },
    warn:   function(p,m){ System.warn( "[SNAPSHOT-CLEANUP] ["+p+"] [WARN]    "+m); },
    fail:   function(p,m){ System.error("[SNAPSHOT-CLEANUP] ["+p+"] [FAIL]    "+m); },
    result: function(p,m){ System.log(  "[SNAPSHOT-CLEANUP] ["+p+"] [RESULT]  "+m); }
};

// ── Tally results ─────────────────────────────────────────────────────────────
var logArr = JSON.parse(runLog || "[]");
var counts = { deleted:0, dry_run:0, skipped:0, deferred:0, error:0, enum_error:0 };
var vcentersSet = {}, dsSet = {};

for each (var e in logArr) {
    if (counts.hasOwnProperty(e.action)) counts[e.action]++;
    if (e.vCenter) vcentersSet[e.vCenter] = true;
    if (e.datastoreMoRefs) for each (var d in e.datastoreMoRefs) dsSet[d] = true;
}

var vcList  = Object.keys(vcentersSet).join(", ") || "none";
var dsCnt   = Object.keys(dsSet).length;
var total   = logArr.length;
var mins    = maxAgeMinutes || 60;
var ageLabel= mins >= 1440 ? Math.round(mins/1440)+" day(s)" : mins+" min";

var outcome = counts.error > 0    ? "COMPLETED WITH ERRORS"
            : counts.deferred > 0  ? "COMPLETED WITH DEFERRALS"
            : dryRun               ? "DRY RUN COMPLETE"
            : "SUCCESS";

// ── Release mutex ─────────────────────────────────────────────────────────────
var lockReleased = false;
try {
    if (lockEl) {
        lockEl.setAttributeWithKey("runLock","");
        lockReleased = true;
    } else {
        LOG.warn("FINALISE","Lock element reference is missing -- lock may already have been released.");
    }
} catch (le) {
    LOG.fail("FINALISE","IMPORTANT: Could not release the lock automatically! "
            +"Please go to SnapshotCleanup/RuntimeState in the vRO configuration and "
            +"clear the runLock field manually. Error: " + le.message);
}

// ── Single human-readable result summary ─────────────────────────────────────
LOG.result("FINALISE","================================================");
LOG.result("FINALISE","  SNAPSHOT CLEANUP COMPLETE");
LOG.result("FINALISE","  Run ID      : " + runId);
LOG.result("FINALISE","  Result       : " + outcome);
LOG.result("FINALISE","  Mode         : " + (dryRun ? "Dry run (nothing was actually deleted)" : "Live"));
LOG.result("FINALISE","  ── What was done ──────────────────────────");
if (dryRun) {
LOG.result("FINALISE","  Would delete : " + counts.dry_run + " snapshot(s)");
} else {
LOG.result("FINALISE","  Deleted      : " + counts.deleted  + " snapshot(s)");
}
LOG.result("FINALISE","  Skipped      : " + counts.skipped  + " snapshot(s)  (protected or busy)");
LOG.result("FINALISE","  Deferred     : " + counts.deferred + " snapshot(s)  (storage too busy -- will retry next run)");
if (counts.error > 0)
LOG.result("FINALISE","  Errors       : " + counts.error    + " snapshot(s) FAILED -- see [FAIL] entries above");
if (counts.enum_error > 0)
LOG.result("FINALISE","  Scan errors  : " + counts.enum_error + " vCenter(s) could not be scanned -- see [FAIL] entries above");
LOG.result("FINALISE","  ── Scope ──────────────────────────────────");
LOG.result("FINALISE","  Age filter   : Snapshots older than " + ageLabel);
LOG.result("FINALISE","  Name filter  : " + (nameMatchString  ? "'" + nameMatchString  + "'" : "None"));
// Build readable summary of ignore list for the finalise report
var descIgnoreFinal = "None";
if (descIgnoreStrings && descIgnoreStrings.length > 0) {
    var fTerms = [];
    for (var fdi = 0; fdi < descIgnoreStrings.length; fdi++) {
        var ft = (descIgnoreStrings[fdi] || "").trim();
        if (ft !== "") fTerms.push("'" + ft + "'");
    }
    if (fTerms.length > 0) descIgnoreFinal = fTerms.join(", ");
}
LOG.result("FINALISE","  Desc ignore  : " + descIgnoreFinal);
LOG.result("FINALISE","  vCenters     : " + vcList);
LOG.result("FINALISE","  Datastores   : " + dsCnt + " datastore(s) evaluated");
LOG.result("FINALISE","  ── Status ─────────────────────────────────");
LOG.result("FINALISE","  Lock released: " + (lockReleased ? "Yes" : "NO -- MANUAL CLEAR REQUIRED"));
LOG.result("FINALISE","================================================");

if (counts.deferred > 0) {
    LOG.warn("FINALISE", counts.deferred + " snapshot(s) were deferred because storage I/O was too high. "
            +"They will be picked up automatically on the next scheduled run.");
}
if (counts.error > 0) {
    LOG.warn("FINALISE", counts.error + " deletion(s) failed. Search the log above for [FAIL] to see details. "
            +"These will be retried on the next run.");
}
if (!lockReleased) {
    LOG.fail("FINALISE","ACTION REQUIRED: The cleanup lock was NOT released automatically. "
            +"Future scheduled runs will be blocked until you manually clear the runLock "
            +"attribute in SnapshotCleanup/RuntimeState.");
}
if (lockReleased)
    LOG.ok("FINALISE","Lock released -- workflow finished cleanly. Ready for next run.");

// ── Structured output attribute ───────────────────────────────────────────────
runSummaryJson = JSON.stringify({
    runId:        runId,
    completedAt:  new Date().toISOString(),
    outcome:      outcome.replace(/ /g,"_"),
    dryRun:       dryRun,
    lockReleased: lockReleased,
    filters: {
        ageThresholdMinutes: maxAgeMinutes    || 60,
        nameFilter:          nameMatchString  || null,
        descIgnoreFilter:    (descIgnoreStrings && descIgnoreStrings.length > 0)
                                ? descIgnoreStrings.slice() : null
    },
    counts: {
        deleted:    counts.deleted,
        dry_run:    counts.dry_run,
        skipped:    counts.skipped,
        deferred:   counts.deferred,
        errors:     counts.error,
        enumErrors: counts.enum_error,
        total:      total
    },
    vcenters:       Object.keys(vcentersSet),
    datastoreCount: dsCnt
}, null, 2);
