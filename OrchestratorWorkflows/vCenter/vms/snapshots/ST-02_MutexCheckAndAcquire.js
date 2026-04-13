/**
 * ST-02  MUTEX CHECK & ACQUIRE
 * ─────────────────────────────────────────────────────────────────────────────
 * Checks whether another run is already in progress. If yes, this run
 * aborts immediately -- nothing is touched. If no, claims the lock so no
 * other run can start while this one is running.
 *
 * WORKFLOW ATTRIBUTE INPUTS : runId
 * WORKFLOW ATTRIBUTE OUTPUTS: lockEl (ConfigurationElement)
 *
 * THROWS:
 *   "ABORT: Another run is active..." -- routes to Exception Handler (MUTEX_ABORT)
 */

var LOG = {
    ok:   function(p,m){ System.log(  "[SNAPSHOT-CLEANUP] ["+p+"] [OK]      "+m); },
    warn: function(p,m){ System.warn( "[SNAPSHOT-CLEANUP] ["+p+"] [WARN]    "+m); },
    fail: function(p,m){ System.error("[SNAPSHOT-CLEANUP] ["+p+"] [FAIL]    "+m); }
};

// Resolve config element
var cat = Server.getConfigurationElementCategoryWithPath("SnapshotCleanup");
if (!cat) throw new Error(
    "Configuration category 'SnapshotCleanup' not found. "
  + "Create it and the RuntimeState element before running this workflow.");

lockEl = null;
for each (var el in cat.configurationElements) {
    if (el.name === "RuntimeState") { lockEl = el; break; }
}
if (!lockEl) throw new Error(
    "Configuration element 'SnapshotCleanup/RuntimeState' not found. "
  + "Create it with a 'runLock' string attribute set to empty string.");

// Check lock
var held = lockEl.getAttributeWithKey("runLock").value || "";
if (held !== "") {
    var msg = "ABORT: Another cleanup run is already in progress (run ID: " + held + "). "
            + "This run (" + runId + ") will not start. "
            + "If you are certain no run is active, clear the runLock attribute in "
            + "SnapshotCleanup/RuntimeState and try again.";
    LOG.warn("STARTUP", msg);
    throw new Error("ABORT: Another run is active (lock held by: " + held
                  + "). New run " + runId + " will not proceed.");
}

// Acquire lock
lockEl.setAttributeWithKey("runLock", runId);
LOG.ok("STARTUP", "Lock acquired -- this is the only active cleanup run  [" + runId + "]");
