/**
 * ST-01  INITIALISE RUN
 * ─────────────────────────────────────────────────────────────────────────────
 * Generates the unique run ID, converts threshold inputs to internal units,
 * and initialises the in-memory log array.
 *
 * WORKFLOW INPUT BINDINGS (from Inputs tab):
 *   maxAgeMinutes, nameMatchString, descIgnoreString, dryRun,
 *   latencyThresholdMs, vsanCongestionThresh, vsanResyncThresholdGB,
 *   maxParallelPerVcenter, governorPollIntervalSec, taskTimeoutSeconds
 *
 * WORKFLOW ATTRIBUTE OUTPUTS:
 *   runId                    : string
 *   runLog                   : string  ("[]" — empty JSON array)
 *   vsanResyncThresholdBytes : number
 *   govPollMs                : number
 *   maxParallel              : number
 */

runId                    = "SCR-" + new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
runLog                   = "[]";
vsanResyncThresholdBytes = (vsanResyncThresholdGB    || 10) * 1073741824;
govPollMs                = (governorPollIntervalSec  || 30) * 1000;
maxParallel              = Math.max(1, maxParallelPerVcenter || 3);

System.log("════════════════════════════════════════════════════");
System.log("  Adaptive Snapshot Cleanup — run started");
System.log("  Run ID        : " + runId);
System.log("  Dry run       : " + dryRun);
System.log("  Age threshold : " + (maxAgeMinutes   || 60) + " min");
System.log("  Name filter   : " + (nameMatchString  || "(none)"));
System.log("  Desc ignore   : " + (descIgnoreString || "(none)"));
System.log("  Lat threshold : " + (latencyThresholdMs     || 30)  + " ms");
System.log("  vSAN cong.    : " + (vsanCongestionThresh   || 50));
System.log("  vSAN resync   : " + (vsanResyncThresholdGB  || 10)  + " GB");
System.log("  Max parallel  : " + maxParallel);
System.log("  Gov poll      : " + (governorPollIntervalSec || 30) + " s");
System.log("  Task timeout  : " + (taskTimeoutSeconds      || 1800) + " s");
System.log("════════════════════════════════════════════════════");
