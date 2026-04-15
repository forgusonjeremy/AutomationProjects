/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ST-01  INITIALISE RUN
 * ─────────────────────────────────────────────────────────────────────────────
 * First task to execute on every run. Generates a unique run ID, converts
 * human-readable threshold inputs into the internal units used by subsequent
 * tasks, and initialises the empty in-memory log array that accumulates
 * per-snapshot audit entries throughout the run.
 *
 * ── INPUTS (bind from Workflow Inputs tab) ────────────────────────────────────
 *   Name                     vRO Type  Description
 *   ─────────────────────────────────────────────────────────────────────────────────────────────
 *   maxAgeMinutes            number    Snapshots older than this many minutes are candidates.
 *                                      Use 5-60 for testing; 10080 (7 days) for production.
 *   nameMatchString          string    Whitelist filter — only delete snapshots whose name
 *                                      contains this string (case-insensitive). Leave empty
 *                                      to target all snapshot names.
 *   descIgnoreString         string    Skip filter — skip any snapshot whose description
 *                                      contains this string (case-insensitive). Leave empty
 *                                      to apply no description filter.
 *   dryRun                   boolean   When true, no snapshots are deleted. All operations
 *                                      are logged as DRY-RUN. MUST default to true.
 *                                      Operators must explicitly set false for live runs.
 *   latencyThresholdMs       number    VMFS/NFS I/O governor ceiling in milliseconds.
 *                                      The governor holds the next task if projected latency
 *                                      would exceed this value. Default: 30 ms.
 *   vsanCongestionThresh     number    vSAN I/O governor ceiling (0-255 congestion score).
 *                                      Values above 128 indicate serious congestion.
 *                                      Default: 50.
 *   vsanResyncThresholdGB    number    vSAN resync queue depth ceiling in gigabytes.
 *                                      Governor holds if projected queue would exceed this.
 *                                      Default: 10 GB.
 *   maxParallelPerVcenter    number    Maximum simultaneous consolidation tasks allowed per
 *                                      vCenter for powered-on VMs. Powered-off VMs are not
 *                                      subject to this limit. Default: 3.
 *   governorPollIntervalSec  number    How often (seconds) the I/O governor re-evaluates
 *                                      storage metrics when a task is on hold. Default: 30.
 *   taskTimeoutSeconds       number    Maximum seconds to wait for a single vCenter snapshot
 *                                      removal task to complete before treating it as a
 *                                      timeout failure. Default: 1800 (30 minutes).
 *
 * ── OUTPUTS (bind to Workflow Attributes tab) ──────────────────────────────────
 *   Name                     vRO Type  Description
 *   ─────────────────────────────────────────────────────────────────────────────────────────────
 *   runId                    string    Unique identifier for this run, format SCR-YYYY-MM-DDTHH-MM-SS.
 *                                      Used in all log entries and the mutex lock field so every
 *                                      log line can be traced back to a specific execution.
 *   runLog                   string    JSON array (initially "[]") that accumulates one entry per
 *                                      snapshot evaluated. Passed forward through ST-03 to ST-07
 *                                      and finalised in ST-09. Never written to an external file.
 *   vsanResyncThresholdBytes number    vsanResyncThresholdGB multiplied by 1,073,741,824. Stored
 *                                      in bytes so the governor action does not need to convert
 *                                      on every call.
 *   govPollMs                number    governorPollIntervalSec multiplied by 1,000. Stored in
 *                                      milliseconds for direct use in System.sleep() calls.
 *   maxParallel              number    maxParallelPerVcenter validated to a minimum of 1.
 *                                      Prevents a zero or negative value from disabling
 *                                      concurrency control entirely.
 */
// ── Logging helper ────────────────────────────────────────────────────────────
var LOG = {
    ok:   function(p,m){ System.log(  "[SNAPSHOT-CLEANUP] ["+p+"] [OK]      "+m); },
    warn: function(p,m){ System.warn( "[SNAPSHOT-CLEANUP] ["+p+"] [WARN]    "+m); },
    fail: function(p,m){ System.error("[SNAPSHOT-CLEANUP] ["+p+"] [FAIL]    "+m); }
};

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
