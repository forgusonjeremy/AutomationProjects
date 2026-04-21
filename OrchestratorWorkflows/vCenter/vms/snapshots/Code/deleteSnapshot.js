/**
 * ACTION: _deleteSnapshot
 * Module : com.broadcom.pso.vc.vm.snapshots
 *
 * Executes a single snapshot deletion with full pre-deletion safety checks
 * and pre/post I/O metric capture for governor calibration.
 *
 * VM lookup uses the vRO inventory object model exclusively. The vmMoRef
 * value stored by _getSnapshotCandidates is vm.id exactly as vRO returns it.
 * This action locates the VM by traversing the same inventory tree and
 * matching on .id -- the same property, the same value, guaranteed to match.
 *
 * ── INPUTS ───────────────────────────────────────────────────────────────────
 *   Name                  Type              Description
 *   ──────────────────────────────────────────────────────────────────────────
 *   vcenterSdkConnection  VC:SdkConnection  The vCenter connection to use
 *   vmMoRef               string            vm.id as stored by getSnapshotCandidates
 *   snapshotMoRef         string            snapshot.snapshot.value
 *   snapshotName          string            For log messages
 *   vmName                string            For log messages
 *   datastoreMoRefsJson   string            JSON array of datastore.id strings
 *   dryRun                boolean           When true, skip actual deletion
 *   taskTimeoutSeconds    number            Max seconds to wait for vCenter task
 *
 * ── RETURN TYPE ──────────────────────────────────────────────────────────────
 *   string  JSON result object
 */

var STORAGEMODULE = "com.broadcom.pso.vc.storage";
var startMs       = new Date().getTime();
var timeout       = taskTimeoutSeconds || 1800;
var dsRefs        = JSON.parse(datastoreMoRefsJson || "[]");

var result = {
    success:         false,
    skipped:         false,
    skipReason:      null,
    preMetricsJson:  "[]",
    postMetricsJson: "[]",
    durationMs:      0,
    error:           null
};

try {
    // ── Locate VM by traversing vRO inventory tree ────────────────────────────
    // vmMoRef is vm.id exactly as stored by _getSnapshotCandidates.
    // We traverse the same inventory path and match on .id directly.
    var vm = findVmById(vcenterSdkConnection.rootFolder, vmMoRef);

    if (!vm) {
        result.skipped    = true;
        result.skipReason = "VM with id '" + vmMoRef + "' not found in inventory. " +
                            "The VM may have been deleted or moved since the scan ran.";
        result.durationMs = new Date().getTime() - startMs;
        return JSON.stringify(result);
    }

    // ── Safety: template check ────────────────────────────────────────────────
    if (vm.config && vm.config.template) {
        result.skipped    = true;
        result.skipReason = "VM is a template -- templates are never modified";
        result.durationMs = new Date().getTime() - startMs;
        return JSON.stringify(result);
    }

    // ── Safety: active conflicting task check ─────────────────────────────────
    if (vm.recentTask) {
        for (var ti = 0; ti < vm.recentTask.length; ti++) {
            var t  = vm.recentTask[ti];
            var ts = t.info.state.value;
            var td = t.info.descriptionId || "";
            if (ts === "running" &&
                (td.indexOf("snapshot") !== -1 || td.indexOf("backup")   !== -1 ||
                 td.indexOf("clone")    !== -1 || td.indexOf("migrate")  !== -1 ||
                 td.indexOf("relocate") !== -1)) {
                result.skipped    = true;
                result.skipReason = "Conflicting task active on VM (" + td + ")";
                result.durationMs = new Date().getTime() - startMs;
                return JSON.stringify(result);
            }
        }
    }

    // ── Safety: host connectivity check ──────────────────────────────────────
    if (vm.runtime && vm.runtime.host) {
        var host = vm.runtime.host;
        if (host.runtime && host.runtime.connectionState) {
            var cs = host.runtime.connectionState.value;
            if (cs === "disconnected" || cs === "notResponding") {
                result.skipped    = true;
                result.skipReason = "Host " + host.name + " is " + cs +
                                    " -- skipping to avoid data loss during possible HA event";
                result.durationMs = new Date().getTime() - startMs;
                return JSON.stringify(result);
            }
        }
    }

    // ── Safety: confirm snapshot still exists ─────────────────────────────────
    var snapObj = null;
    if (vm.snapshot && vm.snapshot.rootSnapshotList) {
        snapObj = findSnapshot(vm.snapshot.rootSnapshotList, snapshotMoRef);
    }
    if (!snapObj) {
        // Diagnostic: log the first snapshot's .value to check format vs snapshotMoRef
        if (vm.snapshot && vm.snapshot.rootSnapshotList &&
            vm.snapshot.rootSnapshotList.length > 0) {
            var firstSnap = vm.snapshot.rootSnapshotList[0];
            System.warn("deleteSnapshot: snapshot not found. " +
                "Looking for snapshotMoRef='" + snapshotMoRef + "' " +
                "(type=" + typeof snapshotMoRef + "). " +
                "First snap in tree: snap.snapshot=" + firstSnap.snapshot +
                " .value='" + firstSnap.snapshot.value + "' " +
                " .type='" + firstSnap.snapshot.type + "' " +
                "name='" + firstSnap.name + "'");
        } else {
            System.warn("deleteSnapshot: snapshot not found and VM has no snapshots. " +
                "snapshotMoRef='" + snapshotMoRef + "' VM=" + vmName);
        }
        result.skipped    = true;
        result.skipReason = "Snapshot not found: snapshotMoRef='" + snapshotMoRef +
                            "' -- check diagnostic log for format details";
        result.durationMs = new Date().getTime() - startMs;
        return JSON.stringify(result);
    }

    // ── Dry run ───────────────────────────────────────────────────────────────
    if (dryRun) {
        result.success    = true;
        result.durationMs = new Date().getTime() - startMs;
        return JSON.stringify(result);
    }

    // ── Sample pre-deletion I/O metrics ──────────────────────────────────────
    var preMetrics = [];
    for (var pi = 0; pi < dsRefs.length; pi++) {
        try {
            preMetrics.push(JSON.parse(
                System.getModule(STORAGEMODULE)
                    ._getDatastoreMetrics(vcenterSdkConnection, dsRefs[pi])));
        } catch (me) {
            System.warn("deleteSnapshot: pre-metrics failed for " +
                        dsRefs[pi] + ": " + me.message);
        }
    }
    result.preMetricsJson = JSON.stringify(preMetrics);

    // ── Execute deletion ──────────────────────────────────────────────────────
    System.log("Deleting: VM=" + vmName + " snap=" + snapshotName);
    var delTask = snapObj.snapshot.removeSnapshot_Task(false);

    // Poll by re-fetching the task state via the task MoRef through the
    // vRO task manager. VcTask.update() does not exist in vRO 8.17 Polyglot.
    // Instead we poll Server.getTask() which re-fetches the task from vCenter.
    var taskMoRef  = delTask.id;
    var waited     = 0;
    var finalState = "running";

    while (waited < timeout * 1000) {
        System.sleep(5000);
        waited += 5000;
        try {
            var refreshedTask = Server.getTask(taskMoRef);
            if (refreshedTask && refreshedTask.info) {
                finalState = refreshedTask.info.state.value;
                if (finalState === "success") break;
                if (finalState === "error") {
                    result.error      = refreshedTask.info.error
                        ? refreshedTask.info.error.localizedMessage
                        : "vCenter task returned error state";
                    result.durationMs = new Date().getTime() - startMs;
                    return JSON.stringify(result);
                }
            }
        } catch (pe) {
            // Task may have completed and been garbage collected -- try
            // confirming by checking VM snapshot list directly
            System.warn("deleteSnapshot: task poll error: " + pe.message +
                        " -- checking VM snapshot list to confirm");
            var vmRefreshed = findVmById(vcenterSdkConnection.rootFolder, vmMoRef);
            if (vmRefreshed) {
                var stillExists = false;
                if (vmRefreshed.snapshot && vmRefreshed.snapshot.rootSnapshotList) {
                    stillExists = !!findSnapshot(
                        vmRefreshed.snapshot.rootSnapshotList, snapshotMoRef);
                }
                if (!stillExists) {
                    finalState = "success";
                    break;
                }
            }
        }
    }

    if (finalState !== "success") {
        result.error      = "Task timed out or did not complete after " +
                            timeout + "s (last state: " + finalState + ")";
        result.durationMs = new Date().getTime() - startMs;
        return JSON.stringify(result);
    }

    // ── Sample post-deletion I/O metrics ─────────────────────────────────────
    System.sleep(10000);
    var postMetrics = [];
    for (var poi = 0; poi < dsRefs.length; poi++) {
        try {
            postMetrics.push(JSON.parse(
                System.getModule(STORAGEMODULE)
                    ._getDatastoreMetrics(vcenterSdkConnection, dsRefs[poi])));
        } catch (me2) {
            System.warn("deleteSnapshot: post-metrics failed for " +
                        dsRefs[poi] + ": " + me2.message);
        }
    }
    result.postMetricsJson = JSON.stringify(postMetrics);
    result.success         = true;
    result.durationMs      = new Date().getTime() - startMs;

    System.log("Deleted: VM=" + vmName + " snap=" + snapshotName +
               " duration=" + Math.round(result.durationMs / 1000) + "s");

} catch (e) {
    result.error      = e.message;
    result.durationMs = new Date().getTime() - startMs;
    System.error("deleteSnapshot error: VM=" + vmName +
                 " snap=" + snapshotName + " err=" + e.message);
}

return JSON.stringify(result);

// ── Find VM by .id in the vRO inventory tree ──────────────────────────────────
// Mirrors the traversal in _getSnapshotCandidates so the same vm.id value
// that was stored during enumeration is used here for the lookup.
function findVmById(folder, targetId) {
    if (!folder || !folder.childEntity) return null;
    for (var i = 0; i < folder.childEntity.length; i++) {
        var child = folder.childEntity[i];
        if (!child) continue;

        // Check if this child is the VM we want
        if (child.id === targetId) return child;

        // Recurse based on inventory type
        var type = child.vimType || child.sdkType || "";
        if (type === "Datacenter" || child.vmFolder !== undefined) {
            if (child.vmFolder) {
                var found = findVmById(child.vmFolder, targetId);
                if (found) return found;
            }
        } else if (child.childEntity !== undefined) {
            var found2 = findVmById(child, targetId);
            if (found2) return found2;
        }
    }
    return null;
}

// ── Find snapshot by MoRef value in snapshot tree ────────────────────────────
function findSnapshot(snapList, moRefValue) {
    var targetStr = String(moRefValue);
    for (var i = 0; i < snapList.length; i++) {
        var s = snapList[i];
        if (s.snapshot) {
            // Try direct value comparison first
            if (s.snapshot.value === moRefValue) return s;
            // Try string coercion -- Polyglot runtime may return MoRef object
            // whose .value property serialises differently than a plain string
            if (String(s.snapshot.value) === targetStr) return s;
            // Try matching on the full MoRef string representation
            // e.g. "snapshot-2" vs "2" -- strip the type prefix if present
            var rawVal = String(s.snapshot.value);
            var dashIdx = rawVal.lastIndexOf("-");
            if (dashIdx !== -1 && rawVal.substring(dashIdx + 1) === targetStr) return s;
            if (dashIdx !== -1 && targetStr.lastIndexOf("-") !== -1 &&
                targetStr.substring(targetStr.lastIndexOf("-") + 1) === rawVal.substring(dashIdx + 1)) return s;
        }
        if (s.childSnapshotList && s.childSnapshotList.length > 0) {
            var found = findSnapshot(s.childSnapshotList, moRefValue);
            if (found) return found;
        }
    }
    return null;
}
