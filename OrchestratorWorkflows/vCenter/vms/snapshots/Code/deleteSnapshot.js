/**
 * ACTION: deleteSnapshot
 * Module : com.company.snapshotcleanup
 *
 * Executes a single snapshot deletion (removeChildren=false) with full
 * pre-deletion safety checks and pre/post I/O metric capture for governor
 * calibration.
 *
 * INPUT PARAMETERS:
 *   vcenterSdkConnection : VC:SdkConnection
 *   vmMoRef              : string
 *   snapshotMoRef        : string
 *   snapshotName         : string   — for logging
 *   vmName               : string   — for logging
 *   datastoreMoRefsJson  : string   — JSON array of datastore MoRef strings
 *   dryRun               : boolean  — when true, skip actual deletion
 *   taskTimeoutSeconds   : number   — max wait for vCenter task
 *
 * RETURN TYPE: string (JSON object)
 *   {
 *     success, skipped, skipReason,
 *     preMetricsJson, postMetricsJson,
 *     durationMs, error
 *   }
 */

var MODULE   = "com.company.snapshotcleanup";
var startMs  = new Date().getTime();
var timeout  = taskTimeoutSeconds || 1800;
var dsRefs   = JSON.parse(datastoreMoRefsJson || "[]");
var result   = {
    success: false, skipped: false, skipReason: null,
    preMetricsJson: "[]", postMetricsJson: "[]",
    durationMs: 0, error: null
};

try {
    var vm = VcPlugin.findEntityById("VirtualMachine:" + vmMoRef, vcenterSdkConnection);
    if (!vm) {
        result.skipped = true;
        result.skipReason = "VM not found (may have been deleted): " + vmMoRef;
        return JSON.stringify(result);
    }

    if (vm.config && vm.config.template) {
        result.skipped = true; result.skipReason = "VM is a template";
        return JSON.stringify(result);
    }

    // Safety: check for conflicting active tasks
    var activeTasks = vm.recentTask;
    if (activeTasks) {
        for each (var task in activeTasks) {
            var ts  = task.info.state.value;
            var td  = task.info.descriptionId || "";
            if (ts === "running" &&
                (td.indexOf("snapshot") !== -1 || td.indexOf("backup")   !== -1 ||
                 td.indexOf("clone")    !== -1 || td.indexOf("migrate")  !== -1 ||
                 td.indexOf("relocate") !== -1)) {
                result.skipped    = true;
                result.skipReason = "Conflicting task active on VM (" + td + ")";
                return JSON.stringify(result);
            }
        }
    }

    // Safety: check host connectivity
    var host = vm.runtime.host;
    if (host && host.runtime && host.runtime.connectionState) {
        var cs = host.runtime.connectionState.value;
        if (cs === "disconnected" || cs === "notResponding") {
            result.skipped    = true;
            result.skipReason = "Host " + host.name + " is " + cs + " — possible HA event";
            return JSON.stringify(result);
        }
    }

    // Safety: confirm snapshot still exists
    var snapObj = null;
    if (vm.snapshot && vm.snapshot.rootSnapshotList)
        snapObj = findSnapshot(vm.snapshot.rootSnapshotList, snapshotMoRef);
    if (!snapObj) {
        result.skipped    = true;
        result.skipReason = "Snapshot no longer exists (already deleted or consolidated)";
        return JSON.stringify(result);
    }

    // Dry run — log and return
    if (dryRun) {
        result.success    = true;
        result.durationMs = new Date().getTime() - startMs;
        System.log("[DRY-RUN] Would delete: VM=" + vmName + " snap=" + snapshotName);
        return JSON.stringify(result);
    }

    // Sample pre-deletion metrics
    var preMetrics = [];
    for each (var dsRef in dsRefs) {
        var m = JSON.parse(System.getModule(MODULE).getDatastoreMetrics(vcenterSdkConnection, dsRef));
        preMetrics.push(m);
    }
    result.preMetricsJson = JSON.stringify(preMetrics);

    // Execute deletion
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
            result.error      = task.info.error ? task.info.error.localizedMessage : "Unknown task error";
            result.durationMs = new Date().getTime() - startMs;
            return JSON.stringify(result);
        }
    }

    if (task.info.state.value !== "success") {
        result.error      = "Task timed out after " + timeout + " seconds";
        result.durationMs = new Date().getTime() - startMs;
        return JSON.stringify(result);
    }

    // Settle then sample post-deletion metrics
    System.sleep(10000);
    var postMetrics = [];
    for each (var dsRef2 in dsRefs) {
        var m2 = JSON.parse(System.getModule(MODULE).getDatastoreMetrics(vcenterSdkConnection, dsRef2));
        postMetrics.push(m2);
    }
    result.postMetricsJson = JSON.stringify(postMetrics);
    result.success         = true;
    result.durationMs      = new Date().getTime() - startMs;

    System.log("Deleted: VM=" + vmName + " snap=" + snapshotName +
               " duration=" + Math.round(result.durationMs / 1000) + "s");

} catch (e) {
    result.error      = e.message;
    result.durationMs = new Date().getTime() - startMs;
    System.error("deleteSnapshot error: VM=" + vmName + " snap=" + snapshotName + " err=" + e.message);
}

return JSON.stringify(result);

function findSnapshot(snapList, moRefValue) {
    for each (var s in snapList) {
        if (s.snapshot && s.snapshot.value === moRefValue) return s;
        if (s.childSnapshotList && s.childSnapshotList.length > 0) {
            var f = findSnapshot(s.childSnapshotList, moRefValue);
            if (f) return f;
        }
    }
    return null;
}