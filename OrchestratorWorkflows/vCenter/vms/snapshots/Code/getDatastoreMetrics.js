/**
 * ACTION: _getDatastoreMetrics
 * Module : com.broadcom.pso.vc.storage
 *
 * Samples current I/O performance for a single datastore.
 *
 * VMFS/NFS: Uses standard PerformanceManager.queryPerf against the datastore
 *           entity. Falls back from intervalId=20 to intervalId=300.
 *
 * vSAN: The vsanDomObj counters in vCenter 9 are not queryable via
 *       PerformanceManager.queryPerf against any entity (datastore, host,
 *       or cluster). Instead, this action uses HostVsanInternalSystem
 *       .queryVsanStatistics(["dom"]) which is accessible through the
 *       native vRO inventory object model via:
 *         cluster.host[n].configManager.vsanInternalSystem
 *
 *       The "dom" label returns dom.owner.stats -- a flat aggregate of
 *       cumulative DOM owner counters across all vSAN objects on that host.
 *       To derive a point-in-time rate, two snapshots are taken 2 seconds
 *       apart and the delta is used to compute current latency.
 *
 *       Fields used from dom.owner.stats:
 *         readHighDepthCount    -- read IOs during high-depth periods
 *         readHighDepthDurationMs  -- total duration of those periods (ms)
 *         writeHighDepthCount
 *         writeHighDepthDurationMs
 *         readCachedCongestionSum  -- proxy for read congestion
 *         proxyWriteCongestionSum  -- proxy for write congestion
 *
 *       Aggregated across all hosts in the cluster that own vSAN objects.
 *
 * ── INPUTS ───────────────────────────────────────────────────────────────────
 *   Name                  Type              Description
 *   ──────────────────────────────────────────────────────────────────────────
 *   vcenterSdkConnection  VC:SdkConnection  The vCenter connection to query
 *   datastoreMoRef        string            datastore.id (e.g. "datastore-18")
 *
 * ── RETURN TYPE ──────────────────────────────────────────────────────────────
 *   string  JSON metrics object. Null fields = uncalibrated; governor skips.
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

    var dsType = "unknown";
    if (ds.summary && ds.summary.type) {
        dsType = ds.summary.type.toLowerCase();
    }
    metrics.datastoreType = dsType;

    // ── vSAN path ─────────────────────────────────────────────────────────────
    if (dsType === "vsan") {
        // Find the cluster that hosts this vSAN datastore by traversing
        // the inventory tree -- vSAN datastores are associated with a cluster.
        // We find the first cluster whose configurationEx.vsanConfigInfo.enabled
        // is true, then query vsanInternalSystem on each of its hosts.
        var cluster = null;
        var root    = vcenterSdkConnection.rootFolder;
        for (var dci = 0; dci < root.childEntity.length; dci++) {
            var dc = root.childEntity[dci];
            if (!dc.hostFolder) continue;
            for (var cli = 0; cli < dc.hostFolder.childEntity.length; cli++) {
                var cl = dc.hostFolder.childEntity[cli];
                if (cl.configurationEx && cl.configurationEx.vsanConfigInfo &&
                    cl.configurationEx.vsanConfigInfo.enabled) {
                    cluster = cl;
                    break;
                }
            }
            if (cluster) break;
        }

        if (!cluster) {
            System.warn("getDatastoreMetrics: no vSAN-enabled cluster found for " +
                        datastoreMoRef);
            return JSON.stringify(metrics);
        }

        // Take two snapshots 2 seconds apart to compute delta-based rates.
        // dom.owner.stats is a flat object of cumulative counters aggregated
        // across all DOM objects on the host. Fields of interest:
        //   readHighDepthCount     -- read IO count during high-depth periods
        //   readHighDepthDurationMs
        //   writeHighDepthCount
        //   writeHighDepthDurationMs
        //   readCachedCongestionSum
        //   proxyWriteCongestionSum

        function sampleDomStats(cl) {
            var agg = {
                readHighDepthCount:      0,
                readHighDepthDurationMs: 0,
                writeHighDepthCount:     0,
                writeHighDepthDurationMs:0,
                readCongestionSum:       0,
                writeCongestionSum:      0,
                hostCount:               0
            };
            for (var hi = 0; hi < cl.host.length; hi++) {
                try {
                    var vis    = cl.host[hi].configManager.vsanInternalSystem;
                    var raw    = vis.queryVsanStatistics(["dom"]);
                    var parsed = JSON.parse(raw);
                    var os     = parsed["dom.owner.stats"];
                    if (!os) continue;
                    agg.readHighDepthCount       += (os.readHighDepthCount       || 0);
                    agg.readHighDepthDurationMs  += (os.readHighDepthDurationMs  || 0);
                    agg.writeHighDepthCount      += (os.writeHighDepthCount      || 0);
                    agg.writeHighDepthDurationMs += (os.writeHighDepthDurationMs || 0);
                    agg.readCongestionSum        += (os.readCachedCongestionSum  || 0);
                    agg.writeCongestionSum       += (os.proxyWriteCongestionSum  || 0);
                    agg.hostCount++;
                } catch (he) {
                    System.warn("getDatastoreMetrics: vsanInternalSystem error on host " +
                                cl.host[hi].name + ": " + he.message);
                }
            }
            return agg;
        }

        var snap1 = sampleDomStats(cluster);
        System.sleep(2000);
        var snap2 = sampleDomStats(cluster);

        // Compute deltas
        var dReadCount    = Math.max(0, snap2.readHighDepthCount      - snap1.readHighDepthCount);
        var dReadMs       = Math.max(0, snap2.readHighDepthDurationMs  - snap1.readHighDepthDurationMs);
        var dWriteCount   = Math.max(0, snap2.writeHighDepthCount     - snap1.writeHighDepthCount);
        var dWriteMs      = Math.max(0, snap2.writeHighDepthDurationMs - snap1.writeHighDepthDurationMs);
        var dReadCong     = Math.max(0, snap2.readCongestionSum  - snap1.readCongestionSum);
        var dWriteCong    = Math.max(0, snap2.writeCongestionSum - snap1.writeCongestionSum);

        // Latency: total duration of high-depth periods / IO count during those periods
        // This gives average ms per IO during periods when the cluster was under load.
        // When there is no load, dReadCount will be 0 and we return null (uncalibrated).
        if (dReadCount > 0) {
            metrics.readLatencyMs = dReadMs / dReadCount;
        }
        if (dWriteCount > 0) {
            metrics.writeLatencyMs = dWriteMs / dWriteCount;
        }

        // Congestion: total congestion sum delta across all hosts.
        // Higher values indicate more contention. We normalise by host count
        // to get a per-host average comparable across cluster sizes.
        var hostCount = Math.max(1, snap2.hostCount);
        metrics.vsanCongestion = (dReadCong + dWriteCong) / hostCount;

        // IOPS: use count delta over the 2-second window
        metrics.iopsRead  = dReadCount  / 2;
        metrics.iopsWrite = dWriteCount / 2;

        System.log("getDatastoreMetrics: vSAN sample complete for " + datastoreMoRef +
                   " readLatMs=" + (metrics.readLatencyMs  !== null ? metrics.readLatencyMs.toFixed(2)  : "null") +
                   " writeLatMs=" + (metrics.writeLatencyMs !== null ? metrics.writeLatencyMs.toFixed(2) : "null") +
                   " congestion=" + metrics.vsanCongestion.toFixed(1) +
                   " iopsR=" + metrics.iopsRead.toFixed(1) +
                   " iopsW=" + metrics.iopsWrite.toFixed(1));

    } else {
        // ── VMFS / NFS path ───────────────────────────────────────────────────
        var perfMgr    = vcenterSdkConnection.performanceManager;
        var counterMap = {};
        var allCounters = perfMgr.perfCounter;
        for (var ci = 0; ci < allCounters.length; ci++) {
            var ctr = allCounters[ci];
            var k   = ctr.groupInfo.key + ":" + ctr.nameInfo.key + ":" + ctr.rollupType.value;
            counterMap[k] = ctr.key;
        }

        var vmfsKeys = [
            { k: "datastore:totalReadLatency:average",    f: "readLatencyMs",  m: false },
            { k: "datastore:totalWriteLatency:average",   f: "writeLatencyMs", m: false },
            { k: "datastore:numberReadAveraged:average",  f: "iopsRead",       m: false },
            { k: "datastore:numberWriteAveraged:average", f: "iopsWrite",      m: false },
        ];

        var metricIds = [];
        var keyMap    = {};
        for (var vfi = 0; vfi < vmfsKeys.length; vfi++) {
            var vf = vmfsKeys[vfi];
            if (counterMap[vf.k] !== undefined) {
                var mid = new VcPerfMetricId();
                mid.counterId = counterMap[vf.k];
                mid.instance  = "";
                metricIds.push(mid);
                keyMap[counterMap[vf.k]] = { field: vf.f, isMicros: false };
            }
        }

        if (metricIds.length === 0) {
            System.warn("getDatastoreMetrics: no VMFS counters found for " + datastoreMoRef);
            return JSON.stringify(metrics);
        }

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

        if (values) {
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
                metrics[info.field] = info.isMicros ? avg / 1000 : avg;
            }
        } else {
            System.warn("getDatastoreMetrics: no VMFS data returned for " +
                        datastoreMoRef + " -- governor will skip this datastore");
        }
    }

} catch (e) {
    System.warn("getDatastoreMetrics error for " + datastoreMoRef + ": " + e.message);
}

return JSON.stringify(metrics);
