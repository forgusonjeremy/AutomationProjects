/**
 * ACTION: _getSnapshotCandidates
 * Module : com.broadcom.pso.vc.vm.snapshots
 *
 * Enumerates all VMs and their eligible snapshots. Returns a flat list of
 * candidates identified by VM name and snapshot name only. No MoRefs or
 * object references are stored -- all resolution happens at deletion time
 * against the live vCenter inventory, ensuring stale references are never
 * an issue.
 *
 * ── INPUTS ───────────────────────────────────────────────────────────────────
 *   Name                  Type              Description
 *   ──────────────────────────────────────────────────────────────────────────
 *   vcenterSdkConnection  VC:SdkConnection  The vCenter connection to enumerate
 *   maxAgeMinutes         number            Candidates older than this (minutes)
 *   nameMatchString       string            Whitelist filter (empty = all names)
 *   descIgnoreStrings     string[]          Skip if description contains any term
 *
 * ── RETURN TYPE ──────────────────────────────────────────────────────────────
 *   string  JSON array of candidate objects. Each object contains:
 *   {
 *     vcenterName       : string,   // sdkConnection.name for multi-vCenter routing
 *     vmMoRef           : string,   // vm.id -- used to locate VM at delete time
 *     vmName            : string,
 *     vmPowerState      : string,   // "poweredOn" | "poweredOff" | "suspended"
 *     snapshotName      : string,   // used to find snapshot at delete time
 *     snapshotCreatedMs : number,   // used for newest-first sort in ST-05
 *     snapshotAgeMinutes: number,   // for logging
 *     datastoreMoRefs   : string[]  // datastore.id for I/O governor
 *   }
 *
 *   NOTE: No snapshotMoRef or parentSnapshotMoRef -- these are resolved fresh
 *   at deletion time to avoid stale reference issues after chain reorganisation.
 */

var result   = [];
var now      = new Date();
var cutoffMs = (maxAgeMinutes || 60) * 60 * 1000;

var nameFilter = (nameMatchString || "").toLowerCase().trim();

// Build desc ignore list from string array input
var descIgnoreList = [];
if (descIgnoreStrings) {
    for (var dii = 0; dii < descIgnoreStrings.length; dii++) {
        var term = (descIgnoreStrings[dii] || "").toLowerCase().trim();
        if (term !== "") descIgnoreList.push(term);
    }
}

// ── Collect all VMs ───────────────────────────────────────────────────────────
var allVms = [];
collectVmsFromFolder(vcenterSdkConnection.rootFolder);

System.log("_getSnapshotCandidates: found " + allVms.length +
           " VMs on " + vcenterSdkConnection.name);

if (allVms.length > 0) {
    System.log("_getSnapshotCandidates: sample vm.id='" + allVms[0].id +
               "'  vm.name='" + allVms[0].name + "'");
}

// ── Walk each VM's snapshot tree ─────────────────────────────────────────────
for (var vi = 0; vi < allVms.length; vi++) {
    var vm = allVms[vi];
    if (!vm || !vm.config) continue;
    if (vm.config.template) continue;
    if (!vm.snapshot || !vm.snapshot.rootSnapshotList ||
        vm.snapshot.rootSnapshotList.length === 0) continue;

    var dsMoRefs = [];
    if (vm.datastore) {
        for (var di = 0; di < vm.datastore.length; di++) {
            dsMoRefs.push(vm.datastore[di].id);
        }
    }

    walkSnapshots(
        vm.snapshot.rootSnapshotList,
        vm.id,
        vm.name,
        vm.runtime.powerState.value,
        dsMoRefs
    );
}

return JSON.stringify(result);

// ── Helpers ───────────────────────────────────────────────────────────────────
function collectVmsFromFolder(folder) {
    if (!folder || !folder.childEntity) return;
    for (var i = 0; i < folder.childEntity.length; i++) {
        var child = folder.childEntity[i];
        if (!child) continue;
        var type = child.vimType || child.sdkType || "";
        if (type === "VirtualMachine" || child.snapshot !== undefined) {
            allVms.push(child);
        } else if (type === "Datacenter") {
            if (child.vmFolder) collectVmsFromFolder(child.vmFolder);
        } else if (type === "Folder") {
            collectVmsFromFolder(child);
        } else if (child.vmFolder !== undefined) {
            collectVmsFromFolder(child.vmFolder);
        } else if (child.childEntity !== undefined) {
            collectVmsFromFolder(child);
        }
    }
}

function walkSnapshots(snapList, vmId, vmName, pwrState, dsMoRefs) {
    for (var si = 0; si < snapList.length; si++) {
        var snap     = snapList[si];
        var snapName = snap.name        || "";
        var snapDesc = snap.description || "";
        var ageMs    = now.getTime() - snap.createTime.getTime();

        // Always walk children regardless of filters
        if (snap.childSnapshotList && snap.childSnapshotList.length > 0) {
            walkSnapshots(snap.childSnapshotList, vmId, vmName, pwrState, dsMoRefs);
        }

        // Age filter
        if (ageMs < cutoffMs) continue;

        // Description ignore filter
        if (descIgnoreList.length > 0) {
            var descLower = snapDesc.toLowerCase();
            var matched   = false;
            for (var dfi = 0; dfi < descIgnoreList.length; dfi++) {
                if (descLower.indexOf(descIgnoreList[dfi]) !== -1) {
                    matched = true;
                    break;
                }
            }
            if (matched) {
                System.log("SKIP (desc match): VM=" + vmName + " snap=" + snapName);
                continue;
            }
        }

        // Name whitelist filter
        if (nameFilter !== "" &&
            snapName.toLowerCase().indexOf(nameFilter) === -1) continue;

        result.push({
            vcenterName:        vcenterSdkConnection.name,
            vmMoRef:            vmId,
            vmName:             vmName,
            vmPowerState:       pwrState,
            snapshotName:       snapName,
            snapshotCreatedMs:  snap.createTime.getTime(),
            snapshotAgeMinutes: Math.floor(ageMs / 60000),
            datastoreMoRefs:    dsMoRefs
        });
    }
}
