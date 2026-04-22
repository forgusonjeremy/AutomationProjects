/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ST-06  PROCESS POWERED-ON VMs  (THROTTLED LANE)
 * ─────────────────────────────────────────────────────────────────────────────
 * Processes snapshots on powered-on and suspended VMs. For each candidate:
 *   1. Enforces per-vCenter concurrency limit (maxParallel simultaneous tasks).
 *   2. Runs adaptive I/O governor pre-check — waits if storage is too busy.
 *   3. Calls deleteSnapshot action which performs VM safety checks and executes
 *      the vCenter task.
 *   4. Captures pre/post I/O metrics for governor self-calibration.
 *   5. Appends a log entry to runLog for each outcome.
 *
 * Governor calibration state (datastoreStateJson) is passed to ST-07 so the
 * powered-off fast lane inherits the observed impact deltas from this lane and
 * does not have to start calibrating from scratch on shared datastores.
 *
 * ── INPUTS ───────────────────────────────────────────────────────────────────
 *   Name                     vRO Type  Source / Description
 *   ─────────────────────────────────────────────────────────────────────────────────────────────
 *   onCandidatesJson         string    Attribute: onCandidatesJson
 *                                      Chain-ordered list of powered-on/suspended VM snapshots
 *                                      from ST-05.
 *   runId                    string    Attribute: runId
 *                                      Included in each log entry so every action can be
 *                                      traced back to this specific run.
 *   runLog                   string    Attribute: runLog
 *                                      Accumulates one entry per snapshot processed.
 *                                      Passed forward to ST-07 and finally ST-09.
 *   dryRun                   boolean   Workflow Input: dryRun
 *                                      When true, deleteSnapshot logs [DRY-RUN] and returns
 *                                      immediately without submitting a vCenter task.
 *   latencyThresholdMs       number    Workflow Input: latencyThresholdMs
 *                                      VMFS/NFS governor ceiling. The governor projects
 *                                      current + observed delta; if projection exceeds this
 *                                      value the next task is held until I/O settles.
 *   vsanCongestionThresh     number    Workflow Input: vsanCongestionThresh
 *                                      vSAN congestion governor ceiling (0-255).
 *   vsanResyncThresholdBytes number    Attribute: vsanResyncThresholdBytes
 *                                      vSAN resync queue ceiling in bytes (converted by ST-01).
 *   govPollMs                number    Attribute: govPollMs
 *                                      Milliseconds between governor re-checks when a task
 *                                      is on hold (converted by ST-01).
 *   maxParallel              number    Attribute: maxParallel
 *                                      Maximum concurrent consolidation tasks per vCenter
 *                                      for powered-on VMs (validated by ST-01).
 *   taskTimeoutSeconds       number    Workflow Input: taskTimeoutSeconds
 *                                      Passed to deleteSnapshot. Maximum seconds to wait
 *                                      for the vCenter removal task to reach success or error.
 *
 * ── OUTPUTS ──────────────────────────────────────────────────────────────────
 *   Name                vRO Type  Description
 *   ─────────────────────────────────────────────────────────────────────────────────────────────
 *   datastoreStateJson  string    JSON object keyed by datastore MoRef. Each entry holds
 *                                 lastPre and lastPost metric snapshots from the most recent
 *                                 consolidation on that datastore. Passed to ST-07 so the
 *                                 fast lane inherits calibration data from this lane.
 *   runLog              string    Updated JSON array. Contains one entry per snapshot
 *                                 processed, with action, success flag, skip reason,
 *                                 duration, and any error message.
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

var MODULE        = "com.broadcom.pso.vc.vm.snapshots";
var STORAGEMODULE = "com.broadcom.pso.vc.storage";
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

        // ── Async parallel dispatch ───────────────────────────────────────────
        // System.getModule().action() calls are fully blocking in vRO Polyglot.
        // True parallelism requires launching the deleteSnapshot action inside
        // a child workflow asynchronously using Server.getWorkflow() and
        // workflow.execute() which returns immediately with a token that can
        // be polled via Server.getWorkflowToken().
        //
        // Each in-flight task is tracked as an object in the inFlightSlots
        // array:  { token, cand, label, startMs }
        // The dispatch loop fills slots up to maxParallel, then polls all
        // active tokens, harvests completed ones, and continues.

        var WRAPPER_WF_NAME = "Adaptive Snapshot Delete Task";

        // Locate the single-task wrapper workflow by name
        var wfList    = Server.getWorkflows(WRAPPER_WF_NAME);
        var wrapperWf = (wfList && wfList.length > 0) ? wfList[0] : null;

        if (!wrapperWf) {
            // Fallback: synchronous execution if wrapper workflow variable is
            // not bound. Bind the wrapper workflow via the workflow attribute
            // picker in the vRO designer to enable parallel dispatch.
            LOG.warn("PROCESSING",
                "Wrapper workflow attribute is not bound -- " +
                "falling back to sequential execution.");
        }

        var inFlightSlots = [];  // { token, cand, label, startMs }
        var qi = 0;

        while (qi < queue.length || inFlightSlots.length > 0) {

            // ── Harvest completed slots ───────────────────────────────────────
            var stillActive = [];
            for (var si = 0; si < inFlightSlots.length; si++) {
                var slot  = inFlightSlots[si];
                var state = slot.token.state;  // "running","completed","failed","canceled"

                if (state === "running") {
                    stillActive.push(slot);
                    continue;
                }

                // Slot finished -- extract result
                var res = null;
                try {
                    var outAttrs = slot.token.outputParameters;
                    for (var oi = 0; oi < outAttrs.length; oi++) {
                        if (outAttrs[oi].name === "resultJson") {
                            res = JSON.parse(outAttrs[oi].value);
                            break;
                        }
                    }
                } catch (te) {
                    System.warn("ST-06: could not read output from slot for " +
                                slot.label + ": " + te.message);
                }

                if (!res) {
                    res = { success: false, skipped: false,
                            error: "Could not read workflow output",
                            durationMs: new Date().getTime() - slot.startMs,
                            preMetricsJson: "[]", postMetricsJson: "[]" };
                }

                if (!dryRun && res.success && !res.skipped)
                    updateState(JSON.parse(res.preMetricsJson  || "[]"),
                                JSON.parse(res.postMetricsJson || "[]"));

                if (dryRun && !res.skipped) {
                    LOG.dryrun("PROCESSING","Would delete:  " + slot.label);
                    logArr.push(makeEntry(slot.cand,"dry_run",true,null,null,res.durationMs));
                } else if (res.skipped) {
                    LOG.skip("PROCESSING","Skipped:  " + slot.label +
                             "  --  Reason: " + res.skipReason);
                    logArr.push(makeEntry(slot.cand,"skipped",false,
                                res.skipReason,null,res.durationMs));
                } else if (res.success) {
                    LOG.done("PROCESSING","Deleted:  " + slot.label +
                             "  (took " + Math.round(res.durationMs/1000) + "s)");
                    logArr.push(makeEntry(slot.cand,"deleted",true,null,null,res.durationMs));
                } else {
                    LOG.fail("PROCESSING","Failed to delete:  " + slot.label +
                             "  --  " + res.error);
                    logArr.push(makeEntry(slot.cand,"error",false,null,res.error,res.durationMs));
                }
            }
            inFlightSlots = stillActive;

            // ── Dispatch new tasks up to maxParallel ──────────────────────────
            while (qi < queue.length && inFlightSlots.length < maxParallel) {
                var cand   = queue[qi++];
                var dsRefs = cand.datastoreMoRefs || [];
                var label  = "VM '" + cand.vmName + "'  snapshot '" +
                             cand.snapshotName + "'  (age: " +
                             cand.snapshotAgeMinutes + " min)";

                // I/O governor pre-check
                var govOk = checkGovernor(vcConn, dsRefs, cand.vmName);
                if (!govOk) {
                    var attempts = 0;
                    while (!govOk && attempts < 120) {
                        LOG.hold("PROCESSING",
                            "Storage I/O is too high to safely start another cleanup. " +
                            "Waiting " + Math.round(govPollMs/1000) + "s...  " +
                            "(attempt " + (attempts+1) + " of 120)  --  " + label);
                        System.sleep(govPollMs);
                        attempts++;
                        govOk = checkGovernor(vcConn, dsRefs, cand.vmName);
                    }
                    if (!govOk) {
                        LOG.warn("PROCESSING",
                            "Waited too long for storage to settle -- deferring:  " + label);
                        logArr.push(makeEntry(cand,"deferred",false,
                            "Storage I/O governor max wait exceeded",null,0));
                        continue;
                    }
                    LOG.ok("PROCESSING","Storage settled -- proceeding:  " + label);
                }

                if (wrapperWf) {
                    // Async dispatch via wrapper workflow
                    var props = new Properties();
                    props.put("vcenterSdkConnection", vcConn);
                    props.put("vmMoRef",              cand.vmMoRef);
                    props.put("snapshotMoRef",        cand.snapshotMoRef);
                    props.put("snapshotName",         cand.snapshotName);
                    props.put("vmName",               cand.vmName);
                    props.put("datastoreMoRefsJson",  JSON.stringify(dsRefs));
                    props.put("dryRun",               dryRun);
                    props.put("taskTimeoutSeconds",   taskTimeoutSeconds || 1800);

                    var token = wrapperWf.execute(props);
                    inFlightSlots.push({
                        token:   token,
                        cand:    cand,
                        label:   label,
                        startMs: new Date().getTime()
                    });
                    LOG.ok("PROCESSING","Dispatched (async):  " + label);
                } else {
                    // Synchronous fallback
                    var res2 = JSON.parse(System.getModule(MODULE)._deleteSnapshot(
                        vcConn, cand.vmMoRef, cand.snapshotMoRef,
                        cand.snapshotName, cand.vmName,
                        JSON.stringify(dsRefs), dryRun, taskTimeoutSeconds || 1800));

                    if (!dryRun && res2.success && !res2.skipped)
                        updateState(JSON.parse(res2.preMetricsJson  || "[]"),
                                    JSON.parse(res2.postMetricsJson || "[]"));

                    if (dryRun && !res2.skipped) {
                        LOG.dryrun("PROCESSING","Would delete:  " + label);
                        logArr.push(makeEntry(cand,"dry_run",true,null,null,res2.durationMs));
                    } else if (res2.skipped) {
                        LOG.skip("PROCESSING","Skipped:  " + label +
                                 "  --  Reason: " + res2.skipReason);
                        logArr.push(makeEntry(cand,"skipped",false,
                                    res2.skipReason,null,res2.durationMs));
                    } else if (res2.success) {
                        LOG.done("PROCESSING","Deleted:  " + label +
                                 "  (took " + Math.round(res2.durationMs/1000) + "s)");
                        logArr.push(makeEntry(cand,"deleted",true,null,null,res2.durationMs));
                    } else {
                        LOG.fail("PROCESSING","Failed to delete:  " + label +
                                 "  --  " + res2.error);
                        logArr.push(makeEntry(cand,"error",false,null,res2.error,res2.durationMs));
                    }
                }
            }

            // ── Sleep before next harvest/dispatch cycle ──────────────────────
            if (inFlightSlots.length > 0) {
                System.sleep(3000);
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
        try { curr.push(JSON.parse(System.getModule(STORAGEMODULE)._getDatastoreMetrics(vcConn, r))); }
        catch (e) { LOG.warn("PROCESSING","Could not read storage metrics for datastore " + r + ": " + e.message); }
        var st = dsState[r];
        if (st) { if (st.lastPre) pre.push(st.lastPre); if (st.lastPost) post.push(st.lastPost); }
    }
    var g = JSON.parse(System.getModule(STORAGEMODULE)._adaptiveGovernorCheck(
        JSON.stringify(curr), JSON.stringify(pre), JSON.stringify(post),
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
