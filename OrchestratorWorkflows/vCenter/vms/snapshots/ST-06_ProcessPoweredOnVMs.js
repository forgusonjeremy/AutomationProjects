/**
 * ST-06  PROCESS POWERED-ON VMs (THROTTLED LANE)
 * ─────────────────────────────────────────────────────────────────────────────
 * Processes powered-on / suspended VM candidates with:
 *   - Per-vCenter grouping and sequential processing
 *   - Per-vCenter concurrency limit (maxParallel)
 *   - Full adaptive I/O governor pre-check before each task
 *   - Full VM safety checks inside deleteSnapshot action
 *
 * Governor calibration state (pre/post metrics) is accumulated in
 * datastoreStateJson and passed to ST-07 so the fast lane inherits it.
 *
 * WORKFLOW ATTRIBUTE INPUTS:
 *   onCandidatesJson, runId, runLog, dryRun,
 *   latencyThresholdMs, vsanCongestionThresh, vsanResyncThresholdBytes,
 *   govPollMs, maxParallel, taskTimeoutSeconds
 *
 * WORKFLOW ATTRIBUTE OUTPUTS:
 *   datastoreStateJson (string), runLog (string — updated)
 */

var MODULE        = "com.company.snapshotcleanup";
var onCandidates  = JSON.parse(onCandidatesJson || "[]");
var logEntries    = JSON.parse(runLog || "[]");
var datastoreState = {};

System.log("[ST-06] Processing " + onCandidates.length + " powered-on candidate(s).");

if (onCandidates.length > 0) {

    // Build SDK connection lookup
    var vcLookup = {};
    for each (var sdk in VcPlugin.allSdkConnections)
        vcLookup[sdk.name || sdk.url] = sdk;

    // Group by vCenter
    var byVC = {};
    for each (var c in onCandidates) {
        if (!byVC[c.vcenterName]) byVC[c.vcenterName] = [];
        byVC[c.vcenterName].push(c);
    }

    for (var vcKey in byVC) {
        var queue  = byVC[vcKey];
        var vcConn = vcLookup[vcKey];
        if (!vcConn) {
            System.error("[ST-06] Cannot resolve SDK for: " + vcKey + " — skipping queue.");
            continue;
        }
        System.log("[ST-06] vCenter " + vcKey + " — " + queue.length + " candidate(s)");

        var inFlight = 0;
        for (var i = 0; i < queue.length; i++) {
            var cand   = queue[i];
            var dsRefs = cand.datastoreMoRefs || [];

            while (inFlight >= maxParallel) {
                System.sleep(2000);
                inFlight = Math.max(0, inFlight - 1);
            }

            var approved = checkGovernor(vcConn, dsRefs, cand.vmName);
            if (!approved) {
                var attempts = 0;
                while (!approved && attempts < 120) {
                    System.log("[ST-06] Governor HOLD: VM=" + cand.vmName +
                               " attempt " + (attempts + 1) + "/120");
                    System.sleep(govPollMs);
                    attempts++;
                    approved = checkGovernor(vcConn, dsRefs, cand.vmName);
                }
                if (!approved) {
                    System.warn("[ST-06] Governor max wait exceeded: VM=" + cand.vmName);
                    logEntries.push(makeEntry(cand, "deferred", false,
                                              "Governor max wait exceeded", null, 0));
                    continue;
                }
            }

            inFlight++;
            var res = JSON.parse(System.getModule(MODULE).deleteSnapshot(
                vcConn, cand.vmMoRef, cand.snapshotMoRef,
                cand.snapshotName, cand.vmName,
                JSON.stringify(dsRefs), dryRun, taskTimeoutSeconds || 1800));
            inFlight = Math.max(0, inFlight - 1);

            if (!dryRun && res.success && !res.skipped) {
                updateState(JSON.parse(res.preMetricsJson  || "[]"),
                            JSON.parse(res.postMetricsJson || "[]"));
            }

            var action = dryRun ? "dry_run"
                       : res.skipped ? "skipped"
                       : res.success ? "deleted" : "error";
            logEntries.push(makeEntry(cand, action,
                res.success || (dryRun && !res.skipped),
                res.skipReason, res.error, res.durationMs));
        }
    }
}

datastoreStateJson = JSON.stringify(datastoreState);
runLog = JSON.stringify(logEntries);
System.log("[ST-06] Powered-on lane complete.");

// ── Helpers ──────────────────────────────────────────────────────────────────

function checkGovernor(vcConn, dsRefs, vmName) {
    if (!dsRefs || dsRefs.length === 0) return true;
    var curr = [], pre = [], post = [];
    for each (var r in dsRefs) {
        try { curr.push(JSON.parse(System.getModule(MODULE).getDatastoreMetrics(vcConn, r))); }
        catch (e) { System.warn("[ST-06] Cannot sample datastore " + r + ": " + e.message); }
        var st = datastoreState[r];
        if (st) { if (st.lastPre) pre.push(st.lastPre); if (st.lastPost) post.push(st.lastPost); }
    }
    var g = JSON.parse(System.getModule(MODULE).adaptiveGovernorCheck(
        JSON.stringify(curr), JSON.stringify(pre), JSON.stringify(pre), JSON.stringify(post),
        latencyThresholdMs || 30, vsanCongestionThresh || 50,
        vsanResyncThresholdBytes || 10737418240));
    if (!g.approved) System.log("[ST-06] Governor DENY VM=" + vmName + ": " + g.reason);
    return g.approved;
}

function updateState(preArr, postArr) {
    for each (var p in preArr) {
        if (!datastoreState[p.datastoreMoRef]) datastoreState[p.datastoreMoRef] = {};
        datastoreState[p.datastoreMoRef].lastPre = p;
    }
    for each (var p2 in postArr) {
        if (!datastoreState[p2.datastoreMoRef]) datastoreState[p2.datastoreMoRef] = {};
        datastoreState[p2.datastoreMoRef].lastPost = p2;
    }
}

function makeEntry(c, action, success, skipReason, error, durationMs) {
    return {
        timestampMs: new Date().getTime(), runId: runId,
        vCenter: c.vcenterName || "", vmName: c.vmName || "",
        vmPowerState: c.vmPowerState || "", snapshotName: c.snapshotName || "",
        snapshotDesc: c.snapshotDesc || "", snapshotAgeMinutes: c.snapshotAgeMinutes || 0,
        action: action, success: success, skipReason: skipReason || null,
        datastoreMoRefs: c.datastoreMoRefs || [], durationMs: durationMs || 0,
        error: error || null
    };
}
