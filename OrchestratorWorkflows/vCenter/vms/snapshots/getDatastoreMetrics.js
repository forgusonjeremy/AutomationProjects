/**
 * ACTION: getDatastoreMetrics
 * vRO Action — samples current I/O performance for a single datastore.
 * Detects vSAN vs VMFS/NFS at runtime and applies appropriate metric collection.
 *
 * Inputs:
 *   vcenterSdkConnection : VC:SdkConnection
 *   datastoreMoRef       : string   — datastore managed object reference value
 *
 * Returns: JSON string {
 *   datastoreMoRef, datastoreType,   -- "vsan" | "vmfs" | "nfs" | "unknown"
 *   readLatencyMs, writeLatencyMs,   -- avg latency in ms (VMFS/NFS via perf manager)
 *   iopsRead, iopsWrite,             -- IOPS
 *   vsanCongestion,                  -- 0-255 (vSAN only, else null)
 *   vsanResyncQueueDepth,            -- integer (vSAN only, else null)
 *   sampledAtMs                      -- epoch ms
 * }
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
    // Resolve the datastore object
    var ds = VcPlugin.findEntityById("Datastore:" + datastoreMoRef, vcenterSdkConnection);
    if (!ds) {
        System.warn("getDatastoreMetrics: datastore not found: " + datastoreMoRef);
        return JSON.stringify(metrics);
    }

    // Detect type from summary
    var dsType = ds.summary && ds.summary.type ? ds.summary.type.toLowerCase() : "unknown";
    metrics.datastoreType = dsType;

    if (dsType === "vsan") {
        // vSAN: use VsanInternalSystem / performance service
        // In embedded vRO on VCF 9, vSAN perf data is available via the vSAN API plugin
        // or via the PerformanceManager with vSAN-specific counters.
        // We use PerformanceManager with known vSAN counter group IDs.
        var perfMgr = vcenterSdkConnection.performanceManager;
        var now = new Date();
        var start = new Date(now.getTime() - 60000); // last 60 seconds

        // Counter IDs for vSAN (group: vsanDomClient, instance: *)
        // datastore.read.latency.avg  datastore.write.latency.avg
        // These counter keys are stable in vSAN 7+
        var counterMap = buildCounterMap(perfMgr);

        var readLatKey  = counterMap["vsanDomClient:readLatency:average"];
        var writeLatKey = counterMap["vsanDomClient:writeLatency:average"];
        var congKey     = counterMap["vsanDomClient:congestion:average"];
        var resyncKey   = counterMap["vsanResync:bytesToSync:latest"];

        var counterIds = [];
        if (readLatKey)  counterIds.push(makeMetricId(readLatKey,  ""));
        if (writeLatKey) counterIds.push(makeMetricId(writeLatKey, ""));
        if (congKey)     counterIds.push(makeMetricId(congKey,     ""));
        if (resyncKey)   counterIds.push(makeMetricId(resyncKey,   ""));

        if (counterIds.length > 0) {
            var querySpec = new VcPerfQuerySpec();
            querySpec.entity        = ds;
            querySpec.startTime     = start;
            querySpec.endTime       = now;
            querySpec.intervalId    = 20;
            querySpec.metricId      = counterIds;
            querySpec.maxSample     = 3;

            var results = perfMgr.queryPerf([querySpec]);
            if (results && results.length > 0 && results[0].value) {
                for each (var series in results[0].value) {
                    var key = series.id.counterId;
                    var vals = series.value;
                    var avg = arrayAvg(vals);
                    if (readLatKey  && key === readLatKey)  metrics.readLatencyMs  = avg / 1000; // microseconds → ms
                    if (writeLatKey && key === writeLatKey) metrics.writeLatencyMs = avg / 1000;
                    if (congKey     && key === congKey)     metrics.vsanCongestion = avg;
                    if (resyncKey   && key === resyncKey)   metrics.vsanResyncQueueDepth = avg;
                }
            }
        }

    } else {
        // VMFS / NFS: standard datastore performance counters
        var perfMgr2 = vcenterSdkConnection.performanceManager;
        var now2  = new Date();
        var start2 = new Date(now2.getTime() - 60000);

        var counterMap2  = buildCounterMap(perfMgr2);
        var readLatKey2  = counterMap2["datastore:totalReadLatency:average"];
        var writeLatKey2 = counterMap2["datastore:totalWriteLatency:average"];
        var iopsRKey     = counterMap2["datastore:numberReadAveraged:average"];
        var iopsWKey     = counterMap2["datastore:numberWriteAveraged:average"];

        var counterIds2 = [];
        if (readLatKey2)  counterIds2.push(makeMetricId(readLatKey2,  ""));
        if (writeLatKey2) counterIds2.push(makeMetricId(writeLatKey2, ""));
        if (iopsRKey)     counterIds2.push(makeMetricId(iopsRKey,     ""));
        if (iopsWKey)     counterIds2.push(makeMetricId(iopsWKey,     ""));

        if (counterIds2.length > 0) {
            var querySpec2 = new VcPerfQuerySpec();
            querySpec2.entity     = ds;
            querySpec2.startTime  = start2;
            querySpec2.endTime    = now2;
            querySpec2.intervalId = 20;
            querySpec2.metricId   = counterIds2;
            querySpec2.maxSample  = 3;

            var results2 = perfMgr2.queryPerf([querySpec2]);
            if (results2 && results2.length > 0 && results2[0].value) {
                for each (var series2 in results2[0].value) {
                    var key2 = series2.id.counterId;
                    var vals2 = series2.value;
                    var avg2 = arrayAvg(vals2);
                    if (readLatKey2  && key2 === readLatKey2)  metrics.readLatencyMs  = avg2;
                    if (writeLatKey2 && key2 === writeLatKey2) metrics.writeLatencyMs = avg2;
                    if (iopsRKey     && key2 === iopsRKey)     metrics.iopsRead        = avg2;
                    if (iopsWKey     && key2 === iopsWKey)     metrics.iopsWrite       = avg2;
                }
            }
        }
    }

} catch(e) {
    System.warn("getDatastoreMetrics error for " + datastoreMoRef + ": " + e.message);
}

return JSON.stringify(metrics);

// ---- helpers ----

function buildCounterMap(perfMgr) {
    var map = {};
    var counters = perfMgr.perfCounter;
    for each (var c in counters) {
        var key = c.groupInfo.key + ":" + c.nameInfo.key + ":" + c.rollupType.value;
        map[key] = c.key;
    }
    return map;
}

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
