/**
 * ST-01  INITIALISE RUN
 * ─────────────────────────────────────────────────────────────────────────────
 * Generates run ID, converts threshold inputs to internal units,
 * initialises the in-memory log array.
 *
 * WORKFLOW INPUT BINDINGS:
 *   maxAgeMinutes, nameMatchString, descIgnoreString, dryRun,
 *   latencyThresholdMs, vsanCongestionThresh, vsanResyncThresholdGB,
 *   maxParallelPerVcenter, governorPollIntervalSec, taskTimeoutSeconds
 *
 * WORKFLOW ATTRIBUTE OUTPUTS:
 *   runId, runLog, vsanResyncThresholdBytes, govPollMs, maxParallel
 */

// ── Logging helper ────────────────────────────────────────────────────────────
var LOG = {
    ok:   function(p,m){ System.log(  "[SNAPSHOT-CLEANUP] ["+p+"] [OK]      "+m); },
    warn: function(p,m){ System.warn( "[SNAPSHOT-CLEANUP] ["+p+"] [WARN]    "+m); },
    fail: function(p,m){ System.error("[SNAPSHOT-CLEANUP] ["+p+"] [FAIL]    "+m); }
};

var wfTokenId = workflow.id;
var wfName = workflow.name;
var marker = "WorkflowName:" + wfName + " - WorkflowRun:" + wfTokenId;

System.log(marker)
System.setLogMarker(marker);   // WorfklowName:"MyWorkflow - WorkflowRun:workflowTask:sadfksdfkj234092345sdakj320


// ── Initialise ────────────────────────────────────────────────────────────────
runId                    = "SCR-" + new Date().toISOString().replace(/[:.]/g,"-").substring(0,19);
runLog                   = "[]";
vsanResyncThresholdBytes = (vsanResyncThresholdGB   || 10) * 1073741824;
govPollMs                = (governorPollIntervalSec || 30) * 1000;
maxParallel              = Math.max(1, maxParallelPerVcenter || 3);

var mins     = maxAgeMinutes || 60;
var ageLabel = mins >= 1440 ? Math.round(mins/1440)+" day(s)" : mins+" minute(s)";

LOG.ok("STARTUP","================================================");
LOG.ok("STARTUP","  Adaptive Snapshot Cleanup  --  Starting up");
LOG.ok("STARTUP","  Run ID      : " + runId);
LOG.ok("STARTUP","  Mode        : " + (dryRun
    ? "DRY RUN  (nothing will be deleted)"
    : "LIVE  (snapshots WILL be deleted)"));
LOG.ok("STARTUP","  Age limit   : Snapshots older than " + ageLabel);
LOG.ok("STARTUP","  Name filter : " + (nameMatchString
    ? "Only delete snapshots named like: '" + nameMatchString + "'"
    : "None  (all snapshot names are eligible)"));
LOG.ok("STARTUP","  Desc ignore : " + (descIgnoreString
    ? "Skip if description contains: '" + descIgnoreString + "'"
    : "None  (no description filter)"));
LOG.ok("STARTUP","  I/O ceiling : " + (latencyThresholdMs||30)+"ms latency  |  vSAN congestion max "+(vsanCongestionThresh||50)+"/255");
LOG.ok("STARTUP","  Parallelism : Up to "+maxParallel+" simultaneous cleanup(s) per vCenter");
LOG.ok("STARTUP","================================================");

if (dryRun) {
    LOG.warn("STARTUP","DRY RUN is ON -- this run will only report what WOULD be deleted. "
            +"To actually delete snapshots, set the 'dryRun' input to false.");
}
