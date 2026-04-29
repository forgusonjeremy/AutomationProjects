/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ST-07  PROCESS POWERED-OFF VMs  (FAST LANE)
 * ─────────────────────────────────────────────────────────────────────────────
 * Processes snapshots on powered-off VMs. Because powered-off VMs have no
 * running guest workload there is no stun-lock risk, so no per-VM concurrency
 * limit and no async dispatch are needed -- deletions run sequentially and
 * synchronously in this task. The full adaptive I/O governor still runs before
 * each deletion because consolidation still generates storage I/O on shared
 * datastores.
 *
 * This task inherits governor baseline state from ST-06. If a datastore was
 * already sampled during the powered-on lane, the baseline from that lane is
 * reused here so the governor does not start blind.
 *
 * Snapshot candidates are identified by VM name + snapshot name only. No
 * MoRefs are stored at scan time -- all resolution happens at deletion time
 * inside _deleteSnapshot against the live vCenter inventory.
 *
 * ── EXTERNALLY PROVIDED VALUES ────────────────────────────────────────────────
 * All values below are injected by vRO at runtime from workflow inputs or
 * workflow attributes. None are declared as JavaScript variables in this
 * script -- vRO makes them available automatically in the execution context.
 *
 *   Name                     vRO Type   Source
 *   ──────────────────────────────────────────────────────────────────────────
 *   WORKFLOW INPUTS (set by the operator when running the workflow):
 *
 *   dryRun                   boolean    Workflow Input
 *                                       When true, logs [DRY-RUN] and skips
 *                                       actual vCenter task submission.
 *   latencyThresholdMs       number     Workflow Input
 *                                       VMFS/NFS governor ceiling in ms. Uses
 *                                       worst-host (max) latency across all
 *                                       hosts mounting the datastore.
 *   vsanCongestionThresh     number     Workflow Input
 *                                       vSAN congestion governor ceiling (0-255).
 *   taskTimeoutSeconds       number     Workflow Input
 *                                       Max seconds to wait for each vCenter
 *                                       snapshot removal task to complete.
 *
 *   WORKFLOW ATTRIBUTES (set at design time or by earlier scriptable tasks):
 *
 *   offCandidatesJson        string     Attribute: offCandidatesJson
 *                                       Newest-first ordered list of powered-off
 *                                       VM snapshot candidates from ST-05. Each
 *                                       entry contains vmMoRef, vmName,
 *                                       snapshotName, snapshotCreatedMs, and
 *                                       datastoreMoRefs.
 *   datastoreStateJson       string     Attribute: datastoreStateJson
 *                                       Governor baseline state produced by
 *                                       ST-06. Contains the pre-run metric
 *                                       sample per datastore so this lane does
 *                                       not need to re-establish a baseline.
 *   runId                    string     Attribute: runId
 *                                       Unique identifier for this workflow run.
 *                                       Included in every log entry.
 *   runLog                   string     Attribute: runLog
 *                                       Accumulating JSON array of log entries
 *                                       from ST-06 and this task. Final value
 *                                       is passed to ST-09 for tallying.
 *   vsanResyncThresholdBytes number     Attribute: vsanResyncThresholdBytes
 *                                       vSAN resync queue ceiling in bytes
 *                                       (converted from GB by ST-01).
 *   govPollMs                number     Attribute: govPollMs
 *                                       Milliseconds between governor re-checks
 *                                       when a deletion is held (converted by
 *                                       ST-01).
 *
 * ── OUTPUTS ──────────────────────────────────────────────────────────────────
 *   Name                vRO Type  Description
 *   ──────────────────────────────────────────────────────────────────────────
 *   runLog              string    Updated JSON array containing all log entries
 *                                 from ST-06 and this task combined. Passed to
 *                                 ST-09 for result tallying and summary.
 *   datastoreStateJson  string    Updated governor baseline state including any
 *                                 new samples observed during this lane.
 */

var LOG = {
    ok:     function(p, m) { System.log(   "[SNAPSHOT-CLEANUP] [" + p + "] [OK]      " + m); },
    skip:   function(p, m) { System.log(   "[SNAPSHOT-CLEANUP] [" + p + "] [SKIP]    " + m); },
    done:   function(p, m) { System.log(   "[SNAPSHOT-CLEANUP] [" + p + "] [DONE]    " + m); },
    dryrun: function(p, m) { System.log(   "[SNAPSHOT-CLEANUP] [" + p + "] [DRY-RUN] " + m); },
    hold:   function(p, m) { System.log(   "[SNAPSHOT-CLEANUP] [" + p + "] [HOLD]    " + m); },
    warn:   function(p, m) { System.warn(  "[SNAPSHOT-CLEANUP] [" + p + "] [WARN]    " + m); },
    fail:   function(p, m) { System.error( "[SNAPSHOT-CLEANUP] [" + p + "] [FAIL]    " + m); }
};

var MODULE        = "com.broadcom.pso.vc.vm.snapshots";
var STORAGEMODULE = "com.broadcom.pso.vc.storage";

var offCands  = JSON.parse(offCandidatesJson  || "[]");
var logArr    = JSON.parse(runLog             || "[]");
var dsBaseline = JSON.parse(datastoreStateJson || "{}");

if (offCands.length === 0) {
    LOG.ok("PROCESSING", "No powered-off VM snapshots to process.");
} else {
    LOG.ok("PROCESSING", "Processing " + offCands.length +
           " powered-off VM snapshot(s) (fast lane)...");

    // Build a vCenter connection lookup by name for multi-vCenter support.
    var vcLookup = {};
    var allSdks  = VcPlugin.allSdkConnections;
    for (var si = 0; si < allSdks.length; si++) {
        var sdk = allSdks[si];
        vcLookup[sdk.name] = sdk;
    }

    for (var i = 0; i < offCands.length; i++) {
        var cand   = offCands[i];
        var dsRefs = cand.datastoreMoRefs || [];
        var vcConn = vcLookup[cand.vcenterName];
        var label  = "VM '" + cand.vmName + "'  snapshot '" + cand.snapshotName +
                     "'  (age: " + cand.snapshotAgeMinutes + " min)  [powered OFF]";

        if (!vcConn) {
            LOG.fail("PROCESSING", "Cannot resolve vCenter '" + cand.vcenterName +
                     "' -- skipping:  " + label);
            logArr.push(makeEntry(cand, "skipped", false,
                        "vCenter connection not found", null, 0));
            continue;
        }

        // ── I/O governor ─────────────────────────────────────────────────────
        // Uses the same delta-based governor as ST-06. Baseline is inherited
        // from datastoreStateJson so datastores already active in ST-06 are
        // evaluated against that known-good baseline rather than re-sampled.
        var govOk = checkGovernorDelta(vcConn, dsRefs, cand.vmName);
        if (!govOk) {
            var holdAttempts = 0;
            while (!govOk && holdAttempts < 120) {
                LOG.hold("PROCESSING",
                    "Storage too busy -- waiting " +
                    Math.round(govPollMs / 1000) + "s  " +
                    "(attempt " + (holdAttempts + 1) + " of 120)  --  " + label);
                System.sleep(govPollMs);
                holdAttempts++;
                govOk = checkGovernorDelta(vcConn, dsRefs, cand.vmName);
            }
            if (!govOk) {
                LOG.warn("PROCESSING",
                    "Storage did not settle -- deferring to next run:  " + label);
                logArr.push(makeEntry(cand, "deferred", false,
                            "Storage I/O governor max wait exceeded", null, 0));
                continue;
            }
            LOG.ok("PROCESSING", "Storage settled -- proceeding:  " + label);
        }

        // ── Execute deletion synchronously ────────────────────────────────────
        // Powered-off lane runs synchronously -- no async wrapper workflow
        // needed since there is no stun-lock risk and no concurrency ramp.
        var res = JSON.parse(
            System.getModule(MODULE)._deleteSnapshot(
                vcConn,
                cand.vmMoRef,
                cand.snapshotName,
                cand.snapshotCreatedMs || 0,
                cand.vmName,
                JSON.stringify(dsRefs),
                dryRun,
                taskTimeoutSeconds || 1800));

        if (!dryRun && res.success && !res.skipped) {
            updateBaseline(
                JSON.parse(res.preMetricsJson  || "[]"),
                JSON.parse(res.postMetricsJson || "[]"));
        }

        if (dryRun && !res.skipped) {
            LOG.dryrun("PROCESSING", "Would delete:  " + label);
            logArr.push(makeEntry(cand, "dry_run", true, null, null, res.durationMs));
        } else if (res.skipped) {
            LOG.skip("PROCESSING", "Skipped:  " + label +
                     "  --  Reason: " + res.skipReason);
            logArr.push(makeEntry(cand, "skipped", false,
                        res.skipReason, null, res.durationMs));
        } else if (res.success) {
            LOG.done("PROCESSING", "Deleted:  " + label +
                     "  (took " + Math.round(res.durationMs / 1000) + "s)");
            logArr.push(makeEntry(cand, "deleted", true, null, null, res.durationMs));
        } else {
            LOG.fail("PROCESSING", "Failed to delete:  " + label +
                     "  --  " + res.error);
            logArr.push(makeEntry(cand, "error", false, null, res.error, res.durationMs));
        }
    }

    LOG.ok("PROCESSING", "Powered-off VM fast lane complete.");
}

datastoreStateJson = JSON.stringify(dsBaseline);
runLog             = JSON.stringify(logArr);

// ── Governor: delta-based latency check ──────────────────────────────────────
// Mirrors ST-06's checkGovernorDelta. Uses worst-host (max) latency from the
// aggregate metrics object. Compares current reading against the inherited
// baseline to project whether adding another deletion would push latency over
// threshold.
function checkGovernorDelta(vcConn, dsRefs, vmName) {
    if (!dsRefs || dsRefs.length === 0) return true;

    for (var gi = 0; gi < dsRefs.length; gi++) {
        var r    = dsRefs[gi];
        var curr = null;
        try {
            curr = JSON.parse(
                System.getModule(STORAGEMODULE)
                    ._getDatastoreMetrics(vcConn, r));
        } catch (ge) {
            LOG.warn("PROCESSING",
                "Could not sample metrics for " + r +
                " -- approving to avoid permanent hold: " + ge.message);
            continue;
        }

        var agg     = curr.aggregate || {};
        var baseAgg = (dsBaseline[r] && dsBaseline[r].aggregate)
                          ? dsBaseline[r].aggregate : {};

        // Use max (worst-host) latency as the threshold signal
        var curW = agg.maxWriteLatencyMs !== null && agg.maxWriteLatencyMs !== undefined
                       ? agg.maxWriteLatencyMs : (agg.avgWriteLatencyMs || 0);
        var curR = agg.maxReadLatencyMs  !== null && agg.maxReadLatencyMs  !== undefined
                       ? agg.maxReadLatencyMs  : (agg.avgReadLatencyMs  || 0);
        var curLat = Math.max(curW, curR);

        var baseW = baseAgg.maxWriteLatencyMs !== null && baseAgg.maxWriteLatencyMs !== undefined
                        ? baseAgg.maxWriteLatencyMs : (baseAgg.avgWriteLatencyMs || 0);
        var baseR = baseAgg.maxReadLatencyMs  !== null && baseAgg.maxReadLatencyMs  !== undefined
                        ? baseAgg.maxReadLatencyMs  : (baseAgg.avgReadLatencyMs  || 0);
        var baseLat  = Math.max(baseW, baseR);
        var deltaLat = Math.max(0, curLat - baseLat);
        var threshold = latencyThresholdMs || 30;

        if (curLat > threshold) {
            LOG.hold("PROCESSING",
                "Datastore " + r + " worst-host latency " + curLat.toFixed(1) +
                "ms already exceeds " + threshold + "ms threshold" +
                " (hotHost=" + (agg.hotHost || "unknown") + ")" +
                " -- holding for VM '" + vmName + "'");
            return false;
        }

        if (curLat + deltaLat > threshold) {
            LOG.hold("PROCESSING",
                "Datastore " + r + " worst-host latency " + curLat.toFixed(1) +
                "ms + projected delta " + deltaLat.toFixed(1) +
                "ms would exceed " + threshold + "ms threshold" +
                " -- holding for VM '" + vmName + "'");
            return false;
        }

        // vSAN congestion check
        if (agg.maxVsanCongestion !== null && agg.maxVsanCongestion !== undefined) {
            var curCong   = agg.maxVsanCongestion  || 0;
            var baseCong  = baseAgg.maxVsanCongestion || 0;
            var deltaCong = Math.max(0, curCong - baseCong);
            var congThresh = vsanCongestionThresh || 50;
            if (curCong > congThresh || curCong + deltaCong > congThresh) {
                LOG.hold("PROCESSING",
                    "Datastore " + r + " vSAN congestion " + curCong.toFixed(1) +
                    " exceeds or would exceed " + congThresh + " threshold" +
                    " -- holding for VM '" + vmName + "'");
                return false;
            }
        }
    }
    return true;
}

// ── Update baseline with pre/post metric pairs from completed deletions ────────
function updateBaseline(preArr, postArr) {
    for (var pi = 0; pi < preArr.length; pi++) {
        var p = preArr[pi];
        if (!dsBaseline[p.datastoreMoRef]) dsBaseline[p.datastoreMoRef] = {};
        dsBaseline[p.datastoreMoRef].aggregate = p.aggregate;
    }
}

// ── Build a structured log entry ─────────────────────────────────────────────
function makeEntry(c, action, success, skipReason, error, durationMs) {
    return {
        timestampMs:        new Date().getTime(),
        runId:              runId,
        vCenter:            c.vcenterName      || "",
        vmName:             c.vmName           || "",
        vmPowerState:       c.vmPowerState     || "",
        snapshotName:       c.snapshotName     || "",
        snapshotAgeMinutes: c.snapshotAgeMinutes || 0,
        action:             action,
        success:            success,
        skipReason:         skipReason         || null,
        datastoreMoRefs:    c.datastoreMoRefs  || [],
        durationMs:         durationMs         || 0,
        error:              error              || null
    };
}
