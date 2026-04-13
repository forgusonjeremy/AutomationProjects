/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ST-07  PROCESS POWERED-OFF VMs  (FAST LANE)
 * ─────────────────────────────────────────────────────────────────────────────
 * Processes powered-off VM snapshots. No per-VM concurrency limit
 * (no guest stun lock risk), but still fully governed by I/O governor.
 * Inherits governor calibration state from ST-06.
 *
 * ── INPUTS ───────────────────────────────────────────────────────────────────
 *   Name                     vRO Type   Source
 *   ──────────────────────────────────────────────────────────────────────────
 *   offCandidatesJson        string     Attribute: offCandidatesJson
 *   datastoreStateJson       string     Attribute: datastoreStateJson  (from ST-06)
 *   runId                    string     Attribute: runId
 *   runLog                   string     Attribute: runLog
 *   dryRun                   boolean    Workflow Input: dryRun
 *   latencyThresholdMs       number     Workflow Input: latencyThresholdMs
 *   vsanCongestionThresh     number     Workflow Input: vsanCongestionThresh
 *   vsanResyncThresholdBytes number     Attribute: vsanResyncThresholdBytes
 *   govPollMs                number     Attribute: govPollMs
 *   taskTimeoutSeconds       number     Workflow Input: taskTimeoutSeconds
 *
 * ── OUTPUTS ──────────────────────────────────────────────────────────────────
 *   Name                vRO Type   Description
 *   ──────────────────────────────────────────────────────────────────────────
 *   runLog              string     Final JSON array passed to ST-09 for tallying
 *   datastoreStateJson  string     Updated governor calibration state
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

var MODULE   = "com.company.snapshotcleanup";
var offCands = JSON.parse(offCandidatesJson || "[]");
var logArr   = JSON.parse(runLog || "[]");
var dsState  = JSON.parse(datastoreStateJson || "{}");

if (offCands.length === 0) {
    LOG.ok("PROCESSING","No powered-off VM snapshots to process.");
} else {
    LOG.ok("PROCESSING","Processing " + offCands.length + " powered-off VM snapshot(s) (fast lane)...");

    var vcLookup = {};
    for each (var sdk in VcPlugin.allSdkConnections)
        vcLookup[sdk.name || sdk.url] = sdk;

    for (var i = 0; i < offCands.length; i++) {
        var cand   = offCands[i];
        var dsRefs = cand.datastoreMoRefs || [];
        var vcConn = vcLookup[cand.vcenterName];
        var label  = "VM '" + cand.vmName + "'  snapshot '" + cand.snapshotName
                   + "'  (age: " + cand.snapshotAgeMinutes + " min)  [powered OFF]";

        if (!vcConn) {
            LOG.fail("PROCESSING","Cannot connect to vCenter '" + cand.vcenterName + "' -- skipping:  " + label);
            logArr.push(makeEntry(cand,"skipped",false,"vCenter connection not found",null,0));
            continue;
        }

        // I/O governor
        var govOk = checkGovernor(vcConn, dsRefs, cand.vmName);
        if (!govOk) {
            var attempts = 0;
            while (!govOk && attempts < 120) {
                LOG.hold("PROCESSING","Storage I/O is too high -- waiting " + Math.round(govPollMs/1000)
                        + "s before retrying...  (attempt " + (attempts+1) + " of 120)  --  " + label);
                System.sleep(govPollMs);
                attempts++;
                govOk = checkGovernor(vcConn, dsRefs, cand.vmName);
            }
            if (!govOk) {
                LOG.warn("PROCESSING","Waited too long -- deferring to next run:  " + label);
                logArr.push(makeEntry(cand,"deferred",false,"Storage I/O governor max wait exceeded",null,0));
                continue;
            }
            LOG.ok("PROCESSING","Storage I/O settled -- proceeding:  " + label);
        }

        var res = JSON.parse(System.getModule(MODULE).deleteSnapshot(
            vcConn, cand.vmMoRef, cand.snapshotMoRef,
            cand.snapshotName, cand.vmName,
            JSON.stringify(dsRefs), dryRun, taskTimeoutSeconds || 1800));

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
            LOG.done("PROCESSING","Deleted:  " + label + "  (took " + Math.round(res.durationMs/1000) + "s)");
            logArr.push(makeEntry(cand,"deleted",true,null,null,res.durationMs));
        } else {
            LOG.fail("PROCESSING","Failed to delete:  " + label + "  --  " + res.error);
            logArr.push(makeEntry(cand,"error",false,null,res.error,res.durationMs));
        }
    }
    LOG.ok("PROCESSING","Powered-off VM fast lane complete.");
}

datastoreStateJson = JSON.stringify(dsState);
runLog = JSON.stringify(logArr);

function checkGovernor(vcConn, dsRefs, vmName) {
    if (!dsRefs || dsRefs.length === 0) return true;
    var curr = [], pre = [], post = [];
    for each (var r in dsRefs) {
        try { curr.push(JSON.parse(System.getModule(MODULE).getDatastoreMetrics(vcConn, r))); }
        catch (e) { LOG.warn("PROCESSING","Could not read storage metrics for " + r + ": " + e.message); }
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
