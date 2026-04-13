/**
 * ST-05  SORT & SPLIT EXECUTION LANES
 * ─────────────────────────────────────────────────────────────────────────────
 * Sorts snapshots so child snapshots are always processed before parents
 * (required for safe chain deletion). Then splits the list into two lanes:
 *   - Powered-ON  VMs  : processed with concurrency limits and full I/O governor
 *   - Powered-OFF VMs  : processed faster (no guest stun risk) but still governed
 *
 * WORKFLOW ATTRIBUTE INPUTS : allCandidatesJson
 * WORKFLOW ATTRIBUTE OUTPUTS: onCandidatesJson, offCandidatesJson
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
