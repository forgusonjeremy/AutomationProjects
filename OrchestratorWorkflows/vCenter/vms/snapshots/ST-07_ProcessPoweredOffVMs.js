/**
 * ST-07  PROCESS POWERED-OFF VMs (FAST LANE)
 * ─────────────────────────────────────────────────────────────────────────────
 * Processes powered-off VM candidates. No per-VM concurrency limit (no stun
 * lock risk), but still fully governed by the adaptive I/O governor.
 * Inherits datastoreState calibration from ST-06.
 *
 * WORKFLOW ATTRIBUTE INPUTS:
 *   offCandidatesJson, datastoreStateJson, runId, runLog, dryRun,
 *   latencyThresholdMs, vsanCongestionThresh, vsanResyncThresholdBytes,
 *   govPollMs, taskTimeoutSeconds
 *
 * WORKFLOW ATTRIBUTE OUTPUTS:
 *   runLog (string — final, passed to ST-09)
 *   datastoreStateJson (string — updated)
 */

var MODULE         = "com.company.snapshotcleanup";
var offCandidates  = JSON.parse(offCandidatesJson  || "[]");
var logEntries     = JSON.parse(runLog || "[]");
var datastoreState = JSON.parse(datastoreStateJson || "{}");

System.log("[ST-07] Processing " + offCandidates.length + " powered-off candidate(s).");

if (offCandidates.length > 0) {

    var vcLookup = {};
    for each (var sdk in VcPlugin.allSdkConnections)
        vcLookup[sdk.name || sdk.url] = sdk;

    for (var i = 0; i < offCandidates.length; i++) {
        var cand   = offCandidates[i];
        var dsRefs = cand.datastoreMoRefs || [];
        var vcConn = vcLookup[cand.vcenterName];

        if (!vcConn) {
            System.error("[ST-07] Cannot resolve SDK for: " + cand.vcenterName);
            logEntries.push(makeEntry(cand, "skipped", false,
                                      "vCenter connection not found", null, 0));
            continue;
        }

        var approved = checkGovernor(vcConn, dsRefs, cand.vmName);
        if (!approved) {
            var attempts = 0;
            while (!approved && attempts < 120) {
                System.log("[ST-07] Governor HOLD (off): VM=" + cand.vmName +
                           " attempt " + (attempts + 1) + "/120");
                System.sleep(govPollMs);
                attempts++;
                approved = checkGovernor(vcConn, dsRefs, cand.vmName);
            }
            if (!approved) {
                System.warn("[ST-07] Governor max wait exceeded (off): VM=" + cand.vmName);
                logEntries.push(makeEntry(cand, "deferred", false,
                                          "Governor max wait exceeded", null, 0));
                continue;
            }
        }

        var res = JSON.parse(System.getModule(MODULE).deleteSnapshot(
            vcConn, cand.vmMoRef, cand.snapshotMoRef,
            cand.snapshotName, cand.vmName,
            JSON.stringify(dsRefs), dryRun, taskTimeoutSeconds || 1800));

        if (!dryRun && res.success && !res.skipped)
            updateState(JSON.parse(res.preMetricsJson  || "[]"),
                        JSON.parse(res.postMetricsJson || "[]"));

        var action = dryRun ? "dry_run"
                   : res.skipped ? "skipped"
                   : res.success ? "deleted" : "error";
        logEntries.push(makeEntry(cand, action,
            res.success || (dryRun && !res.skipped),
            res.skipReason, res.error, res.durationMs));
    }
}

datastoreStateJson = JSON.stringify(datastoreState);
runLog = JSON.stringify(logEntries);
System.log("[ST-07] Powered-off fast lane complete.");

function checkGovernor(vcConn, dsRefs, vmName) {
    if (!dsRefs || dsRefs.length === 0) return true;
    var curr = [], pre = [], post = [];
    for each (var r in dsRefs) {
        try { curr.push(JSON.parse(System.getModule(MODULE).getDatastoreMetrics(vcConn, r))); }
        catch (e) { System.warn("[ST-07] Cannot sample datastore " + r + ": " + e.message); }
        var st = datastoreState[r];
        if (st) { if (st.lastPre) pre.push(st.lastPre); if (st.lastPost) post.push(st.lastPost); }
    }
    var g = JSON.parse(System.getModule(MODULE).adaptiveGovernorCheck(
        JSON.stringify(curr), JSON.stringify(pre), JSON.stringify(pre), JSON.stringify(post),
        latencyThresholdMs || 30, vsanCongestionThresh || 50,
        vsanResyncThresholdBytes || 10737418240));
    if (!g.approved) System.log("[ST-07] Governor DENY (off) VM=" + vmName + ": " + g.reason);
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
