/**
 * ST-09  RELEASE MUTEX & FINALISE
 * ─────────────────────────────────────────────────────────────────────────────
 * Final task in the normal execution path:
 *   1. Computes summary counts from runLog
 *   2. Releases the mutex lock
 *   3. Emits the single structured "Snapshot Cleanup Result" log entry
 *   4. Writes runSummaryJson to the workflow output attribute
 *
 * NOTE: ST-08 (Write Audit Log) has been removed from this workflow.
 *       All audit output is captured in the vRO workflow log, which is
 *       ingested by VMware Aria Operations for Logs. The structured result
 *       entry emitted here is the complete per-run record.
 *
 * LOG ENTRY FORMAT (pipe-delimited for Aria Ops for Logs field extraction):
 *   Snapshot Cleanup Result | runId=... | outcome=... | dryRun=... |
 *   ageThreshold=...min | nameFilter=... | descIgnore=... |
 *   deleted=N | dryRun_count=N | skipped=N | deferred=N |
 *   errors=N | enumErrors=N | total=N |
 *   vcenters=... | datastores=N | lockReleased=true/false
 *
 * WORKFLOW ATTRIBUTE INPUTS:
 *   lockEl, runId, runLog, dryRun,
 *   maxAgeMinutes, nameMatchString, descIgnoreString
 *
 * WORKFLOW ATTRIBUTE OUTPUTS:
 *   runSummaryJson (string)
 */

var logEntries = JSON.parse(runLog || "[]");

// ── Summary counts ────────────────────────────────────────────────────────────
var counts = { deleted: 0, dry_run: 0, skipped: 0, deferred: 0, error: 0, enum_error: 0 };
var vcentersSet   = {};
var datastoresSet = {};

for each (var entry in logEntries) {
    if (counts.hasOwnProperty(entry.action)) counts[entry.action]++;
    if (entry.vCenter) vcentersSet[entry.vCenter] = true;
    if (entry.datastoreMoRefs)
        for each (var ds in entry.datastoreMoRefs) datastoresSet[ds] = true;
}

var vcenterList    = Object.keys(vcentersSet).join(",") || "none";
var datastoreCount = Object.keys(datastoresSet).length;

var outcome = counts.error > 0    ? "COMPLETED_WITH_ERRORS"
            : counts.deferred > 0  ? "COMPLETED_WITH_DEFERRALS"
            : dryRun               ? "DRY_RUN_COMPLETE"
            : "SUCCESS";

// ── Release mutex ─────────────────────────────────────────────────────────────
var lockReleased = false;
try {
    if (lockEl) {
        lockEl.setAttributeWithKey("runLock", "");
        lockReleased = true;
        System.log("[ST-09] Mutex released: " + runId);
    } else {
        System.warn("[ST-09] lockEl is null — lock may already have been released.");
    }
} catch (le) {
    System.error("[ST-09] CRITICAL: Could not release mutex lock! " +
                 "Manual clear required in SnapshotCleanup/RuntimeState. Error: " + le.message);
}

// ── Single structured result log entry ───────────────────────────────────────
System.log(
    "Snapshot Cleanup Result" +
    " | runId="        + runId +
    " | outcome="      + outcome +
    " | dryRun="       + dryRun +
    " | ageThreshold=" + (maxAgeMinutes    || 60)    + "min" +
    " | nameFilter="   + (nameMatchString  || "none") +
    " | descIgnore="   + (descIgnoreString || "none") +
    " | deleted="      + counts.deleted +
    " | dryRun_count=" + counts.dry_run +
    " | skipped="      + counts.skipped +
    " | deferred="     + counts.deferred +
    " | errors="       + counts.error +
    " | enumErrors="   + counts.enum_error +
    " | total="        + logEntries.length +
    " | vcenters="     + vcenterList +
    " | datastores="   + datastoreCount +
    " | lockReleased=" + lockReleased
);

// ── Structured output attribute ───────────────────────────────────────────────
runSummaryJson = JSON.stringify({
    runId:        runId,
    completedAt:  new Date().toISOString(),
    outcome:      outcome,
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
        total:      logEntries.length
    },
    vcenters:       Object.keys(vcentersSet),
    datastoreCount: datastoreCount
}, null, 2);

System.log("[ST-09] Run complete: " + runId + " — " + outcome);
