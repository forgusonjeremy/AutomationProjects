/**
 * ACTION: getSnapshotCandidates
 * Module : com.company.snapshotcleanup
 *
 * Enumerates all VMs on a single vCenter SDK connection, walks each VM's
 * snapshot tree recursively, and returns all snapshots that pass the
 * age / name / description filters.
 *
 * INPUT PARAMETERS (define in vRO Action Inputs tab):
 *   vcenterSdkConnection : VC:SdkConnection  — the vCenter to enumerate
 *   maxAgeMinutes        : number            — delete snapshots older than this
 *   nameMatchString      : string            — whitelist (empty = all names pass)
 *   descIgnoreString     : string            — skip snap if description contains this
 *
 * RETURN TYPE: string (JSON array of candidate objects)
 *
 * CANDIDATE OBJECT SCHEMA:
 *   {
 *     vmMoRef             : string,
 *     vmName              : string,
 *     vmPowerState        : string,   // "poweredOn" | "poweredOff" | "suspended"
 *     snapshotMoRef       : string,
 *     snapshotName        : string,
 *     snapshotDesc        : string,
 *     snapshotCreatedMs   : number,
 *     snapshotAgeMinutes  : number,
 *     datastoreMoRefs     : string[],
 *     parentSnapshotMoRef : string | null
 *   }
 */

var result      = [];
var now         = new Date();
var cutoffMs    = (maxAgeMinutes || 60) * 60 * 1000;
var nameFilter  = (nameMatchString  || "").toLowerCase().trim();
var descIgnore  = (descIgnoreString || "").toLowerCase().trim();

var vms = vcenterSdkConnection.getAllVirtualMachines()

for each (var vm in vms) {
    if (vm.config && vm.config.template) continue;
    if (!vm.snapshot || !vm.snapshot.rootSnapshotList ||
        vm.snapshot.rootSnapshotList.length === 0) continue;

    var vmName      = vm.name;
    var vmMoRef     = vm.id;
    var powerState  = vm.runtime.powerState.value;

    var datastoreMoRefs = [];
    if (vm.datastore) {
        for each (var ds in vm.datastore) {
            datastoreMoRefs.push(ds.id);
        }
    }

    walkSnapshots(vm.snapshot.rootSnapshotList, null,
                  vmMoRef, vmName, powerState, datastoreMoRefs);
}

return JSON.stringify(result);

function walkSnapshots(snapList, parentMoRef, vmMoRef, vmName, powerState, datastoreMoRefs) {
    for each (var snap in snapList) {
        var snapName  = snap.name        || "";
        var snapDesc  = snap.description || "";
        var snapMoRef = snap.snapshot.value;
        var created   = snap.createTime;
        var ageMs     = now.getTime() - created.getTime();

        if (ageMs < cutoffMs) {
            if (snap.childSnapshotList && snap.childSnapshotList.length > 0)
                walkSnapshots(snap.childSnapshotList, snapMoRef, vmMoRef,
                              vmName, powerState, datastoreMoRefs);
            continue;
        }

        if (descIgnore !== "" && snapDesc.toLowerCase().indexOf(descIgnore) !== -1) {
            System.log("SKIP (desc match): VM=" + vmName + " snap=" + snapName);
            if (snap.childSnapshotList && snap.childSnapshotList.length > 0)
                walkSnapshots(snap.childSnapshotList, snapMoRef, vmMoRef,
                              vmName, powerState, datastoreMoRefs);
            continue;
        }

        if (nameFilter !== "" && snapName.toLowerCase().indexOf(nameFilter) === -1) {
            if (snap.childSnapshotList && snap.childSnapshotList.length > 0)
                walkSnapshots(snap.childSnapshotList, snapMoRef, vmMoRef,
                              vmName, powerState, datastoreMoRefs);
            continue;
        }

        result.push({
            vmMoRef:             vmMoRef,
            vmName:              vmName,
            vmPowerState:        powerState,
            snapshotMoRef:       snapMoRef,
            snapshotName:        snapName,
            snapshotDesc:        snapDesc,
            snapshotCreatedMs:   created.getTime(),
            snapshotAgeMinutes:  Math.floor(ageMs / 60000),
            datastoreMoRefs:     datastoreMoRefs,
            parentSnapshotMoRef: parentMoRef
        });

        if (snap.childSnapshotList && snap.childSnapshotList.length > 0)
            walkSnapshots(snap.childSnapshotList, snapMoRef, vmMoRef,
                          vmName, powerState, datastoreMoRefs);
    }
}