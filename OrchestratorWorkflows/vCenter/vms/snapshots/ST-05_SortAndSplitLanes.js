/**
 * ST-05  SORT & SPLIT EXECUTION LANES
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. Chain-order sort: children before parents, oldest siblings first.
 * 2. Lane split: powered-off VMs → fast lane (ST-07), all others → throttled lane (ST-06).
 *
 * WORKFLOW ATTRIBUTE INPUTS : allCandidatesJson (string)
 * WORKFLOW ATTRIBUTE OUTPUTS: onCandidatesJson (string), offCandidatesJson (string)
 */

var all = JSON.parse(allCandidatesJson || "[]");

all.sort(function(a, b) {
    if (a.parentSnapshotMoRef !== null && a.parentSnapshotMoRef === b.snapshotMoRef) return -1;
    if (b.parentSnapshotMoRef !== null && b.parentSnapshotMoRef === a.snapshotMoRef) return  1;
    return b.snapshotAgeMinutes - a.snapshotAgeMinutes;
});

var on  = [];
var off = [];
for each (var c in all) {
    if (c.vmPowerState === "poweredOff") off.push(c);
    else                                  on.push(c);
}

onCandidatesJson  = JSON.stringify(on);
offCandidatesJson = JSON.stringify(off);

System.log("[ST-05] Sorted " + all.length + " candidates.");
System.log("[ST-05] Powered-on/suspended lane : " + on.length);
System.log("[ST-05] Powered-off fast lane     : " + off.length);
