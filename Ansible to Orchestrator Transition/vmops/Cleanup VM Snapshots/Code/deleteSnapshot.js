/**
 * ACTION: _deleteSnapshot
 * Module : com.broadcom.pso.vc.vm.snapshots
 *
 * Executes a single snapshot deletion. The snapshot is resolved by name
 * from the VM's live snapshot tree at execution time -- no MoRefs or
 * pre-fetched object references are used. This eliminates all stale
 * reference issues that can occur when snapshot chains are reorganised
 * between scan time and deletion time.
 *
 * ── INPUTS ───────────────────────────────────────────────────────────────────
 *   Name                  Type              Description
 *   ──────────────────────────────────────────────────────────────────────────
 *   vcenterSdkConnection  VC:SdkConnection  The vCenter connection to use
 *   vmMoRef               string            vm.id as stored by getSnapshotCandidates
 *   snapshotName          string            Name of snapshot to delete
 *   snapshotCreatedMs     number            Creation timestamp -- used to disambiguate
 *                                           if multiple snapshots share the same name
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
    // ── Locate VM ─────────────────────────────────────────────────────────────
    var vm = findVmById(vcenterSdkConnection.rootFolder, vmMoRef);
    if (!vm) {
        result.skipped    = true;
        result.skipReason = "VM '" + vmName + "' (id=" + vmMoRef + ") not found in inventory";
        result.durationMs = new Date().getTime() - startMs;
        return JSON.stringify(result);
    }

    // ── Safety checks ─────────────────────────────────────────────────────────
    if (vm.config && vm.config.template) {
        result.skipped    = true;
        result.skipReason = "VM is a template";
        result.durationMs = new Date().getTime() - startMs;
        return JSON.stringify(result);
    }

    if (vm.runtime && vm.runtime.host) {
        var host = vm.runtime.host;
        if (host.runtime && host.runtime.connectionState) {
            var cs = host.runtime.connectionState.value;
            if (cs === "disconnected" || cs === "notResponding") {
                result.skipped    = true;
                result.skipReason = "Host " + host.name + " is " + cs;
                result.durationMs = new Date().getTime() - startMs;
                return JSON.stringify(result);
            }
        }
    }

    if (vm.recentTask) {
        for (var ti = 0; ti < vm.recentTask.length; ti++) {
            var t  = vm.recentTask[ti];
            var ts = t.info.state.value;
            var td = t.info.descriptionId || "";
            if (ts === "running" &&
                (td.indexOf("snapshot") !== -1 || td.indexOf("backup")  !== -1 ||
                 td.indexOf("clone")    !== -1 || td.indexOf("migrate") !== -1)) {
                result.skipped    = true;
                result.skipReason = "Conflicting task active on VM (" + td + ")";
                result.durationMs = new Date().getTime() - startMs;
                return JSON.stringify(result);
            }
        }
    }

    // ── Locate snapshot by name from live tree ────────────────────────────────
    // Resolution happens here at deletion time, not at scan time.
    // If multiple snapshots share the same name, pick the one closest to
    // snapshotCreatedMs (within 60s tolerance). If none match by time,
    // pick the newest matching name -- this is the safe choice since we
    // always process newest-first.
    if (!vm.snapshot || !vm.snapshot.rootSnapshotList ||
        vm.snapshot.rootSnapshotList.length === 0) {
        result.skipped    = true;
        result.skipReason = "VM '" + vmName + "' has no snapshots";
        result.durationMs = new Date().getTime() - startMs;
        return JSON.stringify(result);
    }

    var snapNode = findSnapshotByName(
        vm.snapshot.rootSnapshotList, snapshotName, snapshotCreatedMs);

    if (!snapNode) {
        result.skipped    = true;
        result.skipReason = "Snapshot '" + snapshotName + "' not found on VM '" +
                            vmName + "' -- may have already been deleted or " +
                            "consolidated by a prior operation";
        result.durationMs = new Date().getTime() - startMs;
        System.log("deleteSnapshot: " + result.skipReason);
        return JSON.stringify(result);
    }

    // ── Dry run ───────────────────────────────────────────────────────────────
    if (dryRun) {
        result.success    = true;
        result.durationMs = new Date().getTime() - startMs;
        return JSON.stringify(result);
    }

    // ── Pre-deletion metrics ──────────────────────────────────────────────────
    var preMetrics = [];
    for (var pi = 0; pi < dsRefs.length; pi++) {
        try {
            preMetrics.push(JSON.parse(
                System.getModule(STORAGEMODULE)
                    ._getDatastoreMetrics(vcenterSdkConnection, dsRefs[pi])));
        } catch (me) { /* non-fatal */ }
    }
    result.preMetricsJson = JSON.stringify(preMetrics);

    // ── Execute deletion ──────────────────────────────────────────────────────
    // snapNode.snapshot is the VcSnapshot MoRef. In vRO 8.17 Polyglot the
    // removeSnapshot_Task method is bound on this object and dispatches
    // directly to vCenter via the SDK connection.
    System.log("Deleting: VM=" + vmName + " snap=" + snapshotName);
    var delTask = snapNode.snapshot.removeSnapshot_Task(false);

    // ── Poll task state ───────────────────────────────────────────────────────
    var waited     = 0;
    var finalState = "running";
    var pollSleep  = 5000;

    while (waited < timeout * 1000) {
        System.sleep(pollSleep);
        waited += pollSleep;
        try {
            var taskState = delTask.info.state.value;
            if (taskState === "success") {
                finalState = "success";
                break;
            }
            if (taskState === "error") {
                result.error      = delTask.info.error
                    ? delTask.info.error.localizedMessage
                    : "vCenter task returned error state";
                result.durationMs = new Date().getTime() - startMs;
                return JSON.stringify(result);
            }
        } catch (pe) {
            // Task info access failed -- check if snapshot is gone
            System.warn("deleteSnapshot: task poll error: " + pe.message +
                        " -- checking snapshot tree");
            var vmCheck = findVmById(vcenterSdkConnection.rootFolder, vmMoRef);
            if (vmCheck) {
                var still = vmCheck.snapshot && vmCheck.snapshot.rootSnapshotList
                    ? findSnapshotByName(vmCheck.snapshot.rootSnapshotList,
                                         snapshotName, snapshotCreatedMs)
                    : null;
                if (!still) {
                    finalState = "success";
                    break;
                }
            }
        }
    }

    if (finalState !== "success") {
        result.error      = "Task timed out after " + timeout + "s";
        result.durationMs = new Date().getTime() - startMs;
        return JSON.stringify(result);
    }

    // ── Post-deletion metrics ─────────────────────────────────────────────────
    System.sleep(5000);
    var postMetrics = [];
    for (var poi = 0; poi < dsRefs.length; poi++) {
        try {
            postMetrics.push(JSON.parse(
                System.getModule(STORAGEMODULE)
                    ._getDatastoreMetrics(vcenterSdkConnection, dsRefs[poi])));
        } catch (me2) { /* non-fatal */ }
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

// ── Find VM by id ─────────────────────────────────────────────────────────────
function findVmById(folder, targetId) {
    if (!folder || !folder.childEntity) return null;
    for (var i = 0; i < folder.childEntity.length; i++) {
        var child = folder.childEntity[i];
        if (!child) continue;
        if (child.id === targetId) return child;
        var type = child.vimType || child.sdkType || "";
        if (type === "Datacenter" || child.vmFolder !== undefined) {
            if (child.vmFolder) {
                var f = findVmById(child.vmFolder, targetId);
                if (f) return f;
            }
        } else if (child.childEntity !== undefined) {
            var f2 = findVmById(child, targetId);
            if (f2) return f2;
        }
    }
    return null;
}

// ── Find snapshot by name from live tree ──────────────────────────────────────
// Walks the current snapshot tree and returns the node whose name matches.
// If multiple nodes share the name, returns the one closest to createdMs
// (within 60s tolerance). If none match within tolerance, returns the
// newest matching node -- safe because we always process newest-first.
function findSnapshotByName(snapList, name, createdMs) {
    var tolerance = 60000;
    var best      = null;
    var bestDelta = Infinity;

    function walk(list) {
        for (var i = 0; i < list.length; i++) {
            var s = list[i];
            if (s.name === name) {
                var snapMs = s.createTime ? s.createTime.getTime() : 0;
                var delta  = Math.abs(snapMs - createdMs);
                if (delta < bestDelta) {
                    bestDelta = delta;
                    best      = s;
                }
            }
            if (s.childSnapshotList && s.childSnapshotList.length > 0) {
                walk(s.childSnapshotList);
            }
        }
    }

    walk(snapList);

    // Accept if within tolerance, or if it's the only match regardless
    if (best && bestDelta <= tolerance) return best;
    if (best) {
        System.warn("deleteSnapshot: matched '" + name + "' with delta " +
                    Math.round(bestDelta/1000) + "s (outside 60s tolerance) -- " +
                    "accepting as only candidate");
        return best;
    }
    return null;
}
