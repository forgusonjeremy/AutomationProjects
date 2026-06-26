/**
 * ACTION: _getSnapshotCandidates
 * Module : com.broadcom.pso.vc.vm.snapshots
 *
 * Enumerates all VMs reachable from a vCenter SDK connection by traversing
 * the vRO inventory tree (SdkConnection -> rootFolder -> datacenters -> vm
 * folders -> VirtualMachine objects). Uses native vRO inventory objects
 * throughout -- no VcPlugin static calls, no REST, no MoRef construction.
 *
 * ── INPUTS ───────────────────────────────────────────────────────────────────
 *   Name                  Type              Description
 *   ──────────────────────────────────────────────────────────────────────────
 *   vcenterSdkConnection  VC:SdkConnection  The vCenter connection to enumerate
 *   maxAgeMinutes         number            Candidates older than this (minutes)
 *   nameMatchString       string            Whitelist filter (empty = all names)
 *   descIgnoreStrings     string[]          Skip filter array. Each element is a substring
 *                                           to match against snapshot descriptions (case-
 *                                           insensitive). A snapshot is excluded if its
 *                                           description contains ANY of the supplied strings.
 *                                           Pass an empty array (or null) for no filter.
 *
 * ── RETURN TYPE ──────────────────────────────────────────────────────────────
 *   string  JSON array of candidate snapshot objects. Each object contains:
 *   {
 *     vmMoRef             : string,   // vm.id as returned by vRO inventory
 *     vmName              : string,
 *     vmPowerState        : string,   // "poweredOn" | "poweredOff" | "suspended"
 *     snapshotMoRef       : string,   // snapshot.snapshot.value
 *     snapshotName        : string,
 *     snapshotDesc        : string,
 *     snapshotCreatedMs   : number,
 *     snapshotAgeMinutes  : number,
 *     datastoreMoRefs     : string[], // datastore.id for each attached datastore
 *     parentSnapshotMoRef : string | null
 *   }
 */

var result     = [];
var now        = new Date();
var cutoffMs   = (maxAgeMinutes || 60) * 60 * 1000;
var nameFilter     = (nameMatchString || "").toLowerCase().trim();
// descIgnoreStrings is a vRO string[] (Array). Normalise to a plain JS array
// of trimmed, lower-cased strings with empty entries removed.
var descIgnoreList = [];
if (descIgnoreStrings) {
    for (var dii = 0; dii < descIgnoreStrings.length; dii++) {
        var term = (descIgnoreStrings[dii] || "").toLowerCase().trim();
        if (term !== "") descIgnoreList.push(term);
    }
}

// ── Collect all VMs by traversing the vRO inventory tree ─────────────────────
// Path: sdkConnection.rootFolder
//         -> datacenters[] (VC:Datacenter)
//           -> vmFolder (VC:Folder)
//             -> recurse folders and collect VC:VirtualMachine objects
//
// vm.id is the vRO inventory identifier for the VM object. It is stored as
// vmMoRef so deleteSnapshot can locate the same object by matching .id.

var allVms = [];
collectVmsFromFolder(vcenterSdkConnection.rootFolder);

System.log("_getSnapshotCandidates: found " + allVms.length +
           " VMs on " + vcenterSdkConnection.name);

// Log the id format of the first VM found so we can confirm the format
// used in this environment (used by deleteSnapshot for matching)
if (allVms.length > 0) {
    System.log("_getSnapshotCandidates: sample vm.id='" + allVms[0].id +
               "'  vm.name='" + allVms[0].name + "'");
}

// ── Evaluate each VM's snapshot tree ─────────────────────────────────────────
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
        null,
        vm.id,          // store exactly as vRO returns it
        vm.name,
        vm.runtime.powerState.value,
        dsMoRefs
    );
}

// Return all eligible candidates unordered. Grouping and sort order
// (newest-first per VM chain) is handled by ST-05 which has full visibility
// of the chain topology. The action's job is only: enumerate, age-filter,
// desc-filter, name-filter, and return the flat list.
return JSON.stringify(result);

// ── Recursive VM collector ────────────────────────────────────────────────────
// Handles the vCenter inventory hierarchy:
//   rootFolder -> Datacenter -> vmFolder -> (Folder | VirtualMachine)*
// Recurses into sub-folders. Skips non-VM, non-Folder child types silently.
function collectVmsFromFolder(folder) {
    if (!folder || !folder.childEntity) return;
    for (var i = 0; i < folder.childEntity.length; i++) {
        var child = folder.childEntity[i];
        if (!child) continue;
        var type = child.vimType || child.sdkType || "";
        if (type === "VirtualMachine" || child.snapshot !== undefined) {
            // It's a VM object
            allVms.push(child);
        } else if (type === "Datacenter") {
            // Recurse into the datacenter's vm folder
            if (child.vmFolder) collectVmsFromFolder(child.vmFolder);
        } else if (type === "Folder") {
            // Recurse into sub-folders (resource pools, clusters, etc.)
            collectVmsFromFolder(child);
        } else if (child.vmFolder !== undefined) {
            // Datacenter-like object -- try its vmFolder
            collectVmsFromFolder(child.vmFolder);
        } else if (child.childEntity !== undefined) {
            // Generic folder-like container -- recurse
            collectVmsFromFolder(child);
        }
    }
}

// ── Recursive snapshot tree walker ────────────────────────────────────────────
function walkSnapshots(snapList, parentMoRef, vmId, vmName, pwrState, dsMoRefs) {
    for (var si = 0; si < snapList.length; si++) {
        var snap     = snapList[si];
        var snapName = snap.name        || "";
        var snapDesc = snap.description || "";
        var snapMoRef= snap.snapshot.value;
        var ageMs    = now.getTime() - snap.createTime.getTime();

        // Age filter -- still walk children even if this snap is too young
        if (ageMs < cutoffMs) {
            if (snap.childSnapshotList && snap.childSnapshotList.length > 0) {
                walkSnapshots(snap.childSnapshotList, snapMoRef,
                              vmId, vmName, pwrState, dsMoRefs);
            }
            continue;
        }

        // Description ignore filter -- skip this snap if its description
        // contains ANY of the strings in descIgnoreList, still walk children.
        if (descIgnoreList.length > 0) {
            var descLower   = snapDesc.toLowerCase();
            var descMatched = false;
            for (var dfi = 0; dfi < descIgnoreList.length; dfi++) {
                if (descLower.indexOf(descIgnoreList[dfi]) !== -1) {
                    descMatched = true;
                    break;
                }
            }
            if (descMatched) {
                System.log("SKIP (desc match): VM=" + vmName +
                           " snap=" + snapName);
                if (snap.childSnapshotList && snap.childSnapshotList.length > 0) {
                    walkSnapshots(snap.childSnapshotList, snapMoRef,
                                  vmId, vmName, pwrState, dsMoRefs);
                }
                continue;
            }
        }

        // Name whitelist filter -- skip this snap, still walk children
        if (nameFilter !== "" &&
            snapName.toLowerCase().indexOf(nameFilter) === -1) {
            if (snap.childSnapshotList && snap.childSnapshotList.length > 0) {
                walkSnapshots(snap.childSnapshotList, snapMoRef,
                              vmId, vmName, pwrState, dsMoRefs);
            }
            continue;
        }

        result.push({
            vmMoRef:             vmId,
            vmName:              vmName,
            vmPowerState:        pwrState,
            snapshotMoRef:       snapMoRef,
            snapshotName:        snapName,
            snapshotDesc:        snapDesc,
            snapshotCreatedMs:   snap.createTime.getTime(),
            snapshotAgeMinutes:  Math.floor(ageMs / 60000),
            datastoreMoRefs:     dsMoRefs,
            parentSnapshotMoRef: parentMoRef
        });

        if (snap.childSnapshotList && snap.childSnapshotList.length > 0) {
            walkSnapshots(snap.childSnapshotList, snapMoRef,
                          vmId, vmName, pwrState, dsMoRefs);
        }
    }
}
