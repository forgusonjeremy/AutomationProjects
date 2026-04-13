/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ST-05  SORT & SPLIT EXECUTION LANES
 * ─────────────────────────────────────────────────────────────────────────────
 * Prepares the candidate list for safe, efficient processing by doing two things:
 *
 * 1. CHAIN-ORDER SORT: Sorts candidates so child snapshots always appear before
 *    their parent in the queue. This is required because vCenter cannot delete a
 *    parent snapshot while one of its children still exists. Within the same VM,
 *    the oldest sibling snapshots are processed first to maximise storage reclaim.
 *
 * 2. LANE SPLIT: Divides candidates into two queues based on VM power state.
 *    Powered-off VMs have no guest stun lock risk so they can be processed
 *    without the per-vCenter concurrency limit, making them faster to clean up.
 *    Powered-on and suspended VMs go to the throttled lane with full governor
 *    and concurrency enforcement.
 *
 * ── INPUTS ───────────────────────────────────────────────────────────────────
 *   Name               vRO Type  Source / Description
 *   ─────────────────────────────────────────────────────────────────────────────────────────────
 *   allCandidatesJson  string    Attribute: allCandidatesJson
 *                                The complete flat candidate list from ST-03.
 *                                Parsed, sorted, and split into two sub-lists.
 *
 * ── OUTPUTS ──────────────────────────────────────────────────────────────────
 *   Name               vRO Type  Description
 *   ─────────────────────────────────────────────────────────────────────────────────────────────
 *   onCandidatesJson   string    JSON array of candidates whose VM power state is poweredOn
 *                                or suspended. Fed into ST-06 (throttled lane). Chain-ordered.
 *   offCandidatesJson  string    JSON array of candidates whose VM power state is poweredOff.
 *                                Fed into ST-07 (fast lane). Chain-ordered.
 */
var LOG = {
    ok: function(p,m){ System.log("[SNAPSHOT-CLEANUP] ["+p+"] [OK]      "+m); }
};

var all = JSON.parse(allCandidatesJson || "[]");

// Child-before-parent sort, then oldest-first within same VM
all.sort(function(a,b){
    if (a.parentSnapshotMoRef !== null && a.parentSnapshotMoRef === b.snapshotMoRef) return -1;
    if (b.parentSnapshotMoRef !== null && b.parentSnapshotMoRef === a.snapshotMoRef) return  1;
    return b.snapshotAgeMinutes - a.snapshotAgeMinutes;
});

var on  = all.filter(function(c){ return c.vmPowerState !== "poweredOff"; });
var off = all.filter(function(c){ return c.vmPowerState === "poweredOff"; });

onCandidatesJson  = JSON.stringify(on);
offCandidatesJson = JSON.stringify(off);

LOG.ok("PROCESSING","Snapshot queue ready:");
LOG.ok("PROCESSING","  Powered-ON  VMs : " + on.length  + " snapshot(s)  (processed with I/O throttling)");
LOG.ok("PROCESSING","  Powered-OFF VMs : " + off.length + " snapshot(s)  (processed in fast lane)");
LOG.ok("PROCESSING","Beginning cleanup...");
