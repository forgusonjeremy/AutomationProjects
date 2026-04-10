/**
 * ACTION: deleteSnapshot
 * vRO Action — deletes a single snapshot (not children) and awaits task completion.
 * Performs pre-deletion safety checks: backup lock, task conflict, HA event.
 * Returns pre and post I/O metrics for governor calibration.
 *
 * Inputs:
 *   vcenterSdkConnection : VC:SdkConnection
 *   vmMoRef              : string   — VM managed object reference value
 *   snapshotMoRef        : string   — Snapshot managed object reference value
 *   snapshotName         : string   — for logging
 *   vmName               : string   — for logging
 *   datastoreMoRefsJson  : string   — JSON array of datastore MoRef strings
 *   dryRun               : boolean  — if true, skip actual deletion
 *   taskTimeoutSeconds   : number   — max wait for vCenter task (default 1800)
 *
 * Returns: JSON string {
 *   success: boolean,
 *   skipped: boolean,
 *   skipReason: string | null,
 *   preMetricsJson: string,   -- array of metric objects (one per datastore)
 *   postMetricsJson: string,
 *   durationMs: number,
 *   error: string | null
 * }
 */

var startMs    = new Date().getTime();
var timeout    = taskTimeoutSeconds || 1800;
var dsRefs     = JSON.parse(datastoreMoRefsJson || "[]");
var result     = { success: false, skipped: false, skipReason: null,
                   preMetricsJson: "[]", postMetricsJson: "[]",
                   durationMs: 0, error: null };

try {
    // Resolve VM object
    var vm = VcPlugin.findEntityById("VirtualMachine:" + vmMoRef, vcenterSdkConnection);
    if (!vm) {
        result.skipped   = true;
        result.skipReason = "VM not found (may have been deleted): " + vmMoRef;
        return JSON.stringify(result);
    }

    // Safety check 1: VM is a template (should not happen after inventory filter, but guard anyway)
    if (vm.config && vm.config.template) {
        result.skipped    = true;
        result.skipReason = "VM is a template, skipping";
        return JSON.stringify(result);
    }

    // Safety check 2: Active backup snapshot lock — detect by checking if any running task
    // on this VM is a CreateSnapshot or BackupAgent task
    var activeTasks = vm.recentTask;
    if (activeTasks) {
        for each (var task in activeTasks) {
            var taskState = task.info.state.value;
            var taskDesc  = task.info.descriptionId || "";
            if (taskState === "running" &&
                (taskDesc.indexOf("snapshot") !== -1 || taskDesc.indexOf("backup") !== -1 ||
                 taskDesc.indexOf("clone") !== -1    || taskDesc.indexOf("migrate") !== -1 ||
                 taskDesc.indexOf("relocate") !== -1)) {
                result.skipped    = true;
                result.skipReason = "Conflicting task active on VM (" + taskDesc + ")";
                return JSON.stringify(result);
            }
        }
    }

    // Safety check 3: vSphere HA failover in progress (check cluster runtime)
    // Check host connection state — if host is disconnected/notResponding, skip
    var host = vm.runtime.host;
    if (host) {
        var hostConnState = host.runtime && host.runtime.connectionState ?
                            host.runtime.connectionState.value : "";
        if (hostConnState === "disconnected" || hostConnState === "notResponding") {
            result.skipped    = true;
            result.skipReason = "Host " + host.name + " is " + hostConnState + " — possible HA event, skipping";
            return JSON.stringify(result);
        }
    }

    // Safety check 4: VM in vMotion or Storage vMotion
    // Check runtime.connectionState — migrating state
    if (vm.runtime && vm.runtime.connectionState) {
        var vmConnState = vm.runtime.connectionState.value;
        // During live migration runtime.powerState stays poweredOn but task queue will show it
        // We already checked activeTasks above for migrate/relocate
    }

    // Resolve snapshot object
    var snapObj = null;
    if (vm.snapshot && vm.snapshot.rootSnapshotList) {
        snapObj = findSnapshotByMoRef(vm.snapshot.rootSnapshotList, snapshotMoRef);
    }
    if (!snapObj) {
        result.skipped    = true;
        result.skipReason = "Snapshot no longer exists (already deleted or consolidated): " + snapshotMoRef;
        return JSON.stringify(result);
    }

    // DRY RUN — log and return without deletion
    if (dryRun) {
        result.success    = true;
        result.skipped    = false;
        result.skipReason = null;
        result.durationMs = new Date().getTime() - startMs;
        System.log("[DRY-RUN] Would delete: VM=" + vmName + " snap=" + snapshotName +
                   " age=" + Math.floor((new Date().getTime() - snapObj.createTime.getTime()) / 60000) + "min");
        return JSON.stringify(result);
    }

    // Sample pre-deletion metrics across all datastores
    var preMetrics = [];
    for each (var dsRef in dsRefs) {
        var mJson = System.getModule("com.company.snapshotcleanup").getDatastoreMetrics(
                        vcenterSdkConnection, dsRef);
        preMetrics.push(JSON.parse(mJson));
    }
    result.preMetricsJson = JSON.stringify(preMetrics);

    // Execute deletion — removeSnapshot_Task(removeChildren=false)
    System.log("Deleting snapshot: VM=" + vmName + " snap=" + snapshotName);
    var task = snapObj.snapshot.removeSnapshot_Task(false);

    // Poll task to completion
    var waited = 0;
    var pollInterval = 5000; // 5 seconds
    while (waited < timeout * 1000) {
        System.sleep(pollInterval);
        waited += pollInterval;
        var taskState = task.info.state.value;
        if (taskState === "success") {
            break;
        } else if (taskState === "error") {
            var errMsg = task.info.error ? task.info.error.localizedMessage : "Unknown task error";
            result.error = "Task failed: " + errMsg;
            result.durationMs = new Date().getTime() - startMs;
            return JSON.stringify(result);
        }
        // Still running — update task to refresh state
        task.update();
    }

    if (task.info.state.value !== "success") {
        result.error = "Task timed out after " + timeout + " seconds";
        result.durationMs = new Date().getTime() - startMs;
        return JSON.stringify(result);
    }

    // Wait a short settle period before post-sample to let I/O stabilise
    System.sleep(10000); // 10 seconds

    // Sample post-deletion metrics
    var postMetrics = [];
    for each (var dsRef2 in dsRefs) {
        var mJson2 = System.getModule("com.company.snapshotcleanup").getDatastoreMetrics(
                         vcenterSdkConnection, dsRef2);
        postMetrics.push(JSON.parse(mJson2));
    }
    result.postMetricsJson = JSON.stringify(postMetrics);
    result.success    = true;
    result.durationMs = new Date().getTime() - startMs;

    System.log("Deleted: VM=" + vmName + " snap=" + snapshotName +
               " duration=" + Math.round(result.durationMs / 1000) + "s");

} catch(e) {
    result.error      = e.message;
    result.durationMs = new Date().getTime() - startMs;
    System.error("deleteSnapshot error: VM=" + vmName + " snap=" + snapshotName + " err=" + e.message);
}

return JSON.stringify(result);

// ---- helpers ----

function findSnapshotByMoRef(snapList, moRefValue) {
    for each (var s in snapList) {
        if (s.snapshot && s.snapshot.value === moRefValue) return s;
        if (s.childSnapshotList && s.childSnapshotList.length > 0) {
            var found = findSnapshotByMoRef(s.childSnapshotList, moRefValue);
            if (found) return found;
        }
    }
    return null;
}
