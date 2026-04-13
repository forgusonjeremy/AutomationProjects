/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ST-05  SORT & SPLIT EXECUTION LANES
 * ─────────────────────────────────────────────────────────────────────────────
 * Sorts snapshots so children are always processed before parents (required
 * for safe chain deletion). Splits into powered-on and powered-off queues.
 *
 * ── INPUTS ───────────────────────────────────────────────────────────────────
 *   Name               vRO Type   Source
 *   ──────────────────────────────────────────────────────────────────────────
 *   allCandidatesJson  string     Attribute: allCandidatesJson
 *
 * ── OUTPUTS ──────────────────────────────────────────────────────────────────
 *   Name               vRO Type   Description
 *   ──────────────────────────────────────────────────────────────────────────
 *   onCandidatesJson   string     JSON array -- powered-on and suspended VM snapshots
 *   offCandidatesJson  string     JSON array -- powered-off VM snapshots (fast lane)
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
