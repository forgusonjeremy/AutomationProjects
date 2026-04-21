/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ST-07 PROCESS POWERED-OFF VMs  (FAST LANE)
 * ─────────────────────────────────────────────────────────────────────────────
 * Processes snapshots on powered-off VMs. Because powered-off VMs have no
 * running guest workload there is no stun lock risk, so no per-VM concurrency
 * limit is applied. However, consolidation still generates storage I/O on
 * shared datastores, so the full adaptive I/O governor still runs before
 * each task.
 *
 * This task inherits the governor calibration state from ST-06. If a datastore
 * was already calibrated during the powered-on lane, the observed I/O delta from
 * that lane is used immediately here rather than having to re-learn it.
 *
 * ── INPUTS ───────────────────────────────────────────────────────────────────
 *   Name                     vRO Type  Source / Description
 *   ─────────────────────────────────────────────────────────────────────────────────────────────
 *   offCandidatesJson        string    Attribute: offCandidatesJson
 *                                      Chain-ordered list of powered-off VM snapshots from ST-05.
 *   datastoreStateJson       string    Attribute: datastoreStateJson
 *                                      Governor calibration state produced by ST-06. Contains
 *                                      pre/post I/O metric pairs per datastore. Parsed and
 *                                      used immediately so this lane does not start blind.
 *   runId                    string    Attribute: runId
 *                                      Included in each log entry for run traceability.
 *   runLog                   string    Attribute: runLog
 *                                      Accumulates log entries from this lane. Final value
 *                                      is passed to ST-09 for result tallying.
 *   dryRun                   boolean   Workflow Input: dryRun
 *                                      When true, no deletions are performed.
 *   latencyThresholdMs       number    Workflow Input: latencyThresholdMs
 *                                      VMFS/NFS I/O governor ceiling in milliseconds.
 *   vsanCongestionThresh     number    Workflow Input: vsanCongestionThresh
 *                                      vSAN congestion governor ceiling (0-255).
 *   vsanResyncThresholdBytes number    Attribute: vsanResyncThresholdBytes
 *                                      vSAN resync queue ceiling in bytes (converted by ST-01).
 *   govPollMs                number    Attribute: govPollMs
 *                                      Milliseconds between governor re-checks when on hold.
 *   taskTimeoutSeconds       number    Workflow Input: taskTimeoutSeconds
 *                                      Maximum seconds to wait for each vCenter removal task.
 *
 * ── OUTPUTS ──────────────────────────────────────────────────────────────────
 *   Name                vRO Type  Description
 *   ─────────────────────────────────────────────────────────────────────────────────────────────
 *   runLog              string    Final JSON array containing all log entries from both
 *                                 ST-06 and this task combined. Passed to ST-09 for tallying
 *                                 and inclusion in the result summary.
 *   datastoreStateJson  string    Updated governor calibration state including any new
 *                                 pre/post metric pairs observed during this lane.
 *                                 Informational at this point — the run ends after ST-09.
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

        var res = JSON.parse(System.getModule(MODULE)._deleteSnapshot(
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
