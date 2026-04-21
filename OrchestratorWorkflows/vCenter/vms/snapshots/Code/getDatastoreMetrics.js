/**
 * ACTION: _getDatastoreMetrics
 * Module : com.broadcom.pso.vc.storage
 *
 * Samples current I/O performance for a single datastore using native vRO
 * inventory objects throughout. Detects vSAN vs VMFS/NFS at runtime.
 *
 * vSAN counter key names for vCenter 9:
 *   vsan:latencyRead:average      (microseconds -> converted to ms)
 *   vsan:latencyWrite:average     (microseconds -> converted to ms)
 *   vsan:congestion:average
 *   vsan:bytesToSync:latest
 *   vsan:iopsRead:average
 *   vsan:iopsWrite:average
 *
 * Falls back from 20-second to 300-second interval automatically.
 * Returns null metrics (not an error) if sampling fails so the governor
 * skips the datastore rather than blocking the run.
 *
 * ── INPUTS ───────────────────────────────────────────────────────────────────
 *   Name                  Type              Description
 *   ──────────────────────────────────────────────────────────────────────────
 *   vcenterSdkConnection  VC:SdkConnection  The vCenter connection to query
 *   datastoreMoRef        string            datastore.id as stored by candidates
 *
 * ── RETURN TYPE ──────────────────────────────────────────────────────────────
 *   string  JSON metrics object. Fields are null if sampling failed.
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
    // ── Locate datastore using native vRO inventory object ────────────────────
    // vcenterSdkConnection.getAllDatastores() returns VC:Datastore objects.
    // datastore.id matches the datastoreMoRefs stored by _getSnapshotCandidates.
    var datastores = vcenterSdkConnection.getAllDatastores();
    var ds = null;
    for (var i = 0; i < datastores.length; i++) {
        if (datastores[i].id === datastoreMoRef) {
            ds = datastores[i];
            break;
        }
    }

    if (!ds) {
        System.warn("getDatastoreMetrics: datastore '" + datastoreMoRef +
                    "' not found via getAllDatastores()");
        return JSON.stringify(metrics);
    }

    // ── Detect datastore type from the VC:Datastore summary ──────────────────
    var dsType = "unknown";
    if (ds.summary && ds.summary.type) {
        dsType = ds.summary.type.toLowerCase();
    }
    metrics.datastoreType = dsType;

    // ── Build performance counter lookup map ──────────────────────────────────
    var perfMgr    = vcenterSdkConnection.performanceManager;
    var counterMap = {};
    var allCounters = perfMgr.perfCounter;
    for (var ci = 0; ci < allCounters.length; ci++) {
        var ctr = allCounters[ci];
        var k   = ctr.groupInfo.key + ":" + ctr.nameInfo.key + ":" + ctr.rollupType.value;
        counterMap[k] = ctr.key;
    }

    // ── Select counter keys for this datastore type ───────────────────────────
    var metricIds = [];
    var keyMap    = {};  // counterId (number) -> { field: string, isMicros: boolean }

    if (dsType === "vsan") {
        // vCenter 9 vSAN counter keys.
        // Also includes vCenter 7/8 variants as fallback in case of
        // mixed-version environments or future key name changes.
        var vsanKeys = [
            // vCenter 9 / 8.x
            { k: "vsan:latencyRead:average",    f: "readLatencyMs",        m: true  },
            { k: "vsan:latencyWrite:average",   f: "writeLatencyMs",       m: true  },
            { k: "vsan:congestion:average",     f: "vsanCongestion",       m: false },
            { k: "vsan:bytesToSync:latest",     f: "vsanResyncQueueDepth", m: false },
            { k: "vsan:iopsRead:average",       f: "iopsRead",             m: false },
            { k: "vsan:iopsWrite:average",      f: "iopsWrite",            m: false },
            // vCenter 7.x fallbacks
            { k: "vsanDomClient:readLatency:average",  f: "readLatencyMs",        m: true  },
            { k: "vsanDomClient:writeLatency:average", f: "writeLatencyMs",       m: true  },
            { k: "vsanDomClient:congestion:average",   f: "vsanCongestion",       m: false },
            { k: "vsanResync:bytesToSync:latest",      f: "vsanResyncQueueDepth", m: false },
        ];

        var mapped = {};
        for (var vki = 0; vki < vsanKeys.length; vki++) {
            var vk = vsanKeys[vki];
            if (counterMap[vk.k] !== undefined && !mapped[vk.f]) {
                var mid = new VcPerfMetricId();
                mid.counterId = counterMap[vk.k];
                mid.instance  = "";
                metricIds.push(mid);
                keyMap[counterMap[vk.k]] = { field: vk.f, isMicros: vk.m };
                mapped[vk.f] = true;
                System.log("getDatastoreMetrics: vSAN counter mapped: " +
                           vk.k + " -> " + vk.f);
            }
        }

        if (metricIds.length === 0) {
            // Dump available groups to help diagnose missing counters
            var groups = {};
            for (var gk in counterMap) groups[gk.split(":")[0]] = true;
            System.warn("getDatastoreMetrics: no vSAN counters matched for " +
                        datastoreMoRef + ". Counter groups available: " +
                        Object.keys(groups).sort().join(", "));
            return JSON.stringify(metrics);
        }

    } else {
        // VMFS / NFS -- stable counter keys across all vCenter versions
        var vmfsKeys = [
            { k: "datastore:totalReadLatency:average",    f: "readLatencyMs",  m: false },
            { k: "datastore:totalWriteLatency:average",   f: "writeLatencyMs", m: false },
            { k: "datastore:numberReadAveraged:average",  f: "iopsRead",       m: false },
            { k: "datastore:numberWriteAveraged:average", f: "iopsWrite",      m: false },
        ];
        for (var vfi = 0; vfi < vmfsKeys.length; vfi++) {
            var vf = vmfsKeys[vfi];
            if (counterMap[vf.k] !== undefined) {
                var mid2 = new VcPerfMetricId();
                mid2.counterId = counterMap[vf.k];
                mid2.instance  = "";
                metricIds.push(mid2);
                keyMap[counterMap[vf.k]] = { field: vf.f, isMicros: false };
            }
        }
    }

    if (metricIds.length === 0) {
        System.warn("getDatastoreMetrics: no counters mapped for " +
                    dsType + " datastore " + datastoreMoRef);
        return JSON.stringify(metrics);
    }

    // ── Query performance -- 20s real-time first, fall back to 300s ──────────
    var now    = new Date();
    var start  = new Date(now.getTime() - 300000);
    var values = null;

    var intervals = [20, 300];
    for (var ii = 0; ii < intervals.length; ii++) {
        try {
            var qs        = new VcPerfQuerySpec();
            qs.entity     = ds;
            qs.startTime  = start;
            qs.endTime    = now;
            qs.intervalId = intervals[ii];
            qs.metricId   = metricIds;
            qs.maxSample  = 3;

            var res = perfMgr.queryPerf([qs]);
            if (res && res.length > 0 && res[0].value && res[0].value.length > 0) {
                values = res[0].value;
                System.log("getDatastoreMetrics: sampled " + datastoreMoRef +
                           " at intervalId=" + intervals[ii]);
                break;
            }
        } catch (qe) {
            System.warn("getDatastoreMetrics: queryPerf intervalId=" + intervals[ii] +
                        " failed for " + datastoreMoRef + ": " + qe.message +
                        (ii < intervals.length - 1 ? " -- trying 300s interval" : ""));
        }
    }

    if (!values) {
        System.warn("getDatastoreMetrics: no data returned for " + datastoreMoRef +
                    " -- governor will skip this datastore for this task");
        return JSON.stringify(metrics);
    }

    // ── Parse values into metrics object ──────────────────────────────────────
    for (var vi = 0; vi < values.length; vi++) {
        var s    = values[vi];
        var info = keyMap[s.id.counterId];
        if (!info) continue;

        var avg = 0;
        if (s.value && s.value.length > 0) {
            var sum = 0;
            for (var si = 0; si < s.value.length; si++) sum += s.value[si];
            avg = sum / s.value.length;
        }

        // vSAN latency counters are in microseconds -- convert to ms
        metrics[info.field] = info.isMicros ? avg / 1000 : avg;
    }

} catch (e) {
    System.warn("getDatastoreMetrics error for " + datastoreMoRef +
                ": " + e.message);
}

return JSON.stringify(metrics);
