/**
 * ACTION: _getDatastoreMetrics
 * Module : com.broadcom.pso.vc.storage
 *
 * Samples current I/O performance for a single datastore.
 * Detects vSAN vs VMFS/NFS at runtime and applies the appropriate
 * performance counter set.
 *
 * If the 20-second real-time interval is unavailable (requires Statistics
 * Level 2+ on the datastore entity), automatically falls back to the
 * 5-minute (300-second) rollup interval. If all sampling fails, returns
 * a metrics object with null values so the governor treats this datastore
 * as uncalibrated and skips the check rather than blocking the run.
 *
 * ── INPUTS ───────────────────────────────────────────────────────────────────
 *   Name                  Type              Description
 *   ──────────────────────────────────────────────────────────────────────────
 *   vcenterSdkConnection  VC:SdkConnection  The vCenter connection to query
 *   datastoreMoRef        string            Datastore MoRef (e.g. "datastore-97")
 *
 * ── RETURN TYPE ──────────────────────────────────────────────────────────────
 *   string  JSON object with sampled metrics. All metric fields are null if
 *           sampling failed -- the governor treats null as uncalibrated and
 *           skips the check for that datastore rather than blocking the run.
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
    // ── Locate the datastore ──────────────────────────────────────────────────
    var datastores = vcenterSdkConnection.getAllDatastores();
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

    // ── Build counter lookup map ──────────────────────────────────────────────
    var perfMgr    = vcenterSdkConnection.performanceManager;
    var counterMap = {};
    var allCounters = perfMgr.perfCounter;
    for (var ci = 0; ci < allCounters.length; ci++) {
        var c   = allCounters[ci];
        var key = c.groupInfo.key + ":" + c.nameInfo.key + ":" + c.rollupType.value;
        counterMap[key] = c.key;
    }

    // ── Determine which counter keys and interval to use ──────────────────────
    var metricIds  = [];
    var keyMap     = {};   // counterId (number) -> metric field name

    if (dsType === "vsan") {
        var keys = {
            "vsanDomClient:congestion:average":   "vsanCongestion",
            "vsanResync:bytesToSync:latest":      "vsanResyncQueueDepth",
            "vsanDomClient:readLatency:average":  "readLatencyMs",
            "vsanDomClient:writeLatency:average": "writeLatencyMs"
        };
        for (var k in keys) {
            if (counterMap[k] !== undefined) {
                var mid = new VcPerfMetricId();
                mid.counterId = counterMap[k];
                mid.instance  = "";
                metricIds.push(mid);
                keyMap[counterMap[k]] = keys[k];
            }
        }
    } else {
        var keys2 = {
            "datastore:totalReadLatency:average":   "readLatencyMs",
            "datastore:totalWriteLatency:average":  "writeLatencyMs",
            "datastore:numberReadAveraged:average":  "iopsRead",
            "datastore:numberWriteAveraged:average": "iopsWrite"
        };
        for (var k2 in keys2) {
            if (counterMap[k2] !== undefined) {
                var mid2 = new VcPerfMetricId();
                mid2.counterId = counterMap[k2];
                mid2.instance  = "";
                metricIds.push(mid2);
                keyMap[counterMap[k2]] = keys2[k2];
            }
        }
    }

    if (metricIds.length === 0) {
        System.warn("getDatastoreMetrics: no matching performance counters found for " +
                    dsType + " datastore " + datastoreMoRef + " -- returning null metrics");
        return JSON.stringify(metrics);
    }

    // ── Query performance -- try 20s real-time first, fall back to 300s ───────
    var now    = new Date();
    var start  = new Date(now.getTime() - 300000);  // 5 min window covers both intervals
    var values = null;

    var intervals = [20, 300];
    for (var ii = 0; ii < intervals.length; ii++) {
        try {
            var qs       = new VcPerfQuerySpec();
            qs.entity    = ds;
            qs.startTime = start;
            qs.endTime   = now;
            qs.intervalId= intervals[ii];
            qs.metricId  = metricIds;
            qs.maxSample = 3;

            var results = perfMgr.queryPerf([qs]);
            if (results && results.length > 0 && results[0].value &&
                results[0].value.length > 0) {
                values = results[0].value;
                break;  // got data -- stop trying intervals
            }
        } catch (qe) {
            System.warn("getDatastoreMetrics: queryPerf failed with intervalId=" +
                        intervals[ii] + " for " + datastoreMoRef +
                        " -- " + qe.message +
                        (ii < intervals.length - 1 ? " -- trying next interval" : ""));
        }
    }

    // ── Parse returned values ─────────────────────────────────────────────────
    if (values) {
        for (var vi = 0; vi < values.length; vi++) {
            var s      = values[vi];
            var cid    = s.id.counterId;
            var field  = keyMap[cid];
            if (!field) continue;

            var avg = 0;
            if (s.value && s.value.length > 0) {
                var sum = 0;
                for (var si = 0; si < s.value.length; si++) sum += s.value[si];
                avg = sum / s.value.length;
            }

            // vSAN latency counters are in microseconds -- convert to ms
            if (field === "readLatencyMs" || field === "writeLatencyMs") {
                avg = dsType === "vsan" ? avg / 1000 : avg;
            }

            metrics[field] = avg;
        }
    } else {
        System.warn("getDatastoreMetrics: no performance data returned for " +
                    datastoreMoRef + " on any interval -- returning null metrics. " +
                    "The I/O governor will skip this datastore for this task.");
    }

} catch (e) {
    System.warn("getDatastoreMetrics error for " + datastoreMoRef + ": " + e.message);
}

return JSON.stringify(metrics);
