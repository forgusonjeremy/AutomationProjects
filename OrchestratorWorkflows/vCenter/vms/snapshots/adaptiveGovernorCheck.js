/**
 * ACTION: adaptiveGovernorCheck
 * Module : com.company.snapshotcleanup
 *
 * Adaptive I/O governor decision engine. Called before starting each new
 * consolidation task. Projects the expected I/O impact of the next task
 * using the observed delta from the previous consolidation on the same
 * datastores. If the projected metric would breach the threshold, denies
 * the task.
 *
 * INPUT PARAMETERS:
 *   currentMetricsJson    : string  — JSON array of current metric objects
 *   preConsolidationJson  : string  — JSON array of metrics sampled before last task
 *   postConsolidationJson : string  — JSON array of metrics sampled after last task
 *   latencyThresholdMs    : number  — VMFS/NFS: max tolerable projected latency (ms)
 *   vsanCongestionThresh  : number  — vSAN: max tolerable projected congestion (0-255)
 *   vsanResyncThresh      : number  — vSAN: max tolerable projected resync depth (bytes)
 *
 * RETURN TYPE: string (JSON object)
 *   { approved: boolean, reason: string, projectedDeltas: object }
 */

var approved = true;
var reason   = "OK";
var projectedDeltas = {};

try {
    var currentMetrics = JSON.parse(currentMetricsJson   || "[]");
    var preMetrics     = JSON.parse(preConsolidationJson  || "[]");
    var postMetrics    = JSON.parse(postConsolidationJson || "[]");

    if (!preMetrics || preMetrics.length === 0 ||
        !postMetrics || postMetrics.length === 0) {
        return JSON.stringify({
            approved: true,
            reason: "First task on these datastores — no calibration data yet, proceeding",
            projectedDeltas: {}
        });
    }

    var preLookup  = buildLookup(preMetrics);
    var postLookup = buildLookup(postMetrics);
    var currLookup = buildLookup(currentMetrics);

    for (var dsRef in currLookup) {
        var curr = currLookup[dsRef];
        var pre  = preLookup[dsRef];
        var post = postLookup[dsRef];
        if (!pre || !post) continue;

        if (curr.datastoreType === "vsan") {
            var congDelta    = Math.max(0, (post.vsanCongestion || 0) - (pre.vsanCongestion || 0));
            var projCong     = (curr.vsanCongestion || 0) + congDelta;
            var resyncDelta  = Math.max(0, (post.vsanResyncQueueDepth || 0) - (pre.vsanResyncQueueDepth || 0));
            var projResync   = (curr.vsanResyncQueueDepth || 0) + resyncDelta;

            projectedDeltas[dsRef] = {
                projectedVsanCongestion:  Math.round(projCong),
                projectedVsanResyncBytes: Math.round(projResync),
                congDelta: Math.round(congDelta),
                resyncDelta: Math.round(resyncDelta)
            };

            if (projCong > vsanCongestionThresh) {
                approved = false;
                reason = "vSAN congestion projection " + Math.round(projCong) +
                         " exceeds threshold " + vsanCongestionThresh +
                         " on datastore " + dsRef;
                break;
            }
            if (projResync > vsanResyncThresh) {
                approved = false;
                reason = "vSAN resync projection " +
                         Math.round(projResync / 1048576) + " MB exceeds threshold " +
                         Math.round(vsanResyncThresh / 1048576) + " MB on datastore " + dsRef;
                break;
            }
        } else {
            var rDelta = Math.max(0, (post.readLatencyMs  || 0) - (pre.readLatencyMs  || 0));
            var wDelta = Math.max(0, (post.writeLatencyMs || 0) - (pre.writeLatencyMs || 0));
            var projR  = (curr.readLatencyMs  || 0) + rDelta;
            var projW  = (curr.writeLatencyMs || 0) + wDelta;

            projectedDeltas[dsRef] = {
                projectedReadLatMs:  Math.round(projR * 10) / 10,
                projectedWriteLatMs: Math.round(projW * 10) / 10,
                readDelta:  Math.round(rDelta * 10) / 10,
                writeDelta: Math.round(wDelta * 10) / 10
            };

            if (projR > latencyThresholdMs || projW > latencyThresholdMs) {
                approved = false;
                reason = "Projected latency (R:" + Math.round(projR) + "ms W:" +
                         Math.round(projW) + "ms) exceeds threshold " +
                         latencyThresholdMs + "ms on datastore " + dsRef;
                break;
            }
        }
    }
} catch (e) {
    approved = false;
    reason = "Governor check error: " + e.message + " — denying as precaution";
}

return JSON.stringify({ approved: approved, reason: reason, projectedDeltas: projectedDeltas });

function buildLookup(arr) {
    var m = {};
    for (var i = 0; i < arr.length; i++) m[arr[i].datastoreMoRef] = arr[i];
    return m;
}