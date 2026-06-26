/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ST-04  CANDIDATES CHECK  (EARLY EXIT GATE)
 * ─────────────────────────────────────────────────────────────────────────────
 * Checks whether any eligible snapshots were found and sets the boolean
 * output `candidatesFound` accordingly. The workflow uses a Decision element
 * after this task to route to ST-05 (true) or directly to ST-09 (false).
 *
 * When no candidates are found, this task logs a clean result summary and
 * sets candidatesFound = false. The Decision element then routes to ST-09
 * which releases the lock and writes the final run record normally.
 * No exception is thrown -- the workflow ends in a success state via the
 * normal completion path.
 *
 * ── INPUTS ───────────────────────────────────────────────────────────────────
 *   Name               vRO Type              Source / Description
 *   ───────────────────────────────────────────────────────────────────────────
 *   allCandidatesJson  string                Attribute: allCandidatesJson
 *   runLog             string                Attribute: runLog
 *   runId              string                Attribute: runId
 *   dryRun             boolean               Workflow Input: dryRun
 *   maxAgeMinutes      number                Workflow Input: maxAgeMinutes
 *   nameMatchString    string                Workflow Input: nameMatchString
 *   descIgnoreString   string                Workflow Input: descIgnoreString
 *
 * ── OUTPUTS ──────────────────────────────────────────────────────────────────
 *   Name             vRO Type  Description
 *   ───────────────────────────────────────────────────────────────────────────
 *   candidateCount   number    Total eligible snapshots found across all vCenters.
 *   candidatesFound  boolean   true  -> Decision routes to ST-05 to process snapshots.
 *                              false -> Decision routes to ST-09 to finalise and release lock.
 *
 * ── WORKFLOW DESIGN NOTE ─────────────────────────────────────────────────────
 *   Add a Decision element after ST-04 bound to `candidatesFound`:
 *     true  branch  -> ST-05 (sort and split lanes)
 *     false branch  -> ST-09 (release mutex and finalise)
 *   ST-09 reads workflowOutcome to build its summary. Set workflowOutcome to
 *   "NOTHING_TO_DO" here so ST-09 produces the correct result message.
 */

var LOG = {
    ok:     function(p,m){ System.log(  "[SNAPSHOT-CLEANUP] ["+p+"] [OK]      "+m); },
    warn:   function(p,m){ System.warn( "[SNAPSHOT-CLEANUP] ["+p+"] [WARN]    "+m); },
    result: function(p,m){ System.log(  "[SNAPSHOT-CLEANUP] ["+p+"] [RESULT]  "+m); }
};

var cands      = JSON.parse(allCandidatesJson || "[]");
candidateCount = cands.length;

if (candidateCount === 0) {
    candidatesFound = false;

    var logArr     = JSON.parse(runLog || "[]");
    var enumErrors = logArr.filter(function(e){ return e.action === "enum_error"; }).length;
    var mins       = maxAgeMinutes || 60;
    var ageLabel   = mins >= 1440
        ? Math.round(mins / 1440) + " day(s)"
        : mins + " min";

    var nameClause = nameMatchString
        ? " matching name '" + nameMatchString + "'"
        : "";

    LOG.ok("INVENTORY",
        "No eligible snapshots found -- nothing to do.");

    LOG.result("FINALISE","================================================");
    LOG.result("FINALISE","  SNAPSHOT CLEANUP COMPLETE");
    LOG.result("FINALISE","  Run ID      : " + runId);
    LOG.result("FINALISE","  Result       : Nothing to clean up");
    LOG.result("FINALISE","  Reason       : No snapshots older than " + ageLabel +
               nameClause + " were found on any vCenter.");
    if (enumErrors > 0)
        LOG.result("FINALISE","  Warnings     : " + enumErrors +
                   " vCenter(s) could not be scanned -- check [FAIL] entries above.");
    LOG.result("FINALISE","  Mode         : " + (dryRun ? "Dry run" : "Live"));
    LOG.result("FINALISE","================================================");

    // Set outcome so ST-09 builds an appropriate final summary
    workflowOutcome = "NOTHING_TO_DO";

} else {
    candidatesFound = true;
    LOG.ok("INVENTORY",
        candidateCount + " snapshot(s) are eligible for cleanup -- continuing...");
}
