/**
 * ─────────────────────────────────────────────────────────────────────────────
 * EH  EXCEPTION HANDLER
 * ─────────────────────────────────────────────────────────────────────────────
 * Bound to the workflow's error handler and wired to the failure end element.
 *
 * Its job is to make sure a run that fails LATE does not throw away the work it
 * already did. The expensive part of this workflow is the inventory sweep across
 * every vCenter in the estate; if the run dies at the delivery step, the report
 * itself is already built and correct. Rather than lose it, the handler writes
 * the full HTML to the workflow transcript, where an operator can retrieve it
 * from the run's log without re-running the sweep.
 *
 * This workflow holds no lock and mutates nothing in vCenter — it is a
 * read-only reporting process — so there is no state to unwind here. That is
 * the deliberate difference from the Snapshot Cleanup handler, which must
 * release its distributed mutex.
 *
 * ── INPUTS ───────────────────────────────────────────────────────────────────
 *   Name          vRO Type  Source
 *   ─────────────────────────────────────────────────────────────────────────────
 *   errorCode     string    Workflow error handler binding (the caught error)
 *   runId         string    Attribute (may be empty if ST-01 itself failed)
 *   reportHtml    string    Attribute (empty unless ST-04 completed)
 *   collectedJson string    Attribute (empty unless ST-02 completed)
 *   failuresJson  string    Attribute
 *
 * ── OUTPUTS ──────────────────────────────────────────────────────────────────
 *   Name     vRO Type  Description
 *   ─────────────────────────────────────────────────────────────────────────────
 *   outcome  string    Set to ERROR.
 */

var LOG = {
    ok:     function(p,m){ System.log(  "[DATASTORE-REPORT] ["+p+"] [OK]     "+m); },
    warn:   function(p,m){ System.warn( "[DATASTORE-REPORT] ["+p+"] [WARN]   "+m); },
    fail:   function(p,m){ System.error("[DATASTORE-REPORT] ["+p+"] [FAIL]   "+m); },
    result: function(p,m){ System.log(  "[DATASTORE-REPORT] ["+p+"] [RESULT] "+m); }
};

outcome = "ERROR";

var id = (runId && runId.length > 0) ? runId : "(run id not yet assigned)";

LOG.fail("ERROR", "Run " + id + " FAILED — " + errorCode);

// ── How far did we get? ──────────────────────────────────────────────────────
var collectedCount = 0;
try {
    collectedCount = JSON.parse(collectedJson || "[]").length;
} catch (eC) {
    collectedCount = 0;
}

var failureCount = 0;
try {
    failureCount = JSON.parse(failuresJson || "[]").length;
} catch (eF) {
    failureCount = 0;
}

LOG.result("ERROR", "State at failure: " + collectedCount + " datastore(s) collected, " +
                    failureCount + " vCenter(s) already recorded as unreachable, " +
                    "report " + ((reportHtml && reportHtml.length > 0) ? "BUILT" : "NOT BUILT") + ".");

// ── Preserve the report rather than lose the sweep ───────────────────────────
if (reportHtml && reportHtml.length > 0) {
    LOG.warn("ERROR", "The report had already been built when the run failed. It is written " +
                      "below in full so it can be recovered from this transcript without " +
                      "re-scanning every vCenter. Copy the block between the markers into a " +
                      "file with a .html extension to view it.");
    System.log("[DATASTORE-REPORT] [ERROR] [RESULT] ---BEGIN REPORT HTML---");
    System.log(reportHtml);
    System.log("[DATASTORE-REPORT] [ERROR] [RESULT] ---END REPORT HTML---");
} else {
    LOG.warn("ERROR", "The run failed before the report was built — there is nothing to " +
                      "recover. Re-run once the cause above is resolved.");
}

LOG.fail("ERROR", "Run " + id + " ended in state ERROR. No changes were made to any vCenter " +
                  "(this workflow is read-only).");
