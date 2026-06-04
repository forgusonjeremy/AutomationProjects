/**
 * Action: extractDiskUUIDs (multi-controller)
 * Module: com.broadcom.pso.vcfa.vm.diskManagement
 * IN:  vm {VC:VirtualMachine}
 *      additionalDisksJson {string}  request-order JSON:
 *        [{ sizeGb, SCSIController:"SCSI_Controller_1..3", driveLetter, driveLabel }]
 * OUT: {string}  SAME order as input:
 *        [{ index, uuid, unitNumber, scsiController }]
 */
if (!vm) throw new Error("Input 'vm' is required.");
if (!additionalDisksJson) throw new Error("Input 'additionalDisksJson' is required.");

var requested = JSON.parse(additionalDisksJson);
if (typeof requested === "string") requested = JSON.parse(requested); // defensive double-decode
if (!requested || requested.length === 0) throw new Error("additionalDisksJson is empty.");

function busFromEnum(s) {
    var m = s ? String(s).match(/SCSI_Controller_([1-3])$/) : null;
    if (!m) throw new Error("Unsupported SCSIController '" + s + "'. Expected SCSI_Controller_1..3.");
    return parseInt(m[1], 10);
}

var devices = vm.config.hardware.device;
if (!devices || devices.length === 0) throw new Error("No hardware devices on VM: " + vm.name);

// Group data-disk VMDKs by controller busNumber, skipping bus 0 (OS/boot)
var byBus = {};
for (var d = 0; d < devices.length; d++) {
    var device = devices[d];
    if (!device.backing || device.backing.uuid === undefined || device.backing.uuid === null) continue;
    var ctrl = null;
    for (var c = 0; c < devices.length; c++) {
        if (devices[c].key === device.controllerKey) { ctrl = devices[c]; break; }
    }
    if (!ctrl || ctrl.busNumber === undefined || ctrl.busNumber === null) continue;
    if (ctrl.busNumber === 0) continue; // OS disk
    if (!byBus[ctrl.busNumber]) byBus[ctrl.busNumber] = [];
    byBus[ctrl.busNumber].push({ unitNumber: device.unitNumber, uuid: device.backing.uuid });
}
for (var b in byBus) {
    if (byBus.hasOwnProperty(b)) byBus[b].sort(function(a, z) { return a.unitNumber - z.unitNumber; });
}

// Consume per controller in request order
var cursor = {}, result = [];
for (var r = 0; r < requested.length; r++) {
    var bus = busFromEnum(requested[r].SCSIController);
    var group = byBus[bus] || [];
    var idx = cursor[bus] || 0;
    if (idx >= group.length) {
        throw new Error("Disk count mismatch on bus " + bus + " (" + requested[r].SCSIController +
            ") for VM '" + vm.name + "'. Requested more than found. Verify disk.EnableUUID=TRUE and provisioning completed.");
    }
    var phys = group[idx];
    cursor[bus] = idx + 1;
    if (!phys.uuid) throw new Error("Disk[" + r + "] bus " + bus + " has no UUID — disk.EnableUUID likely FALSE.");
    result.push({ index: r, uuid: phys.uuid, unitNumber: phys.unitNumber, scsiController: requested[r].SCSIController });
}

var out = JSON.stringify(result);
System.log("extractDiskUUIDs: " + out);
return out;