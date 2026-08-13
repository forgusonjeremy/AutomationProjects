/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ST-01 INITIALISE RUN
 * ─────────────────────────────────────────────────────────────────────────────
 * Validates the operator inputs, stamps a run ID, derives the reporting bands
 * and resolves the list of vCenter connections to scan.
 *
 * Everything that can be rejected on bad input is rejected HERE, before a single
 * vCenter is contacted, so a mistyped threshold or an empty recipient list fails
 * in the first second of the run rather than after a full inventory sweep.
 *
 * ── INPUTS ───────────────────────────────────────────────────────────────────
 *   Name                 vRO Type                Source
 *   ─────────────────────────────────────────────────────────────────────────────
 *   vCenterConnections   Array/VC:SdkConnection  Workflow Input (may be empty)
 *   thresholdHighPct     number                  Workflow Input (default 90)
 *   bandWidthPct         number                  Workflow Input (default 10)
 *   sendEmail            boolean                 Workflow Input (default true)
 *   smtpHost             string                  Workflow Input
 *   mailFrom             string                  Workflow Input
 *   mailTo               Array/string            Workflow Input
 *
 * ── OUTPUTS ──────────────────────────────────────────────────────────────────
 *   Name                 vRO Type                Description
 *   ─────────────────────────────────────────────────────────────────────────────
 *   runId                string                  DSR-YYYY-MM-DDTHH-MM-SS
 *   startedAtIso         string                  Human-readable start stamp
 *   targetConnections    Array/VC:SdkConnection  Connections that will be scanned
 *   collectedJson        string                  Initialised to "[]"
 *   failuresJson         string                  Initialised to "[]"
 *   skippedJson          string                  Initialised to "[]"
 *   outcome              string                  Initialised to "RUNNING"
 */

var LOG = {
    ok:   function(p,m){ System.log(  "[DATASTORE-REPORT] ["+p+"] [OK]     "+m); },
    warn: function(p,m){ System.warn( "[DATASTORE-REPORT] ["+p+"] [WARN]   "+m); },
    fail: function(p,m){ System.error("[DATASTORE-REPORT] ["+p+"] [FAIL]   "+m); }
};

// ── Run identity ─────────────────────────────────────────────────────────────
function pad2(n) { return (n < 10 ? "0" : "") + n; }

var now = new Date();
var stamp = now.getFullYear() + "-" + pad2(now.getMonth() + 1) + "-" + pad2(now.getDate()) +
            "T" + pad2(now.getHours()) + "-" + pad2(now.getMinutes()) + "-" + pad2(now.getSeconds());

runId        = "DSR-" + stamp;
startedAtIso = now.getFullYear() + "-" + pad2(now.getMonth() + 1) + "-" + pad2(now.getDate()) +
               " " + pad2(now.getHours()) + ":" + pad2(now.getMinutes()) + ":" + pad2(now.getSeconds());

LOG.ok("STARTUP", "Run " + runId + " starting at " + startedAtIso);

// ── Threshold validation ─────────────────────────────────────────────────────
// The bands are derived, not independently entered, so they cannot be made to
// overlap or invert by operator error. Only the top of the range and the band
// width are configurable.
var high = Number(thresholdHighPct);
var band = Number(bandWidthPct);

if (isNaN(high) || high <= 0 || high > 100) {
    throw "thresholdHighPct must be a number greater than 0 and no more than 100 — received '" +
          thresholdHighPct + "'.";
}
if (isNaN(band) || band <= 0) {
    throw "bandWidthPct must be a number greater than 0 — received '" + bandWidthPct + "'.";
}
if ((high - (2 * band)) <= 0) {
    throw "thresholdHighPct (" + high + ") and bandWidthPct (" + band + ") produce a reporting " +
          "floor of " + (high - (2 * band)) + "%, which is not a usable threshold. " +
          "Require thresholdHighPct > 2 x bandWidthPct.";
}

var reportingFloorPct = high - (2 * band);
LOG.ok("STARTUP", "Bands: Critical >= " + high + "%, Warning " + (high - band) + "-" + high +
                  "%, Advisory " + reportingFloorPct + "-" + (high - band) +
                  "%. Reporting floor " + reportingFloorPct + "% used.");

// ── Mail validation (done up front, not at send time) ────────────────────────
// A report that is collected successfully and then cannot be delivered is a
// wasted inventory sweep across every vCenter in the estate. Validate now.
if (sendEmail === true) {
    if (!smtpHost || String(smtpHost).length === 0) {
        throw "sendEmail is true but smtpHost is empty. Set the SMTP relay host or set sendEmail to false.";
    }
    if (!mailFrom || String(mailFrom).indexOf("@") < 0) {
        throw "sendEmail is true but mailFrom ('" + mailFrom + "') is not an email address.";
    }
    var validTo = 0;
    if (mailTo) {
        for (var t = 0; t < mailTo.length; t++) {
            if (mailTo[t] && String(mailTo[t]).indexOf("@") > 0) validTo++;
        }
    }
    if (validTo === 0) {
        throw "sendEmail is true but mailTo contains no valid recipient address.";
    }
    LOG.ok("STARTUP", "Mail enabled: " + validTo + " recipient(s) via " + smtpHost + ".");
} else {
    LOG.ok("STARTUP", "Mail disabled — the report will be written to the workflow log " +
                      "and returned as a workflow output only.");
}

// ── Resolve the vCenters to scan ─────────────────────────────────────────────
// An empty input means "every vCenter registered in this Orchestrator", which
// is the direct equivalent of the var_vCenterList in the retiring playbook but
// without a hardcoded hostname list to maintain. Naming specific connections
// narrows the run.
var resolved = [];

if (vCenterConnections && vCenterConnections.length > 0) {
    for (var i = 0; i < vCenterConnections.length; i++) {
        if (vCenterConnections[i]) resolved.push(vCenterConnections[i]);
    }
    LOG.ok("STARTUP", "Scanning " + resolved.length + " operator-selected vCenter connection(s).");
} else {
    var all = VcPlugin.allSdkConnections;
    if (all) {
        for (var a = 0; a < all.length; a++) resolved.push(all[a]);
    }
    LOG.ok("STARTUP", "No vCenters specified — scanning all " + resolved.length +
                      " connection(s) registered in Orchestrator.");
}

if (resolved.length === 0) {
    throw "No vCenter connections available. Register at least one vCenter under " +
          "Administration > vCenter Server, or pass connections in the vCenterConnections input.";
}

for (var v = 0; v < resolved.length; v++) {
    var label = "unknown";
    try { label = resolved[v].name || resolved[v].url; } catch (eN) { label = "unknown"; }
    LOG.ok("STARTUP", "  Target: " + label);
}

targetConnections = resolved;

// ── Initialise accumulators ──────────────────────────────────────────────────
collectedJson = "[]";
failuresJson  = "[]";
skippedJson   = "[]";
outcome       = "RUNNING";
