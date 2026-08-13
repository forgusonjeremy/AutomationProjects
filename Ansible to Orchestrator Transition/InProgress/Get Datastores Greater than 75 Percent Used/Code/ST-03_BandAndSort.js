/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ST-03 BAND, SORT AND CLASSIFY
 * ─────────────────────────────────────────────────────────────────────────────
 * Places every collected datastore into exactly one severity band, orders each
 * band worst-first, and derives the mail subject and the run outcome.
 *
 * This is the single source of truth for banding. ST-04 renders whatever this
 * task produces and does no bucketing of its own, so the counts in the mail
 * subject can never disagree with the tables in the mail body.
 *
 * TWO CORRECTIONS TO THE RETIRING LOGIC LIVE HERE
 *
 *   P-34  Gapless bands. The PowerShell used:
 *             high : PercentUsed -gt 90
 *             med  : PercentUsed -gt 80 -and PercentUsed -lt 89.99
 *             low  : PercentUsed -gt 70 -and PercentUsed -lt 79.99
 *         A datastore at 89.995% matched no band, and one at exactly 90.00%
 *         matched no band either (-gt is strict). Bands are now half-open —
 *         [floor, ceiling) — so every value from the floor to 100% lands in
 *         exactly one band, and boundary values land in the more severe one.
 *
 *   P-37  No cross-vCenter de-duplication. The PowerShell piped each band
 *         through 'Sort-Object -Property Datastore -Unique', which de-duplicates
 *         on the datastore NAME. Across a five-vCenter estate that silently
 *         discarded every datastore whose name already appeared on another
 *         vCenter — a real and common case, since datastore naming conventions
 *         are usually per-site, not per-estate. Rows are now keyed on
 *         vCenter + MoRef and nothing is dropped. Any genuine duplicate MoRef
 *         within one vCenter (which should not occur) is logged if seen.
 *
 * ── INPUTS ───────────────────────────────────────────────────────────────────
 *   Name              vRO Type  Source
 *   ─────────────────────────────────────────────────────────────────────────────
 *   collectedJson     string    Attribute, set by ST-02
 *   thresholdHighPct  number    Workflow Input
 *   bandWidthPct      number    Workflow Input
 *   failuresJson      string    Attribute, set by ST-02
 *   mailSubjectPrefix string    Workflow Input
 *
 * ── OUTPUTS ──────────────────────────────────────────────────────────────────
 *   Name           vRO Type  Description
 *   ─────────────────────────────────────────────────────────────────────────────
 *   bandedJson     string    JSON { critical[], warning[], advisory[], meta{} }
 *   criticalCount  number    Datastores at or above thresholdHighPct
 *   warningCount   number    Datastores in the middle band
 *   advisoryCount  number    Datastores in the lowest reported band
 *   mailSubject    string    Subject line for ST-05
 *   outcome        string    COMPLETE | COMPLETE_WITH_GAPS | CLEAN_NO_FINDINGS
 */

var LOG = {
    ok:     function(p,m){ System.log(  "[DATASTORE-REPORT] ["+p+"] [OK]     "+m); },
    warn:   function(p,m){ System.warn( "[DATASTORE-REPORT] ["+p+"] [WARN]   "+m); },
    result: function(p,m){ System.log(  "[DATASTORE-REPORT] ["+p+"] [RESULT] "+m); }
};

var collected = JSON.parse(collectedJson || "[]");
var failures  = JSON.parse(failuresJson  || "[]");

var high = Number(thresholdHighPct);
var band = Number(bandWidthPct);
var medFloor = high - band;
var lowFloor = high - (2 * band);

// ── Band assignment ──────────────────────────────────────────────────────────
var critical = [];
var warning  = [];
var advisory = [];
var unbanded = 0;

// P-37: identity is vCenter + MoRef, never the display name.
var seen = {};

for (var i = 0; i < collected.length; i++) {
    var r = collected[i];

    var key = String(r.vcenterName || "") + "|" + String(r.moRef || "");
    if (seen[key]) {
        LOG.warn("ANALYSIS", "Duplicate datastore identity " + key +
                             " (" + r.name + ") returned by collection — second occurrence ignored.");
        continue;
    }
    seen[key] = true;

    var pu = Number(r.percentUsed);
    if (isNaN(pu)) {
        unbanded++;
        LOG.warn("ANALYSIS", "Datastore " + r.name + " on " + r.vcenterName +
                             " has an unreadable percentUsed value and cannot be banded.");
        continue;
    }

    if      (pu >= high)     critical.push(r);
    else if (pu >= medFloor) warning.push(r);
    else if (pu >= lowFloor) advisory.push(r);
    else                     unbanded++;   // below the reporting floor
}

// ── Ordering: worst first, deterministic ties ────────────────────────────────
// A report whose row order changes between runs on identical data cannot be
// diffed by eye, so ties resolve on stable fields rather than collection order.
function byUrgency(a, b) {
    var d = Number(b.percentUsed) - Number(a.percentUsed);
    if (d !== 0) return d;
    d = Number(a.freeSpaceGB) - Number(b.freeSpaceGB);
    if (d !== 0) return d;
    var av = String(a.vcenterName || ""), bv = String(b.vcenterName || "");
    if (av !== bv) return av < bv ? -1 : 1;
    var an = String(a.name || ""), bn = String(b.name || "");
    return an < bn ? -1 : (an > bn ? 1 : 0);
}
critical.sort(byUrgency);
warning.sort(byUrgency);
advisory.sort(byUrgency);

// ── Overcommit tally (reported as an attribute, never as a filter) ───────────
var overcommitted = 0;
var unknownCommit = 0;
for (var o = 0; o < collected.length; o++) {
    if (collected[o].uncommittedKnown === false) unknownCommit++;
    else if (collected[o].overcommitted === true) overcommitted++;
}

criticalCount = critical.length;
warningCount  = warning.length;
advisoryCount = advisory.length;

bandedJson = JSON.stringify({
    critical: critical,
    warning:  warning,
    advisory: advisory,
    meta: {
        thresholdHighPct:  high,
        bandWidthPct:      band,
        criticalFloor:     high,
        warningFloor:      medFloor,
        advisoryFloor:     lowFloor,
        totalReported:     critical.length + warning.length + advisory.length,
        overcommitted:     overcommitted,
        uncommittedUnknown: unknownCommit
    }
});

// ── Mail subject ─────────────────────────────────────────────────────────────
// The retiring script's subject was
//   "<prefix> | <n> Datastores @ 90%"
// which reported only the top band. It is kept recognisable but now carries all
// three counts, and states plainly when the underlying data is incomplete — a
// recipient must not read a low count as good news when it is really a partial
// scan.
mailSubject = mailSubjectPrefix + " | " +
              criticalCount + " critical / " +
              warningCount  + " warning / " +
              advisoryCount + " advisory";

if (failures.length > 0) {
    mailSubject += " | INCOMPLETE (" + failures.length + " vCenter(s) unreachable)";
    outcome = "COMPLETE_WITH_GAPS";
} else if (criticalCount + warningCount + advisoryCount === 0) {
    outcome = "CLEAN_NO_FINDINGS";
} else {
    outcome = "COMPLETE";
}

LOG.result("ANALYSIS", "Critical (>= " + high + "%): " + criticalCount +
                       " | Warning (" + medFloor + "-" + high + "%): " + warningCount +
                       " | Advisory (" + lowFloor + "-" + medFloor + "%): " + advisoryCount);
LOG.result("ANALYSIS", "Overcommitted: " + overcommitted +
                       " | Uncommitted value unavailable: " + unknownCommit +
                       " | Outcome: " + outcome);

if (unbanded > 0) {
    LOG.ok("ANALYSIS", unbanded + " collected record(s) fell below the reporting floor " +
                       "or could not be banded and are not shown in the report.");
}
