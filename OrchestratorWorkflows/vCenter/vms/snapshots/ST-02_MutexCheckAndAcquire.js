/**
 * ST-02  MUTEX CHECK & ACQUIRE
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads the runLock attribute from SnapshotCleanup/RuntimeState.
 * Throws (routes to Exception Handler) if the lock is already held.
 * Acquires the lock when free.
 *
 * WORKFLOW ATTRIBUTE INPUTS : runId (string)
 * WORKFLOW ATTRIBUTE OUTPUTS: lockEl (ConfigurationElement)
 *
 * THROWS:
 *   "ABORT: Another run is active..." — Exception Handler treats as MUTEX_ABORT
 *   "Configuration element not found" — genuine error
 */

var cat = Server.getConfigurationElementCategoryWithPath("SnapshotCleanup");
if (!cat) throw new Error(
    "Configuration category 'SnapshotCleanup' not found. " +
    "Create it and the RuntimeState element before running this workflow.");

lockEl = null;
for each (var el in cat.configurationElements) {
    if (el.name === "RuntimeState") { lockEl = el; break; }
}
if (!lockEl) throw new Error(
    "Configuration element 'SnapshotCleanup/RuntimeState' not found. " +
    "Create it with a 'runLock' string attribute (default: empty string).");

var currentLock = lockEl.getAttributeWithKey("runLock").value || "";
if (currentLock !== "") {
    var msg = "ABORT: Another run is active (lock held by: " + currentLock +
              "). New run " + runId + " will not proceed.";
    System.warn(msg);
    throw new Error(msg);
}

lockEl.setAttributeWithKey("runLock", runId);
System.log("[ST-02] Mutex acquired: " + runId);
