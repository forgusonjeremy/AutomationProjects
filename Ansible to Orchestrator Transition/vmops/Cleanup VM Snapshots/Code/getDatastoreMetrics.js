/**
 * ACTION: _getDatastoreMetrics
 * Module : com.broadcom.pso.vc.storage
 *
 * Samples current I/O performance for a single datastore across ALL hosts
 * that mount it. Returns per-host metrics at real-time (20s) resolution
 * plus a computed aggregate for quick threshold checks.
 *
 * VMFS/NFS: Queries PerformanceManager.queryPerf against each host entity
 *           with the datastore instance key at intervalId=20 (real-time).
 *           Falls back to intervalId=300 ONLY if real-time is unavailable
 *           on a given host, and flags that host's data as stale.
 *
 * vSAN:     Uses HostVsanInternalSystem.queryVsanStatistics(["dom"]) on
 *           each host in the vSAN cluster. Two snapshots 2 seconds apart
 *           provide delta-based rates per host.
 *
 * ── INPUTS ───────────────────────────────────────────────────────────────────
 *   Name                  Type              Description
 *   ──────────────────────────────────────────────────────────────────────────
 *   vcenterSdkConnection  VC:SdkConnection  The vCenter connection to query
 *   datastoreMoRef        string            datastore.id (e.g. "datastore-18")
 *
 * ── RETURN TYPE ──────────────────────────────────────────────────────────────
 *   string  JSON metrics object with perHost map and aggregate summary.
 *
 *   Shape:
 *   {
 *     datastoreMoRef:  "datastore-18",
 *     datastoreType:   "VMFS" | "vsan" | "NFS" | "unknown",
 *     sampledAtMs:     <epoch ms>,
 *     perHost: {
 *       "host-101": {
 *         hostName:       "esxi-01.lab.local",
 *         readLatencyMs:  4.2,
 *         writeLatencyMs: 6.1,
 *         iopsRead:       120,
 *         iopsWrite:      80,
 *         intervalUsed:   20,
 *         // vSAN-only fields (null for VMFS/NFS):
 *         vsanCongestion:       null,
 *         vsanResyncQueueDepth: null
 *       },
 *       ...
 *     },
 *     aggregate: {
 *       avgReadLatencyMs:    <mean across hosts>,
 *       avgWriteLatencyMs:   <mean across hosts>,
 *       maxReadLatencyMs:    <worst host>,
 *       maxWriteLatencyMs:   <worst host>,
 *       totalIopsRead:       <sum across hosts>,
 *       totalIopsWrite:      <sum across hosts>,
 *       hotHost:             "host-103"  (host with highest combined latency),
 *       hostsSampled:        3,
 *       hostsAtRealTime:     2,
 *       hostsAtRollup:       1,
 *       // vSAN-only aggregates:
 *       avgVsanCongestion:   null,
 *       maxVsanCongestion:   null
 *     }
 *   }
 */

var result = {
    datastoreMoRef: datastoreMoRef,
    datastoreType:  "unknown",
    sampledAtMs:    new Date().getTime(),
    perHost:        {},
    aggregate:      {
        avgReadLatencyMs:    null,
        avgWriteLatencyMs:   null,
        maxReadLatencyMs:    null,
        maxWriteLatencyMs:   null,
        totalIopsRead:       null,
        totalIopsWrite:      null,
        hotHost:             null,
        hostsSampled:        0,
        hostsAtRealTime:     0,
        hostsAtRollup:       0,
        avgVsanCongestion:   null,
        maxVsanCongestion:   null
    }
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
        return JSON.stringify(result);
    }

    var dsType = "unknown";
    if (ds.summary && ds.summary.type) {
        dsType = ds.summary.type.toLowerCase();
    }
    result.datastoreType = dsType;

    // ══════════════════════════════════════════════════════════════════════════
    // vSAN PATH — per-host DOM owner stats via vsanInternalSystem
    // ══════════════════════════════════════════════════════════════════════════
    if (dsType === "vsan") {

        // Find the vSAN-enabled cluster that owns this datastore.
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
            return JSON.stringify(result);
        }

        // Take two snapshots 2s apart — per-host granularity.
        function sampleDomStatsPerHost(cl) {
            var hostData = {};
            for (var hi = 0; hi < cl.host.length; hi++) {
                var h      = cl.host[hi];
                var hostId = h.id || String(h);
                try {
                    var vis    = h.configManager.vsanInternalSystem;
                    var raw    = vis.queryVsanStatistics(["dom"]);
                    var parsed = JSON.parse(raw);
                    var os     = parsed["dom.owner.stats"];
                    if (!os) continue;
                    hostData[hostId] = {
                        hostName:                h.name,
                        readHighDepthCount:      os.readHighDepthCount       || 0,
                        readHighDepthDurationMs: os.readHighDepthDurationMs  || 0,
                        writeHighDepthCount:     os.writeHighDepthCount      || 0,
                        writeHighDepthDurationMs:os.writeHighDepthDurationMs || 0,
                        readCongestionSum:       os.readCachedCongestionSum  || 0,
                        writeCongestionSum:      os.proxyWriteCongestionSum  || 0
                    };
                } catch (he) {
                    System.warn("getDatastoreMetrics: vsanInternalSystem error on host " +
                                h.name + ": " + he.message);
                }
            }
            return hostData;
        }

        var snap1 = sampleDomStatsPerHost(cluster);
        System.sleep(2000);
        var snap2 = sampleDomStatsPerHost(cluster);

        for (var hostId in snap2) {
            if (!snap1[hostId]) continue;
            var s1 = snap1[hostId];
            var s2 = snap2[hostId];

            var dReadCount  = Math.max(0, s2.readHighDepthCount      - s1.readHighDepthCount);
            var dReadMs     = Math.max(0, s2.readHighDepthDurationMs  - s1.readHighDepthDurationMs);
            var dWriteCount = Math.max(0, s2.writeHighDepthCount     - s1.writeHighDepthCount);
            var dWriteMs    = Math.max(0, s2.writeHighDepthDurationMs - s1.writeHighDepthDurationMs);
            var dReadCong   = Math.max(0, s2.readCongestionSum  - s1.readCongestionSum);
            var dWriteCong  = Math.max(0, s2.writeCongestionSum - s1.writeCongestionSum);

            result.perHost[hostId] = {
                hostName:             s2.hostName,
                readLatencyMs:        dReadCount  > 0 ? dReadMs  / dReadCount  : null,
                writeLatencyMs:       dWriteCount > 0 ? dWriteMs / dWriteCount : null,
                iopsRead:             dReadCount  / 2,
                iopsWrite:            dWriteCount / 2,
                vsanCongestion:       dReadCong + dWriteCong,
                vsanResyncQueueDepth: null,
                intervalUsed:         2
            };
        }

    // ══════════════════════════════════════════════════════════════════════════
    // VMFS / NFS PATH — per-host PerformanceManager queries at real-time
    // ══════════════════════════════════════════════════════════════════════════
    } else {

        var perfMgr    = vcenterSdkConnection.performanceManager;
        var counterMap = {};
        var allCounters = perfMgr.perfCounter;
        for (var ci = 0; ci < allCounters.length; ci++) {
            var ctr = allCounters[ci];
            var k   = ctr.groupInfo.key + ":" + ctr.nameInfo.key + ":" + ctr.rollupType.value;
            counterMap[k] = ctr.key;
        }

        // isMicros=true: counter is in microseconds at real-time (intervalId=20)
        //                and milliseconds at rollup (intervalId=300).
        //                Code converts to ms when real-time data is used.
        // isMicros=false: counter unit is the same at both intervals (no conversion).
        var vmfsKeys = [
            { k: "datastore:totalReadLatency:average",    f: "readLatencyMs",  isMicros: true  },
            { k: "datastore:totalWriteLatency:average",   f: "writeLatencyMs", isMicros: true  },
            { k: "datastore:numberReadAveraged:average",  f: "iopsRead",       isMicros: false },
            { k: "datastore:numberWriteAveraged:average", f: "iopsWrite",      isMicros: false }
        ];

        var metricIds     = [];
        var keyMap        = {};   // counterId -> field name
        var microCounters = {};   // counterId -> true if microseconds at real-time
        for (var vfi = 0; vfi < vmfsKeys.length; vfi++) {
            var vf = vmfsKeys[vfi];
            if (counterMap[vf.k] !== undefined) {
                var mid = new VcPerfMetricId();
                mid.counterId = counterMap[vf.k];
                metricIds.push(mid);
                keyMap[counterMap[vf.k]]        = vf.f;
                microCounters[counterMap[vf.k]] = vf.isMicros;
            }
        }

        if (metricIds.length === 0) {
            System.warn("getDatastoreMetrics: no VMFS/NFS counters resolved for " +
                        datastoreMoRef);
            return JSON.stringify(result);
        }

        // ── Resolve the datastore instance key for host-level queries ─────────
        // For VMFS/NFS datastore counters queried against a HOST entity, the
        // instance string is NOT the datastore display name. It is one of:
        //   1. The datastore URL path  e.g. "/vmfs/volumes/<uuid>"
        //   2. The datastore UUID only e.g. "<uuid>"
        //   3. The datastore name      e.g. "ds1"  (rare, older vCenter builds)
        //
        // We resolve this by calling queryAvailablePerfMetric with no intervalId
        // (pass null / omit) and scanning the returned metric instances for one
        // that contains the datastore name or MoRef. vRO 8.17 Polyglot exposes
        // the no-arg overload: queryAvailablePerfMetric(entity) which does not
        // require a Date argument.
        var dsHosts = ds.host;

        if (!dsHosts || dsHosts.length === 0) {
            System.warn("getDatastoreMetrics: no hosts mount datastore " +
                        datastoreMoRef);
            return JSON.stringify(result);
        }

        // Build candidate list: try URL path, UUID from URL, and display name.
        // The URL is typically "ds:///vmfs/volumes/<uuid>/" -- extract the UUID.
        var dsUrl        = (ds.summary && ds.summary.url) ? ds.summary.url : "";
        var dsUuid       = "";
        var urlMatch     = dsUrl.replace(/\/+$/, "").split("/");
        if (urlMatch.length > 0) dsUuid = urlMatch[urlMatch.length - 1];

        // Candidate instance keys in priority order.
        // We probe with queryPerf using a tiny time window to find which one
        // returns data, then use that for all subsequent host queries.
        var instanceCandidates = [];
        if (dsUuid && dsUuid !== "")            instanceCandidates.push(dsUuid);
        if (dsUrl  && dsUrl  !== "")            instanceCandidates.push(dsUrl.replace(/\/+$/, ""));
        if (ds.name && ds.name !== "")          instanceCandidates.push(ds.name);
        instanceCandidates.push("");  // wildcard -- returns all instances

        var dsInstanceKey = ds.name;  // safe default
        var probeHost     = dsHosts[0].key;
        var probeNow      = new Date();

        // Use the first counter in metricIds for probing.
        var probeMetricId = new VcPerfMetricId();
        probeMetricId.counterId = metricIds[0].counterId;

        for (var ci2 = 0; ci2 < instanceCandidates.length; ci2++) {
            var candidate = instanceCandidates[ci2];
            probeMetricId.instance = candidate;

            try {
                var probeQs       = new VcPerfQuerySpec();
                probeQs.entity    = probeHost;
                probeQs.startTime = new Date(probeNow.getTime() - 120000);
                probeQs.endTime   = probeNow;
                probeQs.intervalId= 20;
                probeQs.metricId  = [probeMetricId];
                probeQs.maxSample = 1;

                var probeRes = perfMgr.queryPerf([probeQs]);
                if (probeRes && probeRes.length > 0 && probeRes[0].value &&
                    probeRes[0].value.length > 0) {
                    // Found a working instance key -- use the actual instance
                    // string returned by vCenter (may differ from what we sent
                    // if we sent the wildcard "").
                    var actualInstance = probeRes[0].value[0].id.instance;
                    dsInstanceKey = (actualInstance !== null && actualInstance !== undefined)
                                        ? String(actualInstance) : candidate;
                    System.log("getDatastoreMetrics: resolved instance key '" +
                               dsInstanceKey + "' for " + datastoreMoRef +
                               " (probe candidate: '" + candidate + "')");
                    break;
                }
            } catch (probeErr) {
                System.warn("getDatastoreMetrics: instance probe failed for '" +
                            candidate + "' on " + datastoreMoRef + ": " +
                            probeErr.message);
            }

            // Wildcard returned nothing -- log available instances for diagnosis.
            if (candidate === "" && ci2 === instanceCandidates.length - 1) {
                System.warn("getDatastoreMetrics: all instance key probes failed " +
                            "for " + datastoreMoRef +
                            ". dsName='" + ds.name + "'" +
                            " dsUrl='" + dsUrl + "'" +
                            " dsUuid='" + dsUuid + "'" +
                            ". No host-level perf data will be available.");
            }
        }

        // ── Query each host individually at real-time resolution ──────────────
        var now = new Date();

        for (var hi = 0; hi < dsHosts.length; hi++) {
            var hostRef  = dsHosts[hi].key;
            var hostId   = hostRef.id || String(hostRef);
            var hostName = "";
            try { hostName = hostRef.name; } catch (hn) { hostName = hostId; }

            var hostMetrics = {
                hostName:             hostName,
                readLatencyMs:        null,
                writeLatencyMs:       null,
                iopsRead:             null,
                iopsWrite:            null,
                vsanCongestion:       null,
                vsanResyncQueueDepth: null,
                intervalUsed:         null
            };

            // Build metricIds with the correct instance for this datastore.
            var hostMetricIds = [];
            for (var mi = 0; mi < metricIds.length; mi++) {
                var hmid = new VcPerfMetricId();
                hmid.counterId = metricIds[mi].counterId;
                hmid.instance  = dsInstanceKey;
                hostMetricIds.push(hmid);
            }

            // Try real-time first (intervalId=20, 60s window).
            // Fall back to intervalId=300 only if real-time returns no data.
            var values       = null;
            var intervalUsed = null;

            var attempts = [
                // Real-time: take up to 3 samples over a 90s window and use
                // the MAXIMUM observed value rather than the mean. This avoids
                // idle samples diluting a burst that happened 40-60s ago.
                // The 90s window ensures we always capture at least one 20s
                // sample even with slight clock skew between the query and vCenter.
                { interval: 20,  windowMs: 90000,  maxSample: 3, label: "real-time",   useMax: true  },
                // 5-minute rollup: mean is fine here as it already represents
                // the sustained average over the full 300s bucket.
                { interval: 300, windowMs: 600000, maxSample: 2, label: "5min-rollup", useMax: false }
            ];

            for (var ai2 = 0; ai2 < attempts.length; ai2++) {
                var att = attempts[ai2];
                try {
                    var qs        = new VcPerfQuerySpec();
                    qs.entity     = hostRef;
                    qs.startTime  = new Date(now.getTime() - att.windowMs);
                    qs.endTime    = now;
                    qs.intervalId = att.interval;
                    qs.metricId   = hostMetricIds;
                    qs.maxSample  = att.maxSample;

                    var res = perfMgr.queryPerf([qs]);
                    if (res && res.length > 0 && res[0].value &&
                        res[0].value.length > 0) {
                        values       = res[0].value;
                        intervalUsed = att.interval;
                        break;
                    }
                } catch (qe) {
                    System.warn("getDatastoreMetrics: queryPerf " + att.label +
                                " failed on host " + hostName + " for " +
                                datastoreMoRef + ": " + qe.message);
                }
            }

            if (values) {
                hostMetrics.intervalUsed = intervalUsed;
                for (var vi = 0; vi < values.length; vi++) {
                    var s     = values[vi];
                    var field    = keyMap[s.id.counterId];
                    var isMicros = microCounters[s.id.counterId];
                    if (!field) continue;
                    var avg = 0;
                    if (s.value && s.value.length > 0) {
                        if (att.useMax) {
                            // Use the peak sample in the window so a burst that
                            // happened partway through the window is not diluted
                            // by idle samples before or after it.
                            var peak = s.value[0];
                            for (var si = 1; si < s.value.length; si++) {
                                if (s.value[si] > peak) peak = s.value[si];
                            }
                            avg = peak;
                        } else {
                            var sum = 0;
                            for (var si = 0; si < s.value.length; si++) sum += s.value[si];
                            avg = sum / s.value.length;
                        }
                    }
                    // Latency counters at intervalId=20 are in microseconds.
                    // At intervalId=300 they are already in milliseconds.
                    // Convert so hostMetrics always stores milliseconds.
                    hostMetrics[field] = (isMicros && intervalUsed === 20)
                                         ? avg / 1000
                                         : avg;
                }

                if (intervalUsed === 20) {
                    System.log("getDatastoreMetrics: host " + hostName +
                               " sampled at real-time (20s) for " + datastoreMoRef +
                               " — R:" + (hostMetrics.readLatencyMs !== null
                                   ? hostMetrics.readLatencyMs.toFixed(1) : "null") +
                               "ms W:" + (hostMetrics.writeLatencyMs !== null
                                   ? hostMetrics.writeLatencyMs.toFixed(1) : "null") + "ms");
                } else {
                    System.warn("getDatastoreMetrics: host " + hostName +
                                " fell back to 300s rollup for " + datastoreMoRef +
                                " — data may be stale");
                }
            } else {
                System.warn("getDatastoreMetrics: no perf data from host " +
                            hostName + " for " + datastoreMoRef +
                            " — host will be excluded from governor analysis");
            }

            result.perHost[hostId] = hostMetrics;
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // AGGREGATE COMPUTATION — runs for both vSAN and VMFS/NFS paths
    // ══════════════════════════════════════════════════════════════════════════
    var agg = result.aggregate;
    var hostIds = [];
    for (var hk in result.perHost) hostIds.push(hk);

    if (hostIds.length > 0) {
        var sumR = 0, sumW = 0, countR = 0, countW = 0;
        var maxR = 0, maxW = 0;
        var sumIopsR = 0, sumIopsW = 0;
        var sumCong = 0, maxCong = 0, countCong = 0;
        var hotHost       = null;
        var hotLatencySum = 0;
        var realTimeCount = 0;
        var rollupCount   = 0;

        for (var idx = 0; idx < hostIds.length; idx++) {
            var hid = hostIds[idx];
            var hm  = result.perHost[hid];

            if (hm.intervalUsed === 20 || hm.intervalUsed === 2) {
                realTimeCount++;
            } else if (hm.intervalUsed === 300) {
                rollupCount++;
            }

            if (hm.readLatencyMs !== null) {
                sumR += hm.readLatencyMs; countR++;
                if (hm.readLatencyMs > maxR) maxR = hm.readLatencyMs;
            }
            if (hm.writeLatencyMs !== null) {
                sumW += hm.writeLatencyMs; countW++;
                if (hm.writeLatencyMs > maxW) maxW = hm.writeLatencyMs;
            }
            if (hm.iopsRead  !== null) sumIopsR += hm.iopsRead;
            if (hm.iopsWrite !== null) sumIopsW += hm.iopsWrite;

            if (hm.vsanCongestion !== null) {
                sumCong += hm.vsanCongestion; countCong++;
                if (hm.vsanCongestion > maxCong) maxCong = hm.vsanCongestion;
            }

            var combinedLat = (hm.readLatencyMs || 0) + (hm.writeLatencyMs || 0);
            if (combinedLat > hotLatencySum) {
                hotLatencySum = combinedLat;
                hotHost       = hid;
            }
        }

        agg.hostsSampled      = hostIds.length;
        agg.hostsAtRealTime   = realTimeCount;
        agg.hostsAtRollup     = rollupCount;
        agg.avgReadLatencyMs  = countR > 0 ? Math.round((sumR / countR) * 10) / 10 : null;
        agg.avgWriteLatencyMs = countW > 0 ? Math.round((sumW / countW) * 10) / 10 : null;
        agg.maxReadLatencyMs  = countR > 0 ? Math.round(maxR * 10) / 10             : null;
        agg.maxWriteLatencyMs = countW > 0 ? Math.round(maxW * 10) / 10             : null;
        agg.totalIopsRead     = Math.round(sumIopsR);
        agg.totalIopsWrite    = Math.round(sumIopsW);
        agg.hotHost           = hotHost;
        agg.avgVsanCongestion = countCong > 0 ? Math.round(sumCong / countCong) : null;
        agg.maxVsanCongestion = countCong > 0 ? Math.round(maxCong)             : null;
    }

    System.log("getDatastoreMetrics: completed for " + datastoreMoRef +
               " — " + agg.hostsSampled + " hosts sampled (" +
               agg.hostsAtRealTime + " real-time, " +
               agg.hostsAtRollup + " rollup)" +
               " avgR=" + agg.avgReadLatencyMs + "ms" +
               " avgW=" + agg.avgWriteLatencyMs + "ms" +
               " maxR=" + agg.maxReadLatencyMs + "ms" +
               " maxW=" + agg.maxWriteLatencyMs + "ms" +
               " hotHost=" + agg.hotHost);

} catch (e) {
    System.warn("getDatastoreMetrics error for " + datastoreMoRef + ": " + e.message);
}

return JSON.stringify(result);
