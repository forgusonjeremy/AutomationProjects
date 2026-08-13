/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ST-04 BUILD THE HTML REPORT
 * ─────────────────────────────────────────────────────────────────────────────
 * Calls buildDatastoreReportHtml and stores the result on the workflow.
 *
 * The report is produced whether or not mail is enabled and whether or not any
 * datastore crossed a threshold, so reportHtml is always a complete document.
 * A caller that embeds this workflow, or an operator running it ad hoc from the
 * Orchestrator client, gets the same artefact the mail recipients get.
 *
 * ── INPUTS ───────────────────────────────────────────────────────────────────
 *   Name             vRO Type  Source
 *   ─────────────────────────────────────────────────────────────────────────────
 *   bandedJson       string    Attribute, set by ST-03
 *   failuresJson     string    Attribute, set by ST-02
 *   skippedJson      string    Attribute, set by ST-02
 *   scanSummaryJson  string    Attribute, set by ST-02
 *
 * ── OUTPUTS ──────────────────────────────────────────────────────────────────
 *   Name        vRO Type  Description
 *   ─────────────────────────────────────────────────────────────────────────────
 *   reportHtml  string    Complete HTML document. Also a workflow output.
 */

var LOG = {
    ok:   function(p,m){ System.log(  "[DATASTORE-REPORT] ["+p+"] [OK]     "+m); },
    fail: function(p,m){ System.error("[DATASTORE-REPORT] ["+p+"] [FAIL]   "+m); }
};

var MODULE = "com.broadcom.pso.vc.storage.reporting";

reportHtml = System.getModule(MODULE).buildDatastoreReportHtml(
                 bandedJson,
                 failuresJson,
                 skippedJson,
                 scanSummaryJson);

if (!reportHtml || reportHtml.length === 0) {
    throw "buildDatastoreReportHtml returned an empty document. Nothing would be delivered.";
}

LOG.ok("REPORT", "Report built for run " + runId + " (" + reportHtml.length + " chars).");
