/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ST-02 COLLECT DATASTORES ACROSS EVERY TARGET vCENTER
 * ─────────────────────────────────────────────────────────────────────────────
 * Calls getDatastoreCapacity once per vCenter connection and merges the results
 * into one flat array.
 *
 * THE POINT OF THIS TASK IS THE try/catch.
 * The retiring PowerShell ran Connect-VIServer with -ErrorAction Stop inside the
 * vCenter loop and had no exception handling around it. One unreachable vCenter
 * out of five therefore terminated the entire script and NO report was sent at
 * all — the failure was total and silent to the recipients, who simply received
 * nothing. Here, a vCenter that cannot be reached is recorded in failuresJson,
 * the remaining vCenters are still scanned, and the report is still produced and
 * delivered with the gap declared on its face (see P-35 and P-38).
 *
 * ── INPUTS ───────────────────────────────────────────────────────────────────
 *   Name                 vRO Type                Source
 *   ─────────────────────────────────────────────────────────────────────────────
 *   targetConnections    Array/VC:SdkConnection  Attribute, set by ST-01
 *   thresholdHighPct     number                  Workflow Input
 *   bandWidthPct         number                  Workflow Input
 *   includeInaccessible  boolean                 Workflow Input
 *   runId                string                  Attribute
 *
 * ── OUTPUTS ──────────────────────────────────────────────────────────────────
 *   Name                 vRO Type   Description
 *   ─────────────────────────────────────────────────────────────────────────────
 *   collectedJson        string     JSON array of datastore records, all vCenters
 *   failuresJson         string     JSON array of { vcenterName, error }
 *   skippedJson          string     JSON array of { vcenterName, name, moRef, reason }
 *   scanSummaryJson      string     JSON run-level counters for the report header
 */

var LOG = {
    ok:   function(p,m){ System.log(  "[DATASTORE-REPORT] ["+p+"] [OK]     "+m); },
    warn: function(p,m){ System.warn( "[DATASTORE-REPORT] ["+p+"] [WARN]   "+m); },
    fail: function(p,m){ System.error("[DATASTORE-REPORT] ["+p+"] [FAIL]   "+m); }
};

var MODULE = "com.broadcom.pso.vc.storage.reporting";

var reportingFloorPct = Number(thresholdHighPct) - (2 * Number(bandWidthPct));

var collected = [];
var failures  = [];
var skippedAll = [];
var totalSeen = 0;
var scannedOk = 0;

LOG.ok("INVENTORY", "Scanning " + targetConnections.length + " vCenter(s) for datastores at or above " +
                    reportingFloorPct + "% used.");

for (var i = 0; i < targetConnections.length; i++) {
    var conn   = targetConnections[i];
    var vcName = "unknown";
    try { vcName = conn.name || conn.url || "unknown"; } catch (eN) { vcName = "unknown"; }

    try {
        var raw = System.getModule(MODULE).getDatastoreCapacity(
                      conn,
                      reportingFloorPct,
                      includeInaccessible === true);

        var res = JSON.parse(raw);

        totalSeen += Number(res.totalSeen || 0);
        scannedOk++;

        for (var d = 0; d < res.datastores.length; d++) {
            collected.push(res.datastores[d]);
        }

        for (var s = 0; s < res.skipped.length; s++) {
            skippedAll.push({
                vcenterName: res.vcenterName,
                name:        res.skipped[s].name,
                moRef:       res.skipped[s].moRef,
                reason:      res.skipped[s].reason
            });
        }

        LOG.ok("INVENTORY", "  " + res.vcenterName + ": " + res.datastores.length +
                            " of " + res.totalSeen + " datastore(s) at or above the floor" +
                            (res.skipped.length > 0
                                ? ", " + res.skipped.length + " could not be evaluated."
                                : "."));

    } catch (e) {
        // Isolate the failure to this vCenter. Do not rethrow.
        LOG.fail("INVENTORY", "  " + vcName + " could not be scanned — " + e.message +
                              "  (the remaining vCenters will still be scanned and the " +
                              "report will declare this gap)");
        failures.push({ vcenterName: vcName, error: String(e.message || e) });
    }
}

collectedJson = JSON.stringify(collected);
failuresJson  = JSON.stringify(failures);
skippedJson   = JSON.stringify(skippedAll);

scanSummaryJson = JSON.stringify({
    runId:               runId,
    startedAtIso:        startedAtIso,
    vcentersRequested:   targetConnections.length,
    vcentersScanned:     scannedOk,
    totalDatastoresSeen: totalSeen
});

if (failures.length > 0) {
    LOG.warn("INVENTORY", "Collection finished with gaps — " + scannedOk + " of " +
                          targetConnections.length + " vCenter(s) scanned successfully. " +
                          collected.length + " datastore(s) collected.");
} else {
    LOG.ok("INVENTORY", "Collection complete — all " + scannedOk + " vCenter(s) scanned. " +
                        totalSeen + " datastore(s) inspected, " + collected.length +
                        " at or above the " + reportingFloorPct + "% floor.");
}
