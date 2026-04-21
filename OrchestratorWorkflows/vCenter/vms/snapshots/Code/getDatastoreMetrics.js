/**
 * ACTION: _getDatastoreMetrics
 * Module : com.broadcom.pso.vc.storage
 *
 * Samples current I/O performance for a single datastore.
 * Detects vSAN vs VMFS/NFS at runtime and applies the appropriate
 * performance counter set.
 *
 * ── INPUTS ───────────────────────────────────────────────────────────────────
 *   Name                  Type              Description
 *   ──────────────────────────────────────────────────────────────────────────
 *   vcenterSdkConnection  VC:SdkConnection  The vCenter connection to query
 *   datastoreMoRef        string            Datastore managed object reference
 *                                           value (e.g. "datastore-97")
 *
 * ── RETURN TYPE ──────────────────────────────────────────────────────────────
 *   string  JSON object with sampled metrics
 *
 * ── RETURN SCHEMA ────────────────────────────────────────────────────────────
 *   {
 *     datastoreMoRef        : string,
 *     datastoreType         : string,   // "vsan" | "vmfs" | "nfs" | "unknown"
 *     readLatencyMs         : number | null,
 *     writeLatencyMs        : number | null,
 *     iopsRead              : number | null,
 *     iopsWrite             : number | null,
 *     vsanCongestion        : number | null,
 *     vsanResyncQueueDepth  : number | null,
 *     sampledAtMs           : number
 *   }
 */

var metrics = {
    datastoreMoRef:       datastoreMoRef,
    datastoreType:        "unknown",
    readLatencyMs:        null,
    writeLatencyMs:       null,
    iopsRead:             null,
    iopsWrite:            null,
    vsanCongestion:       null,
    vsanResyncQueueDepth: null,
    sampledAtMs:          new Date().getTime()
};

try {
    // ── Locate the datastore via the SDK connection's finder ──────────────────
    // VcPlugin.findAllForType scoped to the SDK connection is the correct
    // approach in vRO 8.x Polyglot runtime. findEntityById does not exist.
    var datastores = vcenterSdkConnection.getAllDatastores()
    var ds = null;
    for (var i = 0; i < datastores.length; i++) {
        if (datastores[i].id === datastoreMoRef) {
            ds = datastores[i];
            break;
        }
    }

    if (!ds) {
        System.warn("getDatastoreMetrics: datastore not found: " + datastoreMoRef);
        return JSON.stringify(metrics);
    }

    // ── Detect datastore type ─────────────────────────────────────────────────
    var dsType = "unknown";
    if (ds.summary && ds.summary.type) {
        dsType = ds.summary.type.toLowerCase();
    }
    metrics.datastoreType = dsType;

    // ── Sample performance metrics ────────────────────────────────────────────
    var perfMgr = vcenterSdkConnection.performanceManager;
    var now     = new Date();
    var start   = new Date(now.getTime() - 60000);

    // Build counter key -> counter ID lookup map
    var counterMap = {};
    var allCounters = perfMgr.perfCounter;
    for (var ci = 0; ci < allCounters.length; ci++) {
        var c = allCounters[ci];
        var key = c.groupInfo.key + ":" + c.nameInfo.key + ":" + c.rollupType.value;
        counterMap[key] = c.key;
    }

    if (dsType === "vsan") {
        // vSAN counters
        var congKey   = counterMap["vsanDomClient:congestion:average"];
        var resyncKey = counterMap["vsanResync:bytesToSync:latest"];
        var rLatKey   = counterMap["vsanDomClient:readLatency:average"];
        var wLatKey   = counterMap["vsanDomClient:writeLatency:average"];

        var metricIds = [];
        if (congKey)   metricIds.push(makeMetricId(congKey,   ""));
        if (resyncKey) metricIds.push(makeMetricId(resyncKey, ""));
        if (rLatKey)   metricIds.push(makeMetricId(rLatKey,   ""));
        if (wLatKey)   metricIds.push(makeMetricId(wLatKey,   ""));

        if (metricIds.length > 0) {
            var qs = new VcPerfQuerySpec();
            qs.entity      = ds;
            qs.startTime   = start;
            qs.endTime     = now;
            qs.intervalId  = 20;
            qs.metricId    = metricIds;
            qs.maxSample   = 3;

            var results = perfMgr.queryPerf([qs]);
            if (results && results.length > 0 && results[0].value) {
                for (var ri = 0; ri < results[0].value.length; ri++) {
                    var s   = results[0].value[ri];
                    var avg = arrayAvg(s.value);
                    if (congKey   && s.id.counterId === congKey)   metrics.vsanCongestion       = avg;
                    if (resyncKey && s.id.counterId === resyncKey) metrics.vsanResyncQueueDepth = avg;
                    if (rLatKey   && s.id.counterId === rLatKey)   metrics.readLatencyMs        = avg / 1000;
                    if (wLatKey   && s.id.counterId === wLatKey)   metrics.writeLatencyMs       = avg / 1000;
                }
            }
        }

    } else {
        // VMFS / NFS counters
        var rLatKey2  = counterMap["datastore:totalReadLatency:average"];
        var wLatKey2  = counterMap["datastore:totalWriteLatency:average"];
        var rIopsKey  = counterMap["datastore:numberReadAveraged:average"];
        var wIopsKey  = counterMap["datastore:numberWriteAveraged:average"];

        var metricIds2 = [];
        if (rLatKey2)  metricIds2.push(makeMetricId(rLatKey2,  ""));
        if (wLatKey2)  metricIds2.push(makeMetricId(wLatKey2,  ""));
        if (rIopsKey)  metricIds2.push(makeMetricId(rIopsKey,  ""));
        if (wIopsKey)  metricIds2.push(makeMetricId(wIopsKey,  ""));

        if (metricIds2.length > 0) {
            var qs2 = new VcPerfQuerySpec();
            qs2.entity     = ds;
            qs2.startTime  = start;
            qs2.endTime    = now;
            qs2.intervalId = 20;
            qs2.metricId   = metricIds2;
            qs2.maxSample  = 3;

            var results2 = perfMgr.queryPerf([qs2]);
            if (results2 && results2.length > 0 && results2[0].value) {
                for (var ri2 = 0; ri2 < results2[0].value.length; ri2++) {
                    var s2   = results2[0].value[ri2];
                    var avg2 = arrayAvg(s2.value);
                    if (rLatKey2  && s2.id.counterId === rLatKey2)  metrics.readLatencyMs  = avg2;
                    if (wLatKey2  && s2.id.counterId === wLatKey2)  metrics.writeLatencyMs = avg2;
                    if (rIopsKey  && s2.id.counterId === rIopsKey)  metrics.iopsRead       = avg2;
                    if (wIopsKey  && s2.id.counterId === wIopsKey)  metrics.iopsWrite      = avg2;
                }
            }
        }
    }

} catch (e) {
    System.warn("getDatastoreMetrics error for " + datastoreMoRef + ": " + e.message);
}

return JSON.stringify(metrics);

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeMetricId(counterId, instance) {
    var mid = new VcPerfMetricId();
    mid.counterId = counterId;
    mid.instance  = instance;
    return mid;
}

function arrayAvg(arr) {
    if (!arr || arr.length === 0) return 0;
    var sum = 0;
    for (var i = 0; i < arr.length; i++) sum += arr[i];
    return sum / arr.length;
}
