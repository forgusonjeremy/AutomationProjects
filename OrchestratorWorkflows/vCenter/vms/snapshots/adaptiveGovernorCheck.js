/**
 * ACTION: adaptiveGovernorCheck
 * vRO Action — the adaptive I/O governor decision engine.
 *
 * Called before starting each new consolidation task.
 * Compares current datastore metrics against the calibrated delta
 * learned from the previous consolidation on those datastores.
 *
 * Inputs:
 *   currentMetricsJson   : string  — JSON array of current metric objects (from getDatastoreMetrics)
 *   baselineMetricsJson  : string  — JSON array of metrics sampled just before the last consolidation
 *                                    on the same datastores (null/empty = first task, skip check)
 *   preConsolidationJson : string  — JSON array of metrics sampled just before the last consolidation started
 *   postConsolidationJson: string  — JSON array of metrics sampled just after last consolidation completed
 *   latencyThresholdMs   : number  — VMFS/NFS: max tolerable total latency in ms (e.g. 30)
 *   vsanCongestionThresh : number  — vSAN: max tolerable congestion value (0-255, e.g. 50)
 *   vsanResyncThresh     : number  — vSAN: max tolerable resync queue depth bytes (e.g. 10737418240 = 10GB)
 *
 * Returns: JSON string {
 *   approved: boolean,
 *   reason:   string,
 *   projectedDeltas: { [datastoreMoRef]: { readLatMs, writeLatMs, vsanCong } }
 * }
 */

var approved = true;
var reason   = "OK";
var projectedDeltas = {};

try {
    var currentMetrics   = JSON.parse(currentMetricsJson   || "[]");
    var preMetrics       = JSON.parse(preConsolidationJson  || "[]");
    var postMetrics      = JSON.parse(postConsolidationJson || "[]");

    // If no prior run data — first task on these datastores — skip check per spec
    if (!preMetrics || preMetrics.length === 0 || !postMetrics || postMetrics.length === 0) {
        return JSON.stringify({ approved: true, reason: "First task — no calibration data yet, proceeding", projectedDeltas: {} });
    }

    // Build lookup maps keyed by datastoreMoRef
    var preLookup  = buildLookup(preMetrics);
    var postLookup = buildLookup(postMetrics);
    var currLookup = buildLookup(currentMetrics);

    for (var dsRef in currLookup) {
        var curr = currLookup[dsRef];
        var pre  = preLookup[dsRef];
        var post = postLookup[dsRef];

        if (!pre || !post) continue; // No calibration for this DS yet — allow

        var dsType = curr.datastoreType;

        if (dsType === "vsan") {
            // vSAN: congestion-based
            var congDelta = (post.vsanCongestion || 0) - (pre.vsanCongestion || 0);
            var congDeltaClamped = Math.max(0, congDelta); // only count positive impact
            var projectedCong = (curr.vsanCongestion || 0) + congDeltaClamped;

            projectedDeltas[dsRef] = { projectedVsanCongestion: Math.round(projectedCong), delta: Math.round(congDeltaClamped) };

            if (projectedCong > vsanCongestionThresh) {
                approved = false;
                reason = "vSAN congestion projection " + Math.round(projectedCong) +
                         " exceeds threshold " + vsanCongestionThresh +
                         " on datastore " + dsRef;
                break;
            }

            // Also check resync queue
            var resyncDelta = Math.max(0, (post.vsanResyncQueueDepth || 0) - (pre.vsanResyncQueueDepth || 0));
            var projectedResync = (curr.vsanResyncQueueDepth || 0) + resyncDelta;
            if (projectedResync > vsanResyncThresh) {
                approved = false;
                reason = "vSAN resync queue projection " + Math.round(projectedResync / 1048576) + " MB" +
                         " exceeds threshold " + Math.round(vsanResyncThresh / 1048576) + " MB" +
                         " on datastore " + dsRef;
                break;
            }

        } else {
            // VMFS / NFS: latency-based
            var readDelta  = Math.max(0, (post.readLatencyMs  || 0) - (pre.readLatencyMs  || 0));
            var writeDelta = Math.max(0, (post.writeLatencyMs || 0) - (pre.writeLatencyMs || 0));

            var projectedRead  = (curr.readLatencyMs  || 0) + readDelta;
            var projectedWrite = (curr.writeLatencyMs || 0) + writeDelta;

            projectedDeltas[dsRef] = {
                projectedReadLatMs:  Math.round(projectedRead  * 10) / 10,
                projectedWriteLatMs: Math.round(projectedWrite * 10) / 10,
                readDelta:  Math.round(readDelta  * 10) / 10,
                writeDelta: Math.round(writeDelta * 10) / 10
            };

            if (projectedRead > latencyThresholdMs || projectedWrite > latencyThresholdMs) {
                approved = false;
                reason = "Projected latency (R:" + Math.round(projectedRead) + "ms W:" +
                         Math.round(projectedWrite) + "ms) exceeds threshold " +
                         latencyThresholdMs + "ms on datastore " + dsRef;
                break;
            }
        }
    }

} catch(e) {
    // On error be conservative — deny
    approved = false;
    reason = "Governor check error: " + e.message + " — denying as precaution";
}

return JSON.stringify({ approved: approved, reason: reason, projectedDeltas: projectedDeltas });

function buildLookup(arr) {
    var map = {};
    for (var i = 0; i < arr.length; i++) {
        map[arr[i].datastoreMoRef] = arr[i];
    }
    return map;
}
