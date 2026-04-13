/**
 * ST-04  CANDIDATES CHECK (EARLY EXIT GATE)
 * ─────────────────────────────────────────────────────────────────────────────
 * When no candidates are found: emits the single "Snapshot Cleanup Result"
 * log entry, releases the mutex, and throws a CLEAN_EXIT sentinel so the
 * Exception Handler ends the workflow cleanly without an error state.
 *
 * When candidates exist: records candidateCount and passes control to ST-05.
 *
 * LOGGING: All audit output goes to the vRO workflow log (Aria Ops for Logs).
 * No external file is written. The "Snapshot Cleanup Result" line is the
 * single structured record for this run.
 *
 * WORKFLOW ATTRIBUTE INPUTS:
 *   allCandidatesJson, runLog, runId, lockEl, dryRun,
 *   maxAgeMinutes, nameMatchString, descIgnoreString
 *
 * WORKFLOW ATTRIBUTE OUTPUTS:
 *   candidateCount (number)
 *
 * THROWS:
 *   "CLEAN_EXIT: No snapshot candidates found." — Exception Handler ends cleanly
 */

var candidates = JSON.parse(allCandidatesJson || "[]");
candidateCount = candidates.length;
System.log("[ST-04] Candidate count: " + candidateCount);

if (candidateCount === 0) {
    System.log("[ST-04] No candidates — performing clean exit.");

    var logEntries = JSON.parse(runLog || "[]");
    var enumErrors = logEntries.filter(function(e) { return e.action === "enum_error"; }).length;

    System.log(
        "Snapshot Cleanup Result" +
        " | runId="        + runId +
        " | outcome=NO_CANDIDATES" +
        " | dryRun="       + dryRun +
        " | ageThreshold=" + (maxAgeMinutes    || 60)    + "min" +
        " | nameFilter="   + (nameMatchString  || "none") +
        " | descIgnore="   + (descIgnoreString || "none") +
        " | deleted=0 | dryRun_count=0 | skipped=0 | deferred=0" +
        " | errors=0 | enumErrors=" + enumErrors + " | total=0"
    );

    try {
        lockEl.setAttributeWithKey("runLock", "");
        System.log("[ST-04] Mutex released (clean exit): " + runId);
    } catch (le) {
        System.error("[ST-04] CRITICAL: Could not release lock! Manual clear required. " + le.message);
    }

    throw new Error("CLEAN_EXIT: No snapshot candidates found across any vCenter. " +
                    "Run completed successfully with no actions taken.");
}

System.log("[ST-04] " + candidateCount + " candidate(s) — continuing to ST-05.");
