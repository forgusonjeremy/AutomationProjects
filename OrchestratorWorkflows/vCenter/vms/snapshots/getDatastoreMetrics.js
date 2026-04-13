/**
 * ACTION: getDatastoreMetrics
 * Module : com.company.snapshotcleanup
 *
 * Samples current I/O performance for a single datastore.
 * Detects vSAN vs VMFS/NFS at runtime and applies the appropriate
 * performance counter set.
 *
 * INPUT PARAMETERS:
 *   vcenterSdkConnection : VC:SdkConnection
 *   datastoreMoRef       : string   — datastore managed object reference value
 *
 * RETURN TYPE: string (JSON object)
 *   {
 *     datastoreMoRef, datastoreType,        // "vsan" | "vmfs" | "nfs" | "unknown"
 *     readLatencyMs, writeLatencyMs,        // VMFS/NFS: avg latency in ms
 *     iopsRead, iopsWrite,                  // VMFS/NFS: IOPS
 *     vsanCongestion,                       // vSAN only (0-255), else null
 *     vsanResyncQueueDepth,                 // vSAN only (bytes), else null
 *     sampledAtMs
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
    var ds = VcPlugin.findEntityById("Datastore:" + datastoreMoRef, vcenterSdkConnection);
    if (!ds) {
        System.warn("getDatastoreMetrics: datastore not found: " + datastoreMoRef);
        return JSON.stringify(metrics);
    }

    var dsType = ds.summary && ds.summary.type ? ds.summary.type.toLowerCase() : "unknown";
    metrics.datastoreType = dsType;

    var perfMgr     = vcenterSdkConnection.performanceManager;
    var now         = new Date();
    var start       = new Date(now.getTime() - 60000);
    var counterMap  = buildCounterMap(perfMgr);

    if (dsType === "vsan") {
        var readLatKey  = counterMap["vsanDomClient:readLatency:average"];
        var writeLatKey = counterMap["vsanDomClient:writeLatency:average"];
        var congKey     = counterMap["vsanDomClient:congestion:average"];
        var resyncKey   = counterMap["vsanResync:bytesToSync:latest"];

        var ids = [];
        if (readLatKey)  ids.push(makeMetricId(readLatKey,  ""));
        if (writeLatKey) ids.push(makeMetricId(writeLatKey, ""));
        if (congKey)     ids.push(makeMetricId(congKey,     ""));
        if (resyncKey)   ids.push(makeMetricId(resyncKey,   ""));

        if (ids.length > 0) {
            var qs = new VcPerfQuerySpec();
            qs.entity = ds; qs.startTime = start; qs.endTime = now;
            qs.intervalId = 20; qs.metricId = ids; qs.maxSample = 3;
            var res = perfMgr.queryPerf([qs]);
            if (res && res.length > 0 && res[0].value) {
                for each (var s in res[0].value) {
                    var avg = arrayAvg(s.value);
                    if (readLatKey  && s.id.counterId === readLatKey)  metrics.readLatencyMs  = avg / 1000;
                    if (writeLatKey && s.id.counterId === writeLatKey) metrics.writeLatencyMs = avg / 1000;
                    if (congKey     && s.id.counterId === congKey)     metrics.vsanCongestion = avg;
                    if (resyncKey   && s.id.counterId === resyncKey)   metrics.vsanResyncQueueDepth = avg;
                }
            }
        }
    } else {
        var rLat  = counterMap["datastore:totalReadLatency:average"];
        var wLat  = counterMap["datastore:totalWriteLatency:average"];
        var rIops = counterMap["datastore:numberReadAveraged:average"];
        var wIops = counterMap["datastore:numberWriteAveraged:average"];

        var ids2 = [];
        if (rLat)  ids2.push(makeMetricId(rLat,  ""));
        if (wLat)  ids2.push(makeMetricId(wLat,  ""));
        if (rIops) ids2.push(makeMetricId(rIops, ""));
        if (wIops) ids2.push(makeMetricId(wIops, ""));

        if (ids2.length > 0) {
            var qs2 = new VcPerfQuerySpec();
            qs2.entity = ds; qs2.startTime = start; qs2.endTime = now;
            qs2.intervalId = 20; qs2.metricId = ids2; qs2.maxSample = 3;
            var res2 = perfMgr.queryPerf([qs2]);
            if (res2 && res2.length > 0 && res2[0].value) {
                for each (var s2 in res2[0].value) {
                    var avg2 = arrayAvg(s2.value);
                    if (rLat  && s2.id.counterId === rLat)  metrics.readLatencyMs  = avg2;
                    if (wLat  && s2.id.counterId === wLat)  metrics.writeLatencyMs = avg2;
                    if (rIops && s2.id.counterId === rIops) metrics.iopsRead        = avg2;
                    if (wIops && s2.id.counterId === wIops) metrics.iopsWrite       = avg2;
                }
            }
        }
    }
} catch (e) {
    System.warn("getDatastoreMetrics error for " + datastoreMoRef + ": " + e.message);
}

return JSON.stringify(metrics);

function buildCounterMap(pm) {
    var m = {};
    for each (var c in pm.perfCounter)
        m[c.groupInfo.key + ":" + c.nameInfo.key + ":" + c.rollupType.value] = c.key;
    return m;
}

function makeMetricId(counterId, instance) {
    var mid = new VcPerfMetricId();
    mid.counterId = counterId; mid.instance = instance;
    return mid;
}

function arrayAvg(arr) {
    if (!arr || arr.length === 0) return 0;
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
}