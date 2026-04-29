/**
 * ACTION: adaptiveGovernorCheck
 * Module : com.broadcom.pso.vc.vm.snapshots
 *
 * Topology-aware I/O governor decision engine. Called before starting each
 * new consolidation task. Projects per-host I/O impact using the observed
 * delta from the previous consolidation, then classifies degradation as
 * array-wide or host-localized to make smarter go/no-go decisions.
 *
 * Decision tree:
 *   1. Array-wide degradation (majority of hosts projecting above threshold)
 *      → DENY regardless of target host
 *   2. Host-localized degradation (only the active-consolidation host is hot)
 *      a. Next VM lives on the hot host → DENY (piling on)
 *      b. Next VM lives on a healthy host → APPROVE with advisory
 *   3. No significant degradation → APPROVE
 *
 * Delta projection logic:
 *   - The "active host" (where the last consolidation ran) gets the full
 *     observed delta applied — it experienced the direct I/O load.
 *   - "Bystander hosts" get a sympathetic delta: a fraction of the active
 *     host's delta, representing shared-backend impact (e.g., TrueNAS array
 *     contention propagating across initiators). The fraction is configurable
 *     via sympatheticDeltaRatio (default 0.25 = 25% of active host delta).
 *
 * ── INPUT PARAMETERS ─────────────────────────────────────────────────────────
 *   currentMetricsJson         : string — JSON from _getDatastoreMetrics (new perHost shape)
 *   preConsolidationJson       : string — metrics sampled BEFORE the last consolidation
 *   postConsolidationJson      : string — metrics sampled AFTER the last consolidation
 *   latencyThresholdMs         : number — VMFS/NFS: max tolerable projected latency (ms)
 *   vsanCongestionThresh       : number — vSAN: max tolerable projected congestion (0-255)
 *   vsanResyncThresh           : number — vSAN: max tolerable projected resync (bytes)
 *   nextTaskHostMoRef          : string — host MoRef where the NEXT consolidation VM lives
 *   activeConsolidationHostMoRef : string — host MoRef where the PREVIOUS consolidation ran
 *                                            (empty string if first task or unknown)
 *   sympatheticDeltaRatio      : number — fraction of active-host delta applied to bystanders
 *                                          (default 0.25; range 0.0–1.0)
 *   arrayWideMajorityPct       : number — % of hosts that must be hot to classify as array-wide
 *                                          (default 50; range 1–100)
 *
 * ── RETURN TYPE ──────────────────────────────────────────────────────────────
 *   string (JSON object)
 *   {
 *     approved:           boolean,
 *     reason:             string,
 *     classification:     "array-wide" | "host-localized" | "clear" | "first-run",
 *     projectedPerHost:   { <hostId>: { projR, projW, deltaR, deltaW, isHot } },
 *     hotHosts:           [ <hostId>, ... ],
 *     healthyHosts:       [ <hostId>, ... ],
 *     targetHostStatus:   "hot" | "healthy" | "unknown"
 *   }
 */

var approved            = true;
var reason              = "OK";
var classification      = "clear";
var projectedPerHost    = {};
var hotHosts            = [];
var healthyHosts        = [];
var targetHostStatus    = "unknown";

// ── Defaults for optional parameters ──────────────────────────────────────────
if (typeof sympatheticDeltaRatio === "undefined" || sympatheticDeltaRatio === null) {
    sympatheticDeltaRatio = 0.25;
}
sympatheticDeltaRatio = Math.max(0, Math.min(1, sympatheticDeltaRatio));

if (typeof arrayWideMajorityPct === "undefined" || arrayWideMajorityPct === null) {
    arrayWideMajorityPct = 50;
}
arrayWideMajorityPct = Math.max(1, Math.min(100, arrayWideMajorityPct));

if (typeof activeConsolidationHostMoRef === "undefined") {
    activeConsolidationHostMoRef = "";
}

try {
    var current = JSON.parse(currentMetricsJson      || "{}");
    var pre     = JSON.parse(preConsolidationJson     || "{}");
    var post    = JSON.parse(postConsolidationJson    || "{}");

    // ── First-run guard: no calibration data yet ──────────────────────────────
    if (!pre.perHost || objectKeyCount(pre.perHost) === 0 ||
        !post.perHost || objectKeyCount(post.perHost) === 0) {
        return JSON.stringify({
            approved:         true,
            reason:           "First task on this datastore — no calibration data yet, proceeding",
            classification:   "first-run",
            projectedPerHost: {},
            hotHosts:         [],
            healthyHosts:     [],
            targetHostStatus: "unknown"
        });
    }

    var dsType = current.datastoreType || "unknown";

    // ══════════════════════════════════════════════════════════════════════════
    // STEP 1 — Compute the observed delta from the last consolidation,
    //          PER HOST, so we know how much impact the active host saw
    //          versus what bystander hosts absorbed.
    // ══════════════════════════════════════════════════════════════════════════

    // Delta = post - pre for each host. This represents the I/O impact
    // that the last consolidation imposed.
    var observedDeltas = {};

    // Also compute the active host's delta specifically, since bystander
    // hosts get a scaled fraction of it.
    var activeHostDelta = { readLatMs: 0, writeLatMs: 0, congestion: 0, resync: 0 };
    var hasActiveHostDelta = false;

    for (var hostId in post.perHost) {
        if (!pre.perHost[hostId]) continue;
        var prH  = pre.perHost[hostId];
        var poH  = post.perHost[hostId];

        if (dsType === "vsan") {
            var congDelta  = Math.max(0, (poH.vsanCongestion || 0) - (prH.vsanCongestion || 0));
            var resyncDelta = Math.max(0, (poH.vsanResyncQueueDepth || 0) -
                                          (prH.vsanResyncQueueDepth || 0));
            observedDeltas[hostId] = {
                congDelta:  congDelta,
                resyncDelta: resyncDelta
            };
            if (hostId === activeConsolidationHostMoRef) {
                activeHostDelta.congestion = congDelta;
                activeHostDelta.resync     = resyncDelta;
                hasActiveHostDelta         = true;
            }
        } else {
            var rDelta = Math.max(0, (poH.readLatencyMs  || 0) - (prH.readLatencyMs  || 0));
            var wDelta = Math.max(0, (poH.writeLatencyMs || 0) - (prH.writeLatencyMs || 0));
            observedDeltas[hostId] = {
                readLatMs:  rDelta,
                writeLatMs: wDelta
            };
            if (hostId === activeConsolidationHostMoRef) {
                activeHostDelta.readLatMs  = rDelta;
                activeHostDelta.writeLatMs = wDelta;
                hasActiveHostDelta         = true;
            }
        }
    }

    // If we don't know which host was the active consolidation host, or it
    // wasn't in the pre/post data, fall back to using the maximum observed
    // delta across all hosts as the "active" reference. This is conservative.
    if (!hasActiveHostDelta) {
        for (var hid in observedDeltas) {
            var od = observedDeltas[hid];
            if (dsType === "vsan") {
                if (od.congDelta > activeHostDelta.congestion) {
                    activeHostDelta.congestion = od.congDelta;
                }
                if (od.resyncDelta > activeHostDelta.resync) {
                    activeHostDelta.resync = od.resyncDelta;
                }
            } else {
                if (od.readLatMs > activeHostDelta.readLatMs) {
                    activeHostDelta.readLatMs = od.readLatMs;
                }
                if (od.writeLatMs > activeHostDelta.writeLatMs) {
                    activeHostDelta.writeLatMs = od.writeLatMs;
                }
            }
        }
        System.log("adaptiveGovernor: no active-host delta available, using max " +
                    "observed delta as reference (conservative)");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // STEP 2 — Project per-host metrics using differential delta application.
    //          Active host gets the full delta. Bystanders get the
    //          sympathetic fraction.
    // ══════════════════════════════════════════════════════════════════════════

    for (var hostId in current.perHost) {
        var ch = current.perHost[hostId];

        // Determine whether this host was the active consolidation host.
        var isActiveHost = (hostId === activeConsolidationHostMoRef);

        // If no active host was specified, apply full delta to the host with
        // the largest observed delta (conservative assumption).
        var deltaMultiplier = isActiveHost ? 1.0 : sympatheticDeltaRatio;

        // If activeConsolidationHostMoRef is empty (first run, unknown), we
        // don't know who was active, so apply full delta to all hosts as a
        // safety measure. Better to be conservative than to let something
        // through that would breach the threshold.
        if (activeConsolidationHostMoRef === "") {
            deltaMultiplier = 1.0;
        }

        var projected = {};

        if (dsType === "vsan") {
            var appliedCongDelta  = activeHostDelta.congestion * deltaMultiplier;
            var appliedResyncDelta = activeHostDelta.resync * deltaMultiplier;
            var projCong   = (ch.vsanCongestion || 0) + appliedCongDelta;
            var projResync = (ch.vsanResyncQueueDepth || 0) + appliedResyncDelta;

            projected = {
                projectedVsanCongestion:  Math.round(projCong),
                projectedVsanResyncBytes: Math.round(projResync),
                appliedCongDelta:         Math.round(appliedCongDelta),
                appliedResyncDelta:       Math.round(appliedResyncDelta),
                deltaMultiplier:          deltaMultiplier,
                isHot:                    false
            };

            if (projCong > vsanCongestionThresh || projResync > vsanResyncThresh) {
                projected.isHot = true;
                hotHosts.push(hostId);
            } else {
                healthyHosts.push(hostId);
            }

        } else {
            // VMFS / NFS
            var appliedRDelta = activeHostDelta.readLatMs  * deltaMultiplier;
            var appliedWDelta = activeHostDelta.writeLatMs * deltaMultiplier;
            var projR = (ch.readLatencyMs  || 0) + appliedRDelta;
            var projW = (ch.writeLatencyMs || 0) + appliedWDelta;

            projected = {
                projectedReadLatMs:  Math.round(projR * 10) / 10,
                projectedWriteLatMs: Math.round(projW * 10) / 10,
                appliedReadDelta:    Math.round(appliedRDelta * 10) / 10,
                appliedWriteDelta:   Math.round(appliedWDelta * 10) / 10,
                deltaMultiplier:     deltaMultiplier,
                isHot:               false
            };

            if (projR > latencyThresholdMs || projW > latencyThresholdMs) {
                projected.isHot = true;
                hotHosts.push(hostId);
            } else {
                healthyHosts.push(hostId);
            }
        }

        projectedPerHost[hostId] = projected;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // STEP 3 — Classification and decision
    // ══════════════════════════════════════════════════════════════════════════

    var totalHosts    = hotHosts.length + healthyHosts.length;
    var majorityCount = Math.ceil(totalHosts * (arrayWideMajorityPct / 100));

    // Determine the target host's projected status.
    if (projectedPerHost[nextTaskHostMoRef]) {
        targetHostStatus = projectedPerHost[nextTaskHostMoRef].isHot
                                ? "hot" : "healthy";
    }

    if (totalHosts === 0) {
        // No hosts had current metrics — can't make a decision, deny safely.
        approved       = false;
        classification = "clear";
        reason         = "No host metrics available for projection — denying as precaution";

    } else if (hotHosts.length >= majorityCount) {
        // ── ARRAY-WIDE: majority of hosts are projecting above threshold ──────
        approved       = false;
        classification = "array-wide";

        if (dsType === "vsan") {
            reason = "Array-wide vSAN degradation: " + hotHosts.length + "/" +
                     totalHosts + " hosts projecting above threshold on " +
                     current.datastoreMoRef;
        } else {
            // Include the worst projected latency in the reason for debugging.
            var worstR = 0, worstW = 0;
            for (var wi = 0; wi < hotHosts.length; wi++) {
                var wp = projectedPerHost[hotHosts[wi]];
                if (wp.projectedReadLatMs  > worstR) worstR = wp.projectedReadLatMs;
                if (wp.projectedWriteLatMs > worstW) worstW = wp.projectedWriteLatMs;
            }
            reason = "Array-wide degradation: " + hotHosts.length + "/" +
                     totalHosts + " hosts projecting above " + latencyThresholdMs +
                     "ms (worst R:" + worstR + "ms W:" + worstW + "ms) on " +
                     current.datastoreMoRef;
        }

    } else if (hotHosts.length > 0) {
        // ── HOST-LOCALIZED: some hosts are hot, but not a majority ────────────
        classification = "host-localized";

        if (targetHostStatus === "hot") {
            // The next VM's host is one of the hot ones — don't pile on.
            approved = false;
            reason   = "Target host " + nextTaskHostMoRef + " is degraded " +
                       "(localized to " + hotHosts.length + "/" + totalHosts +
                       " hosts). Deferring consolidation to avoid piling on. " +
                       "Hot hosts: " + hotHosts.join(", ");
        } else {
            // The next VM's host is healthy — safe to proceed.
            approved = true;
            reason   = "Localized degradation on " + hotHosts.join(", ") +
                       " (" + hotHosts.length + "/" + totalHosts + " hosts). " +
                       "Target host " + nextTaskHostMoRef + " is healthy " +
                       "(projected within threshold). Proceeding.";
        }

    } else {
        // ── CLEAR: no hosts projecting above threshold ────────────────────────
        approved       = true;
        classification = "clear";
        reason         = "All " + totalHosts + " hosts projecting within threshold " +
                         "on " + current.datastoreMoRef;
    }

    // ── Log the decision with enough detail for troubleshooting ───────────────
    System.log("adaptiveGovernor: " + classification + " — " + reason);
    System.log("adaptiveGovernor: hotHosts=" + JSON.stringify(hotHosts) +
               " healthyHosts=" + JSON.stringify(healthyHosts) +
               " targetHost=" + nextTaskHostMoRef + " (" + targetHostStatus + ")" +
               " sympatheticRatio=" + sympatheticDeltaRatio +
               " majorityThreshold=" + majorityCount + "/" + totalHosts);

} catch (e) {
    approved       = false;
    classification = "error";
    reason         = "Governor check error: " + e.message + " — denying as precaution";
    System.warn("adaptiveGovernor: " + reason);
}

return JSON.stringify({
    approved:         approved,
    reason:           reason,
    classification:   classification,
    projectedPerHost: projectedPerHost,
    hotHosts:         hotHosts,
    healthyHosts:     healthyHosts,
    targetHostStatus: targetHostStatus
});

// ── Helper: count keys in an object (vRO Rhino-safe) ─────────────────────────
function objectKeyCount(obj) {
    var n = 0;
    for (var k in obj) {
        if (obj.hasOwnProperty(k)) n++;
    }
    return n;
}