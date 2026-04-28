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

        // ── Adaptive dispatch ─────────────────────────────────────────────
        //
        // RULES (from spec):
        //   1. Only 1 snapshot cleanup per VM at a time (hard constraint, always).
        //   2. Start with 1 concurrent task across all datastores.
        //   3. Before dispatching any additional task, measure the DELTA between
        //      baseline (pre-dispatch) and current (post-dispatch) datastore
        //      performance on the datastores the next candidate uses.
        //   4. If projected latency (current + observed delta) will stay within
        //      threshold → ramp up by 1 and dispatch.
        //   5. If projected latency would exceed threshold → hold until a slot
        //      completes, then re-evaluate.
        //   6. Cap at maxParallel concurrent tasks.
        //
        // inFlightSlots:  active tokens { token, cand, label, startMs, vmMoRef }
        // vmInFlight:     set of vmMoRef values currently being processed
        // currentConcurrency: current allowed concurrency level (ramps 1→maxParallel)

        var inFlightSlots      = [];
        var vmInFlight         = {};   // vmMoRef -> true if a task is active for that VM
        var currentConcurrency = 1;

        // pending holds all candidates not yet dispatched.
        // Entries are only removed when actually dispatched (or deferred due to
        // a governor timeout). Candidates skipped because their VM is in-flight
        // remain in pending and are retried on the next harvest cycle.
        // This is the fix for the qi-pointer bug where vmInFlight skips
        // permanently consumed queue entries for subsequent VM snapshots.
        var pending = queue.slice();

        LOG.ok("PROCESSING", "Starting adaptive dispatch -- initial concurrency: 1 of " +
               maxParallel + " max");

        // Sample baseline metrics for all datastores in the queue before
        // any tasks start. Used to compute deltas after dispatch.
        var dsBaseline = {};
        for (var bi = 0; bi < queue.length; bi++) {
            var bds = queue[bi].datastoreMoRefs || [];
            for (var bdi = 0; bdi < bds.length; bdi++) {
                if (!dsBaseline[bds[bdi]]) {
                    try {
                        dsBaseline[bds[bdi]] = JSON.parse(
                            System.getModule(STORAGEMODULE)
                                ._getDatastoreMetrics(vcConn, bds[bdi]));
                    } catch(be) {
                        // non-fatal -- governor will approve if baseline missing
                    }
                }
            }
        }

        while (pending.length > 0 || inFlightSlots.length > 0) {

            // ── Harvest completed slots ───────────────────────────────────────
            var stillActive    = [];
            var completedCount = 0;

            for (var si = 0; si < inFlightSlots.length; si++) {
                var slot  = inFlightSlots[si];
                var state = slot.token.state;

                if (state === "running") {
                    stillActive.push(slot);
                    continue;
                }

                completedCount++;
                // Free the per-VM lock
                delete vmInFlight[slot.vmMoRef];

                // Extract result
                var res = null;
                try {
                    var rawJson = slot.token.getOutputParameters().get("resultJson");
                    if (rawJson) res = JSON.parse(rawJson);
                } catch (te) {
                    try {
                        var outParams = slot.token.outputParameters;
                        if (outParams && outParams.get) {
                            var rawJson2 = outParams.get("resultJson");
                            if (rawJson2) res = JSON.parse(rawJson2);
                        }
                    } catch (te2) {
                        LOG.warn("PROCESSING", "Could not read output for " +
                                 slot.label + ": " + te.message);
                    }
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
                    LOG.dryrun("PROCESSING", "Would delete:  " + slot.label);
                    logArr.push(makeEntry(slot.cand,"dry_run",true,null,null,res.durationMs));
                } else if (res.skipped) {
                    LOG.skip("PROCESSING", "Skipped:  " + slot.label +
                             "  --  " + res.skipReason);
                    logArr.push(makeEntry(slot.cand,"skipped",false,
                                res.skipReason,null,res.durationMs));
                } else if (res.success) {
                    LOG.done("PROCESSING", "Deleted:  " + slot.label +
                             "  (took " + Math.round(res.durationMs/1000) + "s)");
                    logArr.push(makeEntry(slot.cand,"deleted",true,null,null,res.durationMs));
                } else {
                    LOG.fail("PROCESSING", "Failed to delete:  " + slot.label +
                             "  --  " + res.error);
                    logArr.push(makeEntry(slot.cand,"error",false,null,res.error,res.durationMs));
                }
            }
            inFlightSlots = stillActive;

            // ── After harvest: ramp concurrency if storage permits ────────────
            // Only ramp when slots just completed (we have real post-delete
            // metrics to evaluate), queue still has work, and we're below max.
            if (completedCount > 0 &&
                pending.length > 0 &&
                inFlightSlots.length < maxParallel &&
                currentConcurrency < maxParallel) {

                // Find the next candidate not already being processed on its VM
                var nextIdx = -1;
                for (var ni = 0; ni < pending.length; ni++) {
                    if (!vmInFlight[pending[ni].vmMoRef]) {
                        nextIdx = ni;
                        break;
                    }
                }

                if (nextIdx >= 0) {
                    var nextCand   = pending[nextIdx];
                    var nextDsRefs = nextCand.datastoreMoRefs || [];
                    var govOk      = checkGovernorDelta(vcConn, nextDsRefs,
                                        nextCand.vmName, dsBaseline);
                    if (govOk) {
                        currentConcurrency = Math.min(currentConcurrency + 1, maxParallel);
                        LOG.ok("PROCESSING",
                            "Storage healthy -- ramping concurrency to " +
                            currentConcurrency + " of " + maxParallel);
                    } else {
                        LOG.hold("PROCESSING",
                            "Storage busy -- holding concurrency at " +
                            currentConcurrency + " of " + maxParallel);
                    }
                }
            }

            // ── Dispatch tasks up to currentConcurrency ───────────────────────
            // Hard constraints:
            //   - Total in-flight <= currentConcurrency
            //   - Never dispatch a second task for a VM already in-flight
            // We iterate pending[] by index. When a candidate is dispatched
            // (or permanently deferred) it is spliced out of pending so it is
            // never revisited. When it is skipped due to vmInFlight the index
            // advances but the entry stays in pending for the next cycle.
            var di = 0;
            while (di < pending.length && inFlightSlots.length < currentConcurrency) {
                var cand = pending[di];

                // Skip: this VM already has an active task -- leave in pending,
                // advance index, try the next candidate.
                if (vmInFlight[cand.vmMoRef]) {
                    di++;
                    continue;
                }

                var dsRefs = cand.datastoreMoRefs || [];
                var label  = "VM '" + cand.vmName + "'  snapshot '" +
                             cand.snapshotName + "'  (age: " +
                             cand.snapshotAgeMinutes + " min)";

                // Governor check before dispatch
                var govOk3 = checkGovernorDelta(vcConn, dsRefs,
                                 cand.vmName, dsBaseline);
                if (!govOk3) {
                    if (inFlightSlots.length === 0) {
                        // Nothing running -- wait and retry
                        var holdAttempts = 0;
                        while (!govOk3 && holdAttempts < 120) {
                            LOG.hold("PROCESSING",
                                "Storage too busy to start first task. " +
                                "Waiting " + Math.round(govPollMs/1000) + "s... " +
                                "(attempt " + (holdAttempts+1) + " of 120)  -- " + label);
                            System.sleep(govPollMs);
                            holdAttempts++;
                            govOk3 = checkGovernorDelta(vcConn, dsRefs,
                                         cand.vmName, dsBaseline);
                        }
                        if (!govOk3) {
                            LOG.warn("PROCESSING",
                                "Storage did not settle -- deferring: " + label);
                            logArr.push(makeEntry(cand,"deferred",false,
                                "Storage I/O governor max wait exceeded",null,0));
                            pending.splice(di, 1);  // remove permanently
                            continue;  // di already points to next entry after splice
                        }
                    } else {
                        // Other tasks are running -- break inner loop and wait
                        // for next harvest cycle before trying again
                        break;
                    }
                }

                // Remove from pending -- this candidate is being handled now
                pending.splice(di, 1);
                // Note: di is NOT incremented; after splice the next entry
                // slides into position di automatically.

                if (dryRun) {
                    LOG.dryrun("PROCESSING", "Would delete:  " + label);
                    logArr.push(makeEntry(cand,"dry_run",true,null,null,0));
                    continue;
                }

                // Dispatch async wrapper workflow
                var props = new Properties();
                props.put("vcenterSdkConnection", vcConn);
                props.put("vmMoRef",              cand.vmMoRef);
                props.put("snapshotMoRef",        cand.snapshotMoRef);
                props.put("snapshotName",         cand.snapshotName);
                props.put("snapshotCreatedMs",    cand.snapshotCreatedMs || 0);
                props.put("vmName",               cand.vmName);
                props.put("datastoreMoRefsJson",  JSON.stringify(dsRefs));
                props.put("dryRun",               false);
                props.put("taskTimeoutSeconds",   taskTimeoutSeconds || 1800);

                var token = wrapperWf.execute(props);
                vmInFlight[cand.vmMoRef] = true;
                inFlightSlots.push({
                    token:   token,
                    cand:    cand,
                    label:   label,
                    startMs: new Date().getTime(),
                    vmMoRef: cand.vmMoRef
                });
                LOG.ok("PROCESSING",
                    "Dispatched [" + inFlightSlots.length + "/" + currentConcurrency +
                    " slots]:  " + label);
            }

            // Sleep before next harvest/dispatch cycle
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

function checkGovernorDelta(vcConn, dsRefs, vmName, baseline) {
    // Approve immediately if no datastores to check
    if (!dsRefs || dsRefs.length === 0) return true;

    for (var gi = 0; gi < dsRefs.length; gi++) {
        var r = dsRefs[gi];
        var curr = null;
        try {
            curr = JSON.parse(System.getModule(STORAGEMODULE)
                              ._getDatastoreMetrics(vcConn, r));
        } catch(ge) {
            LOG.warn("PROCESSING", "Could not sample metrics for " + r +
                     " -- approving to avoid permanent hold: " + ge.message);
            continue;
        }

        var base = baseline[r];

        // VMFS latency delta check
        var curLat  = (curr.readLatencyMs !== null ? curr.readLatencyMs : 0) +
                      (curr.writeLatencyMs !== null ? curr.writeLatencyMs : 0);
        var baseLat = base
            ? ((base.readLatencyMs !== null ? base.readLatencyMs : 0) +
               (base.writeLatencyMs !== null ? base.writeLatencyMs : 0))
            : 0;
        var deltaLat = Math.max(0, curLat - baseLat);

        if (curLat + deltaLat > (latencyThresholdMs || 30)) {
            LOG.hold("PROCESSING",
                "Datastore " + r + " latency " + curLat.toFixed(1) +
                "ms + projected delta " + deltaLat.toFixed(1) +
                "ms would exceed " + (latencyThresholdMs||30) + "ms threshold" +
                " for VM '" + vmName + "'");
            return false;
        }

        // vSAN congestion delta check
        if (curr.vsanCongestion !== null) {
            var curCong  = curr.vsanCongestion || 0;
            var baseCong = base && base.vsanCongestion !== null
                ? base.vsanCongestion : 0;
            var deltaCong = Math.max(0, curCong - baseCong);
            if (curCong + deltaCong > (vsanCongestionThresh || 50)) {
                LOG.hold("PROCESSING",
                    "Datastore " + r + " vSAN congestion " + curCong.toFixed(1) +
                    " + projected delta " + deltaCong.toFixed(1) +
                    " would exceed " + (vsanCongestionThresh||50) + " threshold" +
                    " for VM '" + vmName + "'");
                return false;
            }
        }
    }
    return true;
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
