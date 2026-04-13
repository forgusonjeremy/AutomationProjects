/**
 * ST-06  PROCESS POWERED-ON VMs (THROTTLED LANE)
 * ─────────────────────────────────────────────────────────────────────────────
 * Processes powered-on and suspended VM snapshots with:
 *   - Per-vCenter concurrency limit (maxParallel simultaneous tasks)
 *   - Full adaptive I/O governor before each deletion
 *   - Complete VM safety checks inside deleteSnapshot action
 *
 * WORKFLOW ATTRIBUTE INPUTS:
 *   onCandidatesJson, runId, runLog, dryRun,
 *   latencyThresholdMs, vsanCongestionThresh, vsanResyncThresholdBytes,
 *   govPollMs, maxParallel, taskTimeoutSeconds
 *
 * WORKFLOW ATTRIBUTE OUTPUTS:
 *   datastoreStateJson, runLog
 */

var LOG = {
    ok:     function(p,m){ System.log(  "[SNAPSHOT-CLEANUP] ["+p+"] [OK]      "+m); },
    skip:   function(p,m){ System.log(  "[SNAPSHOT-CLEANUP] ["+p+"] [SKIP]    "+m); },
    done:   function(p,m){ System.log(  "[SNAPSHOT-CLEANUP] ["+p+"] [DONE]    "+m); },
    dryrun: function(p,m){ System.log(  "[SNAPSHOT-CLEANUP] ["+p+"] [DRY-RUN] "+m); },
    hold:   function(p,m){ System.log(  "[SNAPSHOT-CLEANUP] ["+p+"] [HOLD]    "+m); },
    warn:   function(p,m){ System.warn( "[SNAPSHOT-CLEANUP] ["+p+"] [WARN]    "+m); },
    fail:   function(p,m){ System.error("[SNAPSHOT-CLEANUP] ["+p+"] [FAIL]    "+m); }
};

var MODULE        = "com.company.snapshotcleanup";
var onCands       = JSON.parse(onCandidatesJson || "[]");
var logArr        = JSON.parse(runLog || "[]");
var dsState       = {};

if (onCands.length === 0) {
    LOG.ok("PROCESSING","No powered-on VM snapshots to process.");
} else {
    // Build vCenter connection lookup
    var vcLookup = {};
    for each (var sdk in VcPlugin.allSdkConnections)
        vcLookup[sdk.name || sdk.url] = sdk;

    // Group by vCenter
    var byVC = {};
    for each (var c in onCands) {
        if (!byVC[c.vcenterName]) byVC[c.vcenterName] = [];
        byVC[c.vcenterName].push(c);
    }

    for (var vcKey in byVC) {
        var queue  = byVC[vcKey];
        var vcConn = vcLookup[vcKey];
        if (!vcConn) {
            LOG.fail("PROCESSING","Cannot connect to vCenter '" + vcKey + "' -- skipping all its snapshots.");
            continue;
        }
        LOG.ok("PROCESSING","Processing " + queue.length + " powered-on snapshot(s) on " + vcKey);

        var inFlight = 0;
        for (var i = 0; i < queue.length; i++) {
            var cand   = queue[i];
            var dsRefs = cand.datastoreMoRefs || [];
            var label  = "VM '" + cand.vmName + "'  snapshot '" + cand.snapshotName
                       + "'  (age: " + cand.snapshotAgeMinutes + " min)";

            // Concurrency throttle
            while (inFlight >= maxParallel) {
                System.sleep(2000);
                inFlight = Math.max(0, inFlight - 1);
            }

            // I/O governor pre-check
            var govOk = checkGovernor(vcConn, dsRefs, cand.vmName);
            if (!govOk) {
                var attempts = 0;
                while (!govOk && attempts < 120) {
                    LOG.hold("PROCESSING","Storage I/O is too high to safely start another cleanup right now. "
                            +"Waiting " + Math.round(govPollMs/1000) + "s before retrying...  "
                            +"(attempt " + (attempts+1) + " of 120 max)  --  " + label);
                    System.sleep(govPollMs);
                    attempts++;
                    govOk = checkGovernor(vcConn, dsRefs, cand.vmName);
                }
                if (!govOk) {
                    LOG.warn("PROCESSING","Waited too long for storage to settle -- deferring to next run:  " + label);
                    logArr.push(makeEntry(cand,"deferred",false,"Storage I/O governor max wait exceeded",null,0));
                    continue;
                }
                LOG.ok("PROCESSING","Storage I/O has settled -- proceeding with cleanup:  " + label);
            }

            // Execute
            inFlight++;
            var res = JSON.parse(System.getModule(MODULE).deleteSnapshot(
                vcConn, cand.vmMoRef, cand.snapshotMoRef,
                cand.snapshotName, cand.vmName,
                JSON.stringify(dsRefs), dryRun, taskTimeoutSeconds || 1800));
            inFlight = Math.max(0, inFlight - 1);

            if (!dryRun && res.success && !res.skipped)
                updateState(JSON.parse(res.preMetricsJson  || "[]"),
                            JSON.parse(res.postMetricsJson || "[]"));

            if (dryRun && !res.skipped) {
                LOG.dryrun("PROCESSING","Would delete:  " + label);
                logArr.push(makeEntry(cand,"dry_run",true,null,null,res.durationMs));
            } else if (res.skipped) {
                LOG.skip("PROCESSING","Skipped:  " + label + "  --  Reason: " + res.skipReason);
                logArr.push(makeEntry(cand,"skipped",false,res.skipReason,null,res.durationMs));
            } else if (res.success) {
                LOG.done("PROCESSING","Deleted:  " + label
                        + "  (took " + Math.round(res.durationMs/1000) + "s)");
                logArr.push(makeEntry(cand,"deleted",true,null,null,res.durationMs));
            } else {
                LOG.fail("PROCESSING","Failed to delete:  " + label + "  --  " + res.error);
                logArr.push(makeEntry(cand,"error",false,null,res.error,res.durationMs));
            }
        }
    }
    LOG.ok("PROCESSING","Powered-on VM lane complete.");
}

datastoreStateJson = JSON.stringify(dsState);
runLog = JSON.stringify(logArr);

// ── Helpers ──────────────────────────────────────────────────────────────────

function checkGovernor(vcConn, dsRefs, vmName) {
    if (!dsRefs || dsRefs.length === 0) return true;
    var curr = [], pre = [], post = [];
    for each (var r in dsRefs) {
        try { curr.push(JSON.parse(System.getModule(MODULE).getDatastoreMetrics(vcConn, r))); }
        catch (e) { LOG.warn("PROCESSING","Could not read storage metrics for datastore " + r + ": " + e.message); }
        var st = dsState[r];
        if (st) { if (st.lastPre) pre.push(st.lastPre); if (st.lastPost) post.push(st.lastPost); }
    }
    var g = JSON.parse(System.getModule(MODULE).adaptiveGovernorCheck(
        JSON.stringify(curr), JSON.stringify(pre), JSON.stringify(pre), JSON.stringify(post),
        latencyThresholdMs || 30, vsanCongestionThresh || 50,
        vsanResyncThresholdBytes || 10737418240));
    if (!g.approved)
        LOG.hold("PROCESSING","Storage governor says WAIT for VM '" + vmName + "': " + g.reason);
    return g.approved;
}

function updateState(preArr, postArr) {
    for each (var p in preArr) {
        if (!dsState[p.datastoreMoRef]) dsState[p.datastoreMoRef] = {};
        dsState[p.datastoreMoRef].lastPre = p;
    }
    for each (var p2 in postArr) {
        if (!dsState[p2.datastoreMoRef]) dsState[p2.datastoreMoRef] = {};
        dsState[p2.datastoreMoRef].lastPost = p2;
    }
}

function makeEntry(c, action, success, skipReason, error, durationMs) {
    return {
        timestampMs:new Date().getTime(), runId:runId,
        vCenter:c.vcenterName||"", vmName:c.vmName||"",
        vmPowerState:c.vmPowerState||"", snapshotName:c.snapshotName||"",
        snapshotDesc:c.snapshotDesc||"", snapshotAgeMinutes:c.snapshotAgeMinutes||0,
        action:action, success:success, skipReason:skipReason||null,
        datastoreMoRefs:c.datastoreMoRefs||[], durationMs:durationMs||0,
        error:error||null
    };
}
