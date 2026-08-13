/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ST-06 FINALISE
 * ─────────────────────────────────────────────────────────────────────────────
 * Emits the single-line run summary that operations dashboards key on, and
 * settles the final outcome value that the workflow returns.
 *
 * The outcome is deliberately more granular than success/failure. A run that
 * completed but could not reach one of five vCenters is NOT the same as a clean
 * run, and must not be reported as one — the difference is exactly what a
 * capacity report is for.
 *
 *   COMPLETE             every vCenter scanned, at least one datastore reported
 *   CLEAN_NO_FINDINGS    every vCenter scanned, nothing at or above the floor
 *   COMPLETE_WITH_GAPS   at least one vCenter could not be scanned
 *
 * ── INPUTS ───────────────────────────────────────────────────────────────────
 *   Name           vRO Type  Source
 *   ─────────────────────────────────────────────────────────────────────────────
 *   runId          string    Attribute
 *   outcome        string    Attribute, set by ST-03
 *   criticalCount  number    Attribute, set by ST-03
 *   warningCount   number    Attribute, set by ST-03
 *   advisoryCount  number    Attribute, set by ST-03
 *   failuresJson   string    Attribute, set by ST-02
 *   mailSent       boolean   Attribute, set by ST-05
 *   sendEmail      boolean   Workflow Input
 *
 * ── OUTPUTS ──────────────────────────────────────────────────────────────────
 *   Name     vRO Type  Description
 *   ─────────────────────────────────────────────────────────────────────────────
 *   outcome  string    Final classification, also a workflow output.
 */

var LOG = {
    ok:     function(p,m){ System.log(  "[DATASTORE-REPORT] ["+p+"] [OK]     "+m); },
    warn:   function(p,m){ System.warn( "[DATASTORE-REPORT] ["+p+"] [WARN]   "+m); },
    result: function(p,m){ System.log(  "[DATASTORE-REPORT] ["+p+"] [RESULT] "+m); }
};

var failures = JSON.parse(failuresJson || "[]");

LOG.result("FINALISE", "Run " + runId + " | outcome=" + outcome +
                       " | critical=" + criticalCount +
                       " | warning="  + warningCount +
                       " | advisory=" + advisoryCount +
                       " | vCenterFailures=" + failures.length +
                       " | mailSent=" + (mailSent === true));

if (failures.length > 0) {
    LOG.warn("FINALISE", "The report was produced from an INCOMPLETE inventory. " +
                         "Unreachable vCenter(s): " +
                         (function () {
                             var names = [];
                             for (var i = 0; i < failures.length; i++) names.push(failures[i].vcenterName);
                             return names.join(", ");
                         })() +
                         ". Investigate the vCenter registrations under " +
                         "Administration > vCenter Server before treating these counts as the estate total.");
}

if (sendEmail === true && mailSent !== true) {
    // Defensive: ST-05 throws on a delivery failure, so reaching here with mail
    // enabled and unsent means the send path was bypassed entirely.
    LOG.warn("FINALISE", "Mail was enabled but no delivery was recorded. Check the NOTIFY " +
                         "lines above before relying on this run.");
}

LOG.ok("FINALISE", "Run " + runId + " complete.");
