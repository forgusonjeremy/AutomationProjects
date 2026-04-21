/**
 * ACTION: deleteSnapshot
 * Module : com.company.snapshotcleanup
 *
 * Executes a single snapshot deletion (removeChildren=false) with full
 * pre-deletion safety checks and pre/post I/O metric capture for governor
 * calibration.
 *
 * ── INPUTS ───────────────────────────────────────────────────────────────────
 *   Name                  Type              Description
 *   ──────────────────────────────────────────────────────────────────────────
 *   vcenterSdkConnection  VC:SdkConnection  The vCenter connection to use
 *   vmMoRef               string            VM managed object reference value
 *   snapshotMoRef         string            Snapshot managed object ref value
 *   snapshotName          string            For log messages
 *   vmName                string            For log messages
 *   datastoreMoRefsJson   string            JSON array of datastore MoRef strings
 *   dryRun                boolean           When true, skip actual deletion
 *   taskTimeoutSeconds    number            Max wait for vCenter task completion
 *
 * ── RETURN TYPE ──────────────────────────────────────────────────────────────
 *   string  JSON object
 *   {
 *     success         : boolean,
 *     skipped         : boolean,
 *     skipReason      : string | null,
 *     preMetricsJson  : string,
 *     postMetricsJson : string,
 *     durationMs      : number,
 *     error           : string | null
 *   }
 */

var MODULE  = "com.company.snapshotcleanup";
var startMs = new Date().getTime();
var timeout = taskTimeoutSeconds || 1800;
var dsRefs  = JSON.parse(datastoreMoRefsJson || "[]");

var result = {
    success:        false,
    skipped:        false,
    skipReason:     null,
    preMetricsJson: "[]",
    postMetricsJson:"[]",
    durationMs:     0,
    error:          null
};

try {
    // ── Locate the VM ─────────────────────────────────────────────────────────
    // VcPlugin.findEntityById does not exist in vRO 8.x Polyglot runtime.
    // Use VcPlugin.findAllForType scoped to the SDK connection instead.
    var allVms = VcPlugin.findAllForType("VirtualMachine", vcenterSdkConnection);
    var vm = null;
    for (var vi = 0; vi < allVms.length; vi++) {
        if (allVms[vi].id === vmMoRef) {
            vm = allVms[vi];
            break;
        }
    }

    if (!vm) {
        result.skipped   = true;
        result.skipReason = "VM not found (may have been deleted or is no longer visible): " + vmMoRef;
        result.durationMs = new Date().getTime() - startMs;
        return JSON.stringify(result);
    }

    // ── Safety: template check ────────────────────────────────────────────────
    if (vm.config && vm.config.template) {
        result.skipped    = true;
        result.skipReason = "VM is a template — templates are never modified";
        result.durationMs = new Date().getTime() - startMs;
        return JSON.stringify(result);
    }

    // ── Safety: active conflicting task check ─────────────────────────────────
    var activeTasks = vm.recentTask;
    if (activeTasks) {
        for (var ti = 0; ti < activeTasks.length; ti++) {
            var task = activeTasks[ti];
            var ts   = task.info.state.value;
            var td   = task.info.descriptionId || "";
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
    var host = vm.runtime && vm.runtime.host;
    if (host && host.runtime && host.runtime.connectionState) {
        var cs = host.runtime.connectionState.value;
        if (cs === "disconnected" || cs === "notResponding") {
            result.skipped    = true;
            result.skipReason = "Host " + host.name + " is " + cs +
                                " — possible HA event, skipping to be safe";
            result.durationMs = new Date().getTime() - startMs;
            return JSON.stringify(result);
        }
    }

    // ── Safety: confirm snapshot still exists ─────────────────────────────────
    var snapObj = null;
    if (vm.snapshot && vm.snapshot.rootSnapshotList) {
        snapObj = findSnapshot(vm.snapshot.rootSnapshotList, snapshotMoRef);
    }
    if (!snapObj) {
        result.skipped    = true;
        result.skipReason = "Snapshot no longer exists (already deleted or consolidated by another process)";
        result.durationMs = new Date().getTime() - startMs;
        return JSON.stringify(result);
    }

    // ── Dry run ───────────────────────────────────────────────────────────────
    if (dryRun) {
        result.success    = true;
        result.durationMs = new Date().getTime() - startMs;
        return JSON.stringify(result);
    }

    // ── Sample pre-deletion metrics ───────────────────────────────────────────
    var preMetrics = [];
    for (var pi = 0; pi < dsRefs.length; pi++) {
        try {
            var pm = JSON.parse(System.getModule(MODULE)
                       .getDatastoreMetrics(vcenterSdkConnection, dsRefs[pi]));
            preMetrics.push(pm);
        } catch (me) {
            System.warn("deleteSnapshot: could not sample pre-metrics for " +
                        dsRefs[pi] + ": " + me.message);
        }
    }
    result.preMetricsJson = JSON.stringify(preMetrics);

    // ── Execute deletion ──────────────────────────────────────────────────────
    System.log("Deleting snapshot: VM=" + vmName + " snap=" + snapshotName);
    var task = snapObj.snapshot.removeSnapshot_Task(false);

    var waited = 0;
    while (waited < timeout * 1000) {
        System.sleep(5000);
        waited += 5000;
        task.update();
        var state = task.info.state.value;
        if (state === "success") break;
        if (state === "error") {
            result.error      = task.info.error
                ? task.info.error.localizedMessage
                : "vCenter task returned error state";
            result.durationMs = new Date().getTime() - startMs;
            return JSON.stringify(result);
        }
    }

    if (task.info.state.value !== "success") {
        result.error      = "Task timed out after " + timeout + " seconds";
        result.durationMs = new Date().getTime() - startMs;
        return JSON.stringify(result);
    }

    // ── Sample post-deletion metrics (after brief settle) ────────────────────
    System.sleep(10000);
    var postMetrics = [];
    for (var poi = 0; poi < dsRefs.length; poi++) {
        try {
            var pm2 = JSON.parse(System.getModule(MODULE)
                        .getDatastoreMetrics(vcenterSdkConnection, dsRefs[poi]));
            postMetrics.push(pm2);
        } catch (me2) {
            System.warn("deleteSnapshot: could not sample post-metrics for " +
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

// ── Snapshot tree finder ──────────────────────────────────────────────────────
function findSnapshot(snapList, moRefValue) {
    for (var i = 0; i < snapList.length; i++) {
        var s = snapList[i];
        if (s.snapshot && s.snapshot.value === moRefValue) return s;
        if (s.childSnapshotList && s.childSnapshotList.length > 0) {
            var found = findSnapshot(s.childSnapshotList, moRefValue);
            if (found) return found;
        }
    }
    return null;
}
