/**
 * ACTION: getSnapshotCandidates
 * vRO Action — returns array of snapshot candidate objects for a single vCenter.
 *
 * Inputs (vRO Action inputs):
 *   vcenterSdkConnection : VC:SdkConnection
 *   maxAgeMinutes        : number   — delete snapshots older than this many minutes
 *   nameMatchString      : string   — if non-empty, ONLY snapshots whose name contains this (case-insensitive)
 *   descIgnoreString     : string   — snapshots whose description contains this are skipped (case-insensitive)
 *
 * Returns: Array of plain objects (serialised as JSON string for vRO cross-action passing)
 * Each object: {
 *   vmMoRef, vmName, vmPowerState, snapshotMoRef, snapshotName,
 *   snapshotDesc, snapshotCreated, datastoreMoRefs[], parentSnapshotMoRef
 * }
 */

var result = [];
var now = new Date();
var cutoffMs = maxAgeMinutes * 60 * 1000;

var nameFilter   = (nameMatchString  || "").toLowerCase().trim();
var descIgnore   = (descIgnoreString || "").toLowerCase().trim();

// Retrieve all VMs from this vCenter
var vms = VcPlugin.getAllVirtualMachines(vcenterSdkConnection);

for each (var vm in vms) {
    // Skip templates
    if (vm.config && vm.config.template) {
        continue;
    }

    // Skip VMs with no snapshot info
    if (!vm.snapshot || !vm.snapshot.rootSnapshotList || vm.snapshot.rootSnapshotList.length === 0) {
        continue;
    }

    var vmName       = vm.name;
    var vmMoRef      = vm.id;
    var powerState   = vm.runtime.powerState.value; // "poweredOn", "poweredOff", "suspended"

    // Collect datastores for this VM (may span multiple)
    var datastoreMoRefs = [];
    if (vm.datastore) {
        for each (var ds in vm.datastore) {
            datastoreMoRefs.push(ds.id);
        }
    }

    // Walk snapshot tree recursively
    var snapshotList = vm.snapshot.rootSnapshotList;
    walkSnapshots(snapshotList, null, vmMoRef, vmName, powerState, datastoreMoRefs);
}

/**
 * Recursive snapshot tree walker.
 * vRO ES6 runtime — use named function expression for recursion.
 */
function walkSnapshots(snapList, parentMoRef, vmMoRef, vmName, powerState, datastoreMoRefs) {
    for each (var snap in snapList) {
        var snapName  = snap.name  || "";
        var snapDesc  = snap.description || "";
        var snapMoRef = snap.snapshot.value; // MoRef string
        var createdTime = snap.createTime; // Date

        // Age check
        var ageMs = now.getTime() - createdTime.getTime();
        if (ageMs < cutoffMs) {
            // Too new — but still walk children (they may be older if clock skew is not a factor;
            // in practice snapshots are always newer than parents, so skip subtree)
            // Walk children anyway to be safe (no-op in normal trees)
            if (snap.childSnapshotList && snap.childSnapshotList.length > 0) {
                walkSnapshots(snap.childSnapshotList, snapMoRef, vmMoRef, vmName, powerState, datastoreMoRefs);
            }
            continue;
        }

        // Description ignore check — skip THIS snapshot only, continue siblings/children
        if (descIgnore !== "" && snapDesc.toLowerCase().indexOf(descIgnore) !== -1) {
            System.log("SKIP (desc match): VM=" + vmName + " snap=" + snapName);
            if (snap.childSnapshotList && snap.childSnapshotList.length > 0) {
                walkSnapshots(snap.childSnapshotList, snapMoRef, vmMoRef, vmName, powerState, datastoreMoRefs);
            }
            continue;
        }

        // Name whitelist check — if filter provided, only include matching snapshots
        if (nameFilter !== "" && snapName.toLowerCase().indexOf(nameFilter) === -1) {
            // Name doesn't match whitelist — skip, but walk children
            if (snap.childSnapshotList && snap.childSnapshotList.length > 0) {
                walkSnapshots(snap.childSnapshotList, snapMoRef, vmMoRef, vmName, powerState, datastoreMoRefs);
            }
            continue;
        }

        result.push({
            vmMoRef:             vmMoRef,
            vmName:              vmName,
            vmPowerState:        powerState,
            snapshotMoRef:       snapMoRef,
            snapshotName:        snapName,
            snapshotDesc:        snapDesc,
            snapshotCreatedMs:   createdTime.getTime(),
            snapshotAgeMinutes:  Math.floor(ageMs / 60000),
            datastoreMoRefs:     datastoreMoRefs,
            parentSnapshotMoRef: parentMoRef
        });

        // Walk children
        if (snap.childSnapshotList && snap.childSnapshotList.length > 0) {
            walkSnapshots(snap.childSnapshotList, snapMoRef, vmMoRef, vmName, powerState, datastoreMoRefs);
        }
    }
}

return JSON.stringify(result);
