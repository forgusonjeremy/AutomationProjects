/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ST-05  SORT & SPLIT EXECUTION LANES
 * ─────────────────────────────────────────────────────────────────────────────
 * Takes the flat candidate list from ST-03 and produces two ordered queues:
 *
 * GROUPING & ORDER:
 *   Candidates are grouped by VM. Within each VM group, snapshots are sorted
 *   newest-first using a topological (Kahn's) sort so that leaf snapshots
 *   (newest/deepest) are always processed before their parents. This means
 *   the workflow deletes snapshot-6 before snapshot-5, snapshot-5 before
 *   snapshot-4, and so on -- never touching a parent until its child has
 *   been removed.
 *
 *   The topological sort operates only on candidates actually present in the
 *   list. If a snapshot was excluded (desc filter, age filter) its MoRef is
 *   not in the candidate set, so it is never treated as a blocking parent.
 *   This prevents the sort from getting stuck when a filtered snapshot sits
 *   in the middle of a chain.
 *
 * LANE SPLIT:
 *   Powered-OFF VMs go to the fast lane (ST-07, no I/O governor).
 *   Powered-ON and suspended VMs go to the throttled lane (ST-06).
 *
 * ── INPUTS ───────────────────────────────────────────────────────────────────
 *   allCandidatesJson  string  Flat candidate array from _getSnapshotCandidates
 *
 * ── OUTPUTS ──────────────────────────────────────────────────────────────────
 *   onCandidatesJson   string  Ordered candidates for powered-on VMs (ST-06)
 *   offCandidatesJson  string  Ordered candidates for powered-off VMs (ST-07)
 */
var LOG = {
    ok: function(p,m){ System.log("[SNAPSHOT-CLEANUP] ["+p+"] [OK]      "+m); }
};

var all = JSON.parse(allCandidatesJson || "[]");

// ── Step 1: Group candidates by VM ───────────────────────────────────────────
var vmGroups = {};   // vmMoRef -> [candidate, ...]
var vmOrder  = [];   // insertion order of vmMoRefs

for (var i = 0; i < all.length; i++) {
    var c   = all[i];
    var key = c.vmMoRef;
    if (!vmGroups[key]) {
        vmGroups[key] = [];
        vmOrder.push(key);
    }
    vmGroups[key].push(c);
}

// ── Step 2: Within each VM, topological sort newest-first ─────────────────────
// Build a set of snapshotMoRefs that are in the candidate list for this VM.
// Only consider parent links that point to another candidate -- filtered-out
// snapshots are invisible to the sort.
var sorted = [];

for (var vi = 0; vi < vmOrder.length; vi++) {
    var group = vmGroups[vmOrder[vi]];

    // Index candidates in this group by their MoRef.
    // Only parent links pointing to another candidate count --
    // filtered-out snapshots are invisible to the sort.
    var inGroup = {};
    for (var gi = 0; gi < group.length; gi++) {
        inGroup[group[gi].snapshotMoRef] = true;
    }

    // childCount[moRef] = number of candidate children still waiting.
    // Using a count (not a boolean) correctly handles the case where a
    // snapshot has multiple candidate children: the parent only becomes
    // a leaf once ALL children have been emitted, not just the first.
    var childCount = {};
    for (var pi = 0; pi < group.length; pi++) {
        var par = group[pi].parentSnapshotMoRef;
        if (par && inGroup[par]) {
            childCount[par] = (childCount[par] || 0) + 1;
        }
    }

    // Kahn's algorithm: emit all candidates whose childCount is 0 (leaves),
    // decrement each emitted leaf's parent, repeat until done.
    var remaining = group.slice();
    var vmSorted  = [];
    var safety    = 0;

    while (remaining.length > 0 && safety++ < 5000) {
        var leaves    = [];
        var nonLeaves = [];

        for (var ri = 0; ri < remaining.length; ri++) {
            var moRef = remaining[ri].snapshotMoRef;
            if (!childCount[moRef] || childCount[moRef] <= 0) {
                leaves.push(remaining[ri]);
            } else {
                nonLeaves.push(remaining[ri]);
            }
        }

        if (leaves.length === 0) {
            // Genuine cycle in vCenter snapshot metadata -- emit remainder
            // as-is so the run still processes what it can.
            for (var ci = 0; ci < remaining.length; ci++) {
                vmSorted.push(remaining[ci]);
            }
            System.warn("ST-05: cycle detected in snapshot chain for VM " +
                        group[0].vmName + " -- emitting remaining " +
                        remaining.length + " candidate(s) unsorted");
            break;
        }

        // Sort leaves newest-first (smallest age = most recently created)
        leaves.sort(function(a, b) {
            return a.snapshotAgeMinutes - b.snapshotAgeMinutes;
        });

        for (var li = 0; li < leaves.length; li++) {
            vmSorted.push(leaves[li]);
            // Decrement the parent's outstanding child count.
            // When it reaches 0 the parent becomes a leaf in the next round.
            var parentMoRef = leaves[li].parentSnapshotMoRef;
            if (parentMoRef && childCount[parentMoRef] !== undefined) {
                childCount[parentMoRef]--;
            }
        }
        remaining = nonLeaves;
    }

    for (var si = 0; si < vmSorted.length; si++) {
        sorted.push(vmSorted[si]);
    }
}

// ── Step 3: Split into lanes ──────────────────────────────────────────────────
var on  = sorted.filter(function(c){ return c.vmPowerState !== "poweredOff"; });
var off = sorted.filter(function(c){ return c.vmPowerState === "poweredOff";  });

onCandidatesJson  = JSON.stringify(on);
offCandidatesJson = JSON.stringify(off);

LOG.ok("PROCESSING", "Snapshot queue ready:");
LOG.ok("PROCESSING", "  Powered-ON  VMs : " + on.length  +
       " snapshot(s)  (processed with I/O throttling)");
LOG.ok("PROCESSING", "  Powered-OFF VMs : " + off.length +
       " snapshot(s)  (processed in fast lane)");
LOG.ok("PROCESSING", "Beginning cleanup...");
