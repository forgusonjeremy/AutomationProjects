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

// ── Chain-safe sort: newest-first within each VM's snapshot chain ─────────
// Within each VM we perform a topological sort so that leaf snapshots
// (newest/deepest in the chain) are processed before their parents.
// This ensures:
//   1. We never attempt to delete a parent while its child still exists
//      (vCenter would reject it anyway, but we avoid the error entirely).
//   2. We only ever touch snapshots that have independently passed the age
//      threshold -- deleting newest-first means we never force-consolidate
//      a snapshot that wasn't individually eligible.
// Across VMs, ordering is newest-first so that the most recent snapshots
// across the whole environment are cleaned up before older ones in the
// same batch, maximising reclaim of the most recently consumed delta space.

// Group candidates by VM
var vmGroups = {};
for (var gi = 0; gi < all.length; gi++) {
    var c = all[gi];
    var key = c.vcenterName + "|" + c.vmMoRef;
    if (!vmGroups[key]) vmGroups[key] = [];
    vmGroups[key].push(c);
}

// For each VM, topologically sort so children come before parents.
// Build a map of snapshotMoRef -> candidate, then repeatedly pick
// candidates whose snapshotMoRef is not referenced as anyone's parent
// (i.e. they are current leaves) and emit them in order.
var sorted = [];
var vmKeys = Object.keys(vmGroups);
for (var vi = 0; vi < vmKeys.length; vi++) {
    var group = vmGroups[vmKeys[vi]];

    // Build parent lookup: which MoRefs are referenced as a parent?
    var isParentOf = {};  // snapshotMoRef -> true if it has a child in this group
    for (var pi = 0; pi < group.length; pi++) {
        var parent = group[pi].parentSnapshotMoRef;
        if (parent) isParentOf[parent] = true;
    }

    // Iteratively extract leaves (no children remaining) and emit them.
    // This is Kahn's algorithm on a forest of snapshot chains.
    var remaining = group.slice();
    var vmSorted  = [];
    var safety    = 0;

    while (remaining.length > 0 && safety++ < 1000) {
        var leaves = [];
        var nonLeaves = [];
        for (var ri = 0; ri < remaining.length; ri++) {
            if (!isParentOf[remaining[ri].snapshotMoRef]) {
                leaves.push(remaining[ri]);
            } else {
                nonLeaves.push(remaining[ri]);
            }
        }

        if (leaves.length === 0) {
            // Cycle or bad data -- emit remaining as-is to avoid infinite loop
            for (var ci2 = 0; ci2 < remaining.length; ci2++) vmSorted.push(remaining[ci2]);
            break;
        }

        // Sort leaves newest-first (youngest age = most recently created)
        leaves.sort(function(a,b){ return a.snapshotAgeMinutes - b.snapshotAgeMinutes; });
        for (var li = 0; li < leaves.length; li++) {
            vmSorted.push(leaves[li]);
            // Remove this leaf from isParentOf so its parent can become a leaf
            delete isParentOf[leaves[li].parentSnapshotMoRef];
        }
        remaining = nonLeaves;
    }

    for (var si2 = 0; si2 < vmSorted.length; si2++) sorted.push(vmSorted[si2]);
}

// Final cross-VM sort: newest-first so the most recently created snapshots
// are processed first across the entire batch.
sorted.sort(function(a,b){ return a.snapshotAgeMinutes - b.snapshotAgeMinutes; });
var all = sorted;

var on  = all.filter(function(c){ return c.vmPowerState !== "poweredOff"; });
var off = all.filter(function(c){ return c.vmPowerState === "poweredOff"; });

onCandidatesJson  = JSON.stringify(on);
offCandidatesJson = JSON.stringify(off);

LOG.ok("PROCESSING","Snapshot queue ready:");
LOG.ok("PROCESSING","  Powered-ON  VMs : " + on.length  + " snapshot(s)  (processed with I/O throttling)");
LOG.ok("PROCESSING","  Powered-OFF VMs : " + off.length + " snapshot(s)  (processed in fast lane)");
LOG.ok("PROCESSING","Beginning cleanup...");
