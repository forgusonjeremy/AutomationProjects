/**
 * WORKFLOW SCRIPTABLE TASK: Main Orchestration Engine
 * "Adaptive Snapshot Cleanup — Multi-vCenter"
 *
 * This script is the body of the primary "Scriptable Task" element
 * in the vRO workflow. All inputs are bound from the workflow input form.
 *
 * WORKFLOW INPUTS (define in vRO workflow input tab):
 *   maxAgeMinutes          : number   (default: 60 for testing; set to e.g. 10080 for 7 days production)
 *   nameMatchString        : string   (optional — whitelist filter on snapshot name)
 *   descIgnoreString       : string   (optional — skip snapshots whose description contains this)
 *   dryRun                 : boolean  (default: true — ALWAYS default to dry-run for safety)
 *   latencyThresholdMs     : number   (default: 30   — VMFS/NFS ms threshold)
 *   vsanCongestionThresh   : number   (default: 50   — vSAN congestion 0-255)
 *   vsanResyncThresholdGB  : number   (default: 10   — vSAN resync queue GB)
 *   maxParallelPerVcenter  : number   (default: 3    — max simultaneous consolidations per vCenter)
 *   governorPollIntervalSec: number   (default: 30   — how often to re-check governor when blocked)
 *   taskTimeoutSeconds     : number   (default: 1800 — 30 min per snapshot task)
 *
 * WORKFLOW ATTRIBUTES (persistent state — bind to workflow attributes tab):
 *   runLockAttribute       : string   — name of config element attribute used as mutex
 *
 * REQUIRED ACTIONS (in module com.company.snapshotcleanup):
 *   getSnapshotCandidates
 *   getDatastoreMetrics
 *   adaptiveGovernorCheck
 *   deleteSnapshot
 *   writeLogFile
 */

// ============================================================
// 0. INITIALISE RUN STATE
// ============================================================

var MODULE = "com.company.snapshotcleanup";
var runId  = "SCR-" + new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
var runLog = []; // collected log entries, written to file at end

System.log("=== Adaptive Snapshot Cleanup run started: " + runId + " dryRun=" + dryRun + " ===");

var vsanResyncThresholdBytes = (vsanResyncThresholdGB || 10) * 1073741824;
var govPollMs   = (governorPollIntervalSec || 30) * 1000;
var maxParallel = maxParallelPerVcenter || 3;

// ============================================================
// 1. MUTEX CHECK — abort if another run is active
// ============================================================

var lockConfigCat = Server.getConfigurationElementCategoryWithPath("SnapshotCleanup");
var lockEl = null;
var lockElements = lockConfigCat.configurationElements;
for each (var el in lockElements) {
    if (el.name === "RuntimeState") { lockEl = el; break; }
}
if (!lockEl) {
    throw new Error("Configuration element 'SnapshotCleanup/RuntimeState' not found. " +
                    "Create it with attribute 'runLock' (string, default empty).");
}

var currentLock = lockEl.getAttributeWithKey("runLock").value || "";
if (currentLock !== "") {
    var msg = "ABORT: Another run is active (lock held by: " + currentLock + "). Aborting new run " + runId;
    System.warn(msg);
    throw new Error(msg);
}

// Acquire lock
lockEl.setAttributeWithKey("runLock", runId);
System.log("Lock acquired: " + runId);

// ============================================================
// 2. ENUMERATE vCENTER ENDPOINTS
// ============================================================

// Get all registered vCenter SDK connections from the vRO inventory
var allVcenters = VcPlugin.allSdkConnections;
if (!allVcenters || allVcenters.length === 0) {
    releaseAndExit("No vCenter connections found in vRO inventory.");
}

System.log("Found " + allVcenters.length + " vCenter connection(s)");

// ============================================================
// 3. COLLECT ALL SNAPSHOT CANDIDATES — all vCenters
// ============================================================

var allCandidates = []; // flat list across all vCenters, annotated with vCenter name

for each (var vc in allVcenters) {
    var vcName = vc.name || vc.url;
    System.log("Enumerating snapshots on: " + vcName);
    try {
        var candidatesJson = System.getModule(MODULE).getSnapshotCandidates(
            vc,
            maxAgeMinutes,
            nameMatchString  || "",
            descIgnoreString || ""
        );
        var candidates = JSON.parse(candidatesJson);
        System.log("  Found " + candidates.length + " candidate snapshot(s) on " + vcName);

        // Annotate each candidate with vCenter reference and name
        for each (var c in candidates) {
            c.vcenterName      = vcName;
            c.vcenterSdkConn  = vc; // store reference for later use
        }
        allCandidates = allCandidates.concat(candidates);
    } catch(e) {
        System.error("Failed to enumerate " + vcName + ": " + e.message);
        logEntry(null, null, "poweredOn", null, null, 0, "enum_error", false,
                 null, [], 0, e.message, vcName);
    }
}

System.log("Total candidates across all vCenters: " + allCandidates.length);

if (allCandidates.length === 0) {
    System.log("No snapshot candidates found. Exiting cleanly.");
    writeAndRelease();
}

// ============================================================
// 4. SEPARATE INTO EXECUTION LANES
//    - Powered-off VMs: fast lane (governor I/O only, no VM concurrency limit)
//    - Powered-on VMs:  throttled lane (per-vCenter concurrency + governor)
// ============================================================

// Sort candidates: process children before parents (leaf snapshots first)
// so we never try to delete a parent while a child exists
allCandidates.sort(function(a, b) {
    // If b is a parent of a, a comes first
    if (a.parentSnapshotMoRef === b.snapshotMoRef) return -1;
    if (b.parentSnapshotMoRef === a.snapshotMoRef) return 1;
    // Otherwise sort by age descending (oldest first within same VM)
    return b.snapshotAgeMinutes - a.snapshotAgeMinutes;
});

var offCandidates = allCandidates.filter(function(c) { return c.vmPowerState === "poweredOff"; });
var onCandidates  = allCandidates.filter(function(c) { return c.vmPowerState !== "poweredOff"; });

System.log("Powered-off lane: " + offCandidates.length + "   Powered-on lane: " + onCandidates.length);

// ============================================================
// 5. GOVERNOR STATE — per datastore calibration data
// ============================================================

// datastoreState[dsRef] = { preMetrics: object, postMetrics: object }
var datastoreState = {};

// ============================================================
// 6. PROCESS POWERED-ON VMs (throttled lane)
//    Per-vCenter concurrency + adaptive governor
// ============================================================

// Group by vCenter
var byVcenter = {};
for each (var c in onCandidates) {
    var vcKey = c.vcenterName;
    if (!byVcenter[vcKey]) byVcenter[vcKey] = [];
    byVcenter[vcKey].push(c);
}

// Process each vCenter's queue — in production you'd run these in parallel
// vRO supports parallel branches; here we implement sequential with shared governor state
// (true vRO parallelism requires a Parallel element in the visual workflow, calling a sub-workflow)
for (var vcKey in byVcenter) {
    var vcQueue = byVcenter[vcKey];
    var vcConn  = vcQueue[0].vcenterSdkConn;
    System.log("Processing powered-on VMs on: " + vcKey + " (" + vcQueue.length + " snapshots)");
    processQueue(vcQueue, vcConn, false, maxParallel);
}

// ============================================================
// 7. PROCESS POWERED-OFF VMs (fast lane)
//    Still subject to I/O governor but no VM concurrency limit
// ============================================================

System.log("Processing powered-off VMs fast lane (" + offCandidates.length + " snapshots)");
processQueue(offCandidates, null, true, 999);

// ============================================================
// 8. WRITE LOG FILE AND RELEASE LOCK
// ============================================================

writeAndRelease();

// ============================================================
// FUNCTIONS
// ============================================================

/**
 * Process a queue of snapshot candidates with governor enforcement.
 * fastLane = true skips per-VM concurrency limit.
 */
function processQueue(queue, defaultVcConn, fastLane, maxConcurrent) {
    var inFlight = 0;

    for (var i = 0; i < queue.length; i++) {
        var candidate = queue[i];
        var vc = candidate.vcenterSdkConn || defaultVcConn;

        // Wait if at concurrency limit (non-fast lane)
        if (!fastLane) {
            while (inFlight >= maxConcurrent) {
                System.sleep(2000);
                // In a real parallel vRO workflow, inFlight would be decremented by callbacks.
                // In this sequential model we decrement after each task. This loop is a no-op
                // in sequential execution but is here for when this is adapted to a parallel branch.
                inFlight = Math.max(0, inFlight - 1);
            }
        }

        // Governor check for all datastores this VM touches
        var dsRefs = candidate.datastoreMoRefs || [];
        var governorApproved = checkGovernor(vc, dsRefs, candidate.vmName);

        if (!governorApproved) {
            // Poll until governor approves
            var pollAttempts = 0;
            var maxPollAttempts = 120; // 60 minutes max wait at 30s interval
            while (!governorApproved && pollAttempts < maxPollAttempts) {
                System.log("Governor HOLD: waiting " + (govPollMs / 1000) + "s before retry for VM=" +
                           candidate.vmName + " (attempt " + (pollAttempts + 1) + "/" + maxPollAttempts + ")");
                System.sleep(govPollMs);
                pollAttempts++;
                governorApproved = checkGovernor(vc, dsRefs, candidate.vmName);
            }
            if (!governorApproved) {
                System.warn("Governor: max wait exceeded for VM=" + candidate.vmName + " snap=" +
                            candidate.snapshotName + " — deferring this run");
                logEntry(vc ? vc.name : "unknown", candidate.vmName, candidate.vmPowerState,
                         candidate.snapshotName, candidate.snapshotDesc, candidate.snapshotAgeMinutes,
                         "deferred", false, "Governor max wait exceeded", dsRefs, 0, null, candidate.vcenterName);
                continue;
            }
        }

        // Execute deletion (or dry-run report)
        inFlight++;
        var resultJson = System.getModule(MODULE).deleteSnapshot(
            vc,
            candidate.vmMoRef,
            candidate.snapshotMoRef,
            candidate.snapshotName,
            candidate.vmName,
            JSON.stringify(dsRefs),
            dryRun,
            taskTimeoutSeconds || 1800
        );
        inFlight = Math.max(0, inFlight - 1);

        var res = JSON.parse(resultJson);

        // Update governor calibration state with pre/post metrics from this task
        if (!dryRun && res.success && !res.skipped) {
            var preArr  = JSON.parse(res.preMetricsJson  || "[]");
            var postArr = JSON.parse(res.postMetricsJson || "[]");
            for each (var pm in preArr) {
                if (!datastoreState[pm.datastoreMoRef]) datastoreState[pm.datastoreMoRef] = {};
                datastoreState[pm.datastoreMoRef].lastPre = pm;
            }
            for each (var pm2 in postArr) {
                if (!datastoreState[pm2.datastoreMoRef]) datastoreState[pm2.datastoreMoRef] = {};
                datastoreState[pm2.datastoreMoRef].lastPost = pm2;
            }
        }

        // Log outcome
        var action = dryRun ? "dry_run" : (res.skipped ? "skipped" : (res.success ? "deleted" : "error"));
        logEntry(candidate.vcenterName, candidate.vmName, candidate.vmPowerState,
                 candidate.snapshotName, candidate.snapshotDesc, candidate.snapshotAgeMinutes,
                 action, res.success || (dryRun && !res.skipped),
                 res.skipReason, dsRefs, res.durationMs, res.error, candidate.vcenterName);
    }
}

/**
 * Check adaptive governor for a set of datastores.
 * Returns true if approved to proceed.
 */
function checkGovernor(vcConn, dsRefs, vmName) {
    if (!dsRefs || dsRefs.length === 0) return true; // No datastores to check

    // Collect current metrics for all datastores
    var currentMetrics = [];
    for each (var dsRef in dsRefs) {
        try {
            var mJson = System.getModule(MODULE).getDatastoreMetrics(vcConn, dsRef);
            currentMetrics.push(JSON.parse(mJson));
        } catch(e) {
            System.warn("Could not sample datastore " + dsRef + ": " + e.message);
        }
    }

    // Build pre/post arrays from calibration state
    var preArr = [];
    var postArr = [];
    for each (var dsRef2 in dsRefs) {
        var state = datastoreState[dsRef2];
        if (state) {
            if (state.lastPre)  preArr.push(state.lastPre);
            if (state.lastPost) postArr.push(state.lastPost);
        }
    }

    var govResult = JSON.parse(System.getModule(MODULE).adaptiveGovernorCheck(
        JSON.stringify(currentMetrics),
        JSON.stringify(preArr),   // baselineMetrics (unused in current impl, passed for completeness)
        JSON.stringify(preArr),   // preConsolidation
        JSON.stringify(postArr),  // postConsolidation
        latencyThresholdMs     || 30,
        vsanCongestionThresh   || 50,
        vsanResyncThresholdBytes
    ));

    if (!govResult.approved) {
        System.log("Governor DENY for VM=" + vmName + ": " + govResult.reason);
    }
    return govResult.approved;
}

/**
 * Append an entry to the run log.
 */
function logEntry(vcenter, vmName, powerState, snapName, snapDesc, ageMin,
                  action, success, skipReason, dsRefs, durationMs, error, vcLabel) {
    var entry = {
        timestampMs:        new Date().getTime(),
        runId:              runId,
        vCenter:            vcLabel || vcenter || "",
        vmName:             vmName  || "",
        vmPowerState:       powerState || "",
        snapshotName:       snapName   || "",
        snapshotDesc:       snapDesc   || "",
        snapshotAgeMinutes: ageMin     || 0,
        action:             action     || "",
        success:            success    || false,
        skipReason:         skipReason || null,
        datastoreMoRefs:    dsRefs     || [],
        durationMs:         durationMs || 0,
        error:              error      || null
    };
    runLog.push(entry);
    // Mirror to vRO workflow log
    var line = "[" + action.toUpperCase() + "] vc=" + entry.vCenter +
               " vm=" + vmName + " snap=" + snapName + " age=" + ageMin + "min";
    if (success)    System.log(line);
    else            System.warn(line + (error ? " err=" + error : "") + (skipReason ? " skip=" + skipReason : ""));
}

/**
 * Write log file and release the mutex lock. Always called on exit.
 */
function writeAndRelease() {
    // Summarise
    var deleted  = runLog.filter(function(e) { return e.action === "deleted"; }).length;
    var dryRuns  = runLog.filter(function(e) { return e.action === "dry_run"; }).length;
    var skipped  = runLog.filter(function(e) { return e.action === "skipped" || e.action === "deferred"; }).length;
    var errors   = runLog.filter(function(e) { return e.action === "error";   }).length;

    System.log("=== Run complete: " + runId +
               " | deleted=" + deleted + " dry_run=" + dryRuns +
               " skipped=" + skipped + " errors=" + errors + " ===");

    // Write log file
    try {
        var writeResult = JSON.parse(System.getModule(MODULE).writeLogFile(
            JSON.stringify(runLog),
            runId,
            dryRun
        ));
        if (writeResult.success) {
            System.log("Log file written: " + writeResult.filePath);
        } else {
            System.error("Log file write failed: " + writeResult.error);
        }
    } catch(e) {
        System.error("writeLogFile threw: " + e.message);
    }

    // Release lock — ALWAYS, even on error
    try {
        lockEl.setAttributeWithKey("runLock", "");
        System.log("Lock released: " + runId);
    } catch(le) {
        System.error("CRITICAL: Could not release lock! Manual clear required. " + le.message);
    }
}

/**
 * Log an error, write output, release lock, then throw.
 */
function releaseAndExit(msg) {
    System.warn(msg);
    writeAndRelease();
    throw new Error(msg);
}
