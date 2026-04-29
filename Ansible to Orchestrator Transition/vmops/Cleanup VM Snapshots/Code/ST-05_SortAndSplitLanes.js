/**
 * ST-05  SORT & SPLIT EXECUTION LANES
 *
 * Groups candidates by VM, sorts each VM's snapshots newest-first by
 * creation timestamp, then splits into powered-on and powered-off lanes.
 *
 * No topology analysis needed -- candidates are identified by name only
 * and resolved at deletion time, so there are no MoRef chains to sort.
 *
 * Newest-first ordering ensures that within each VM's chain, the most
 * recently created snapshot is deleted first (leaf before parent),
 * which is the safe deletion order regardless of chain depth.
 */
var LOG = {
    ok: function(p, m) { System.log("[SNAPSHOT-CLEANUP] [" + p + "] [OK]      " + m); }
};

var all = JSON.parse(allCandidatesJson || "[]");

// ── Group by VM ───────────────────────────────────────────────────────────────
var vmGroups = {};
var vmOrder  = [];
for (var i = 0; i < all.length; i++) {
    var c   = all[i];
    var key = c.vmMoRef;
    if (!vmGroups[key]) {
        vmGroups[key] = [];
        vmOrder.push(key);
    }
    vmGroups[key].push(c);
}

// ── Sort each VM's snapshots newest-first ─────────────────────────────────────
// Smallest snapshotCreatedMs = oldest; largest = newest.
// We want newest first so sort descending by createdMs.
var sorted = [];
for (var vi = 0; vi < vmOrder.length; vi++) {
    var group = vmGroups[vmOrder[vi]];
    group.sort(function(a, b) {
        return b.snapshotCreatedMs - a.snapshotCreatedMs;
    });
    for (var gi = 0; gi < group.length; gi++) {
        sorted.push(group[gi]);
    }
}

// ── Split lanes ───────────────────────────────────────────────────────────────
var on  = sorted.filter(function(c) { return c.vmPowerState !== "poweredOff"; });
var off = sorted.filter(function(c) { return c.vmPowerState === "poweredOff";  });

onCandidatesJson  = JSON.stringify(on);
offCandidatesJson = JSON.stringify(off);

LOG.ok("PROCESSING", "Snapshot queue ready:");
LOG.ok("PROCESSING", "  Powered-ON  VMs : " + on.length  +
       " snapshot(s)  (processed with I/O throttling)");
LOG.ok("PROCESSING", "  Powered-OFF VMs : " + off.length +
       " snapshot(s)  (processed in fast lane)");
LOG.ok("PROCESSING", "Beginning cleanup...");
