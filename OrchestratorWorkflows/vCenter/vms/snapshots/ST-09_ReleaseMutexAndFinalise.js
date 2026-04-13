/**
 * ST-09  RELEASE MUTEX & FINALISE
 * ─────────────────────────────────────────────────────────────────────────────
 * Final task. Releases the lock, tallies results, and writes the single
 * human-readable result summary to the workflow log.
 *
 * WORKFLOW ATTRIBUTE INPUTS:
 *   lockEl, runId, runLog, dryRun,
 *   maxAgeMinutes, nameMatchString, descIgnoreString
 *
 * WORKFLOW ATTRIBUTE OUTPUTS: runSummaryJson
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
LOG.result("FINALISE","  Desc ignore  : " + (descIgnoreString ? "'" + descIgnoreString + "'" : "None"));
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
        descIgnoreFilter:    descIgnoreString || null
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
