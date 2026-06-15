/* ============================================================================
 *  WORKFLOW: Recreate Boot Disk
 *  PATH:     Library / Production / VCF Automation / VM Deployments / Helpers
 *  DISPLAY:  Recreate Boot Disk
 * ----------------------------------------------------------------------------
 *  PURPOSE
 *    Locate a VM's boot disk, capture its details, DELETE it (including the VMDK file),
 *    then CREATE a new disk with the SAME details (capacity, controller, unit,
 *    disk mode, provisioning, datastore). Used to strip a throwaway OS disk
 *    back to a clean empty install target for the shell-VM / ISO-install flow.
 *
 *
 *  CANVAS (1:1 with elements; root = item1)
 *    item1 Validate & Find Boot Disk   [task]
 *      -> item2 Delete Boot Disk        [task]
 *      -> item3 Create Replacement Disk [task]
 *      -> item0 End
 *    Error handler: item5 Log error -> item4 End
 *
 *  IN
 *    vm : VC:VirtualMachine
 *  OUT
 *    (none)
 *
 *  ATTRIBUTES (carried between elements)
 *    busNumber       : number = 0   // SCSI controller bus to target
 *    targetUnit      : number = 0   // unit number on that controller
 *    capacityInKB    : number       // captured from original disk
 *    controllerKey   : number       // captured (the SCSI controller's device key)
 *    diskMode        : string       // captured (persistent / independent_*)
 *    thinProvisioned : boolean      // captured
 *    eagerlyScrub    : boolean      // captured (thick eager-zeroed)
 *    datastoreName   : string       // captured datastore for the new backing
 *
 *  API VALIDATION (vroapi.com / official; cross-checked vs. Cody Hosterman vRO
 *  disk-create example and VMTN reconfigVM_Task threads)
 *    - vm.config.hardware.device[] -> devices; VcVirtualDisk for disks.
 *      Controllers: instanceof against the four CONCRETE SCSI subclasses
 *      (VcParaVirtualSCSIController, VcVirtualLsiLogicSASController,
 *      VcVirtualLsiLogicController, VcVirtualBusLogicController) — the abstract
 *      VcVirtualSCSIController base does not match in the Rhino/plugin context.
 *    - Controller bus<->disk link: disk.controllerKey == controller.key,
 *      controller.busNumber == 0 for the first SCSI controller.
 *    - Delete: VcVirtualDeviceConfigSpec.operation = remove,
 *      fileOperation = destroy (deletes the VMDK).
 *    - Create: new VcVirtualDisk + VcVirtualDiskFlatVer2BackingInfo,
 *      operation = add, fileOperation = create.
 *    - vm.reconfigVM_Task(spec) -> VcTask; wait via vim3WaitTaskEnd.
 * ==========================================================================*/


/* ============================================================================
 * item1 — Validate and Find Boot Disk   (Scriptable Task   [ROOT])
 * IN:  vm
 * OUT: controllerKey, diskMode, thinProvisioned, eagerlyScrub, datastoreName, targetUnit, busNumber, capacityInKB
 * NEXT: item2
 * ==========================================================================*/
if (vm === null || vm === undefined) {
    throw "Recreate Boot Disk: vm input is null.";
}

// VM must be powered off for a destroy/recreate of the boot disk.
// FIX: wait for the power-off task to complete before continuing,
// otherwise the later destroy runs against a still-powering-off VM.
var basic = System.getModule("com.vmware.library.vc.basic");
var powerState = vm.runtime.powerState.value; // poweredOff|poweredOn|suspended
if (powerState !== "poweredOff") {
    System.log("Recreate Boot Disk: VM '" + vm.name + "' is '" + powerState
        + "'; powering off and waiting.");
    var offTask = vm.powerOffVM_Task();
    basic.vim3WaitTaskEnd(offTask, true, 2); // wait for power-off
}

var busNumber = 0;   // first SCSI controller
var targetUnit = 0;  // boot disk unit

var devices = vm.config.hardware.device; // VcVirtualDevice[]
if (devices === null || devices === undefined || devices.length === 0) {
    throw "Recreate Boot Disk: VM '" + vm.name + "' has no devices.";
}

// 1) Find the SCSI controller on bus 0 -> its device key.
// FIX: VcVirtualSCSIController is the ABSTRACT base; instanceof against
// it does not match the concrete subtype the VM actually uses (PVSCSI,
// LSI Logic SAS, etc.). Match the four concrete SCSI subclasses.
var i;
var scsiControllerKey = null;
for (i = 0; i < devices.length; i++) {
    var dev = devices[i];
    var isScsi = (dev instanceof VcParaVirtualSCSIController)
        || (dev instanceof VcVirtualLsiLogicSASController)
        || (dev instanceof VcVirtualLsiLogicController)
        || (dev instanceof VcVirtualBusLogicController);
    if (isScsi && dev.busNumber === busNumber) {
        scsiControllerKey = dev.key;
        break;
    }
}
if (scsiControllerKey === null) {
    throw "Recreate Boot Disk: no SCSI controller found on bus " + busNumber + ".";
}
// 2) Find the disk on that controller at unitNumber 0.
var bootDisk = null;
for (i = 0; i < devices.length; i++) {
    if (devices[i] instanceof VcVirtualDisk) {
        if (devices[i].controllerKey === scsiControllerKey
                && devices[i].unitNumber === targetUnit) {
            bootDisk = devices[i];
            break;
        }
    }
}
if (bootDisk === null) {
    throw "Recreate Boot Disk: no disk found at controller bus " + busNumber
        + ", unit " + targetUnit + " on VM '" + vm.name + "'.";
}

// 3) Capture details for an identical recreate.
var capacityInKB    = bootDisk.capacityInKB;
var controllerKey   = bootDisk.controllerKey;
var backing         = bootDisk.backing; // VcVirtualDiskFlatVer2BackingInfo
var diskMode        = (backing && backing.diskMode) ? backing.diskMode : "persistent";
var thinProvisioned = (backing && backing.thinProvisioned === true);
var eagerlyScrub    = (backing && backing.eagerlyScrub === true);

// Datastore name from the original backing fileName "[datastore] path/disk.vmdk".
var datastoreName = null;
if (backing && backing.datastore && backing.datastore.name) {
    datastoreName = backing.datastore.name;
} else if (backing && backing.fileName) {
    var fn = "" + backing.fileName;
    var o = fn.indexOf("["), c = fn.indexOf("]");
    if (o >= 0 && c > o) {
        datastoreName = fn.substring(o + 1, c);
    }
}
if (datastoreName === null) {
    throw "Recreate Boot Disk: could not determine datastore from the original "
        + "boot disk backing.";
}

System.log("Recreate Boot Disk: found boot disk on VM '" + vm.name
    + "' (controllerKey=" + controllerKey + ", unit=" + targetUnit
    + ", capacityKB=" + capacityInKB + ", mode=" + diskMode
    + ", thin=" + thinProvisioned + ", eagerScrub=" + eagerlyScrub
    + ", datastore=" + datastoreName + ").");



/* ============================================================================
 * item2 — Delete Boot Disk   (Scriptable Task)
 * IN:  vm, controllerKey, targetUnit
 * NEXT: item3
 * ==========================================================================*/
var devs2 = vm.config.hardware.device;
var diskToRemove = null;
var i;
for (i = 0; i < devs2.length; i++) {
    if (devs2[i] instanceof VcVirtualDisk
            && devs2[i].controllerKey === controllerKey
            && devs2[i].unitNumber === targetUnit) {
        diskToRemove = devs2[i];
        break;
    }
}
if (diskToRemove === null) {
    throw "Recreate Boot Disk: boot disk vanished before delete (controllerKey="
        + controllerKey + ", unit=" + targetUnit + ").";
}

var removeSpec = new VcVirtualDeviceConfigSpec();
removeSpec.operation = VcVirtualDeviceConfigSpecOperation.remove;
removeSpec.fileOperation = VcVirtualDeviceConfigSpecFileOperation.destroy; // delete VMDK
removeSpec.device = diskToRemove;

var removeConfig = new VcVirtualMachineConfigSpec();
removeConfig.deviceChange = [ removeSpec ];

var basic = System.getModule("com.vmware.library.vc.basic");
var removeTask = vm.reconfigVM_Task(removeConfig);
basic.vim3WaitTaskEnd(removeTask, true, 2); // throws on failure
System.log("Recreate Boot Disk: deleted original boot disk (VMDK destroyed).");


/* ============================================================================
 * item3 — Create New Boot Disk   (Scriptable Task)
 * IN:  vm, busNumber, controllerKey, datastoreName, diskMode, eagerlyScrub, targetUnit, thinProvisioned, capacityInKB
 * NEXT: item0
 * ==========================================================================*/
var newBacking = new VcVirtualDiskFlatVer2BackingInfo();
newBacking.diskMode = diskMode;
newBacking.fileName = "[" + datastoreName + "]"; // vCenter auto-names the VMDK
newBacking.thinProvisioned = thinProvisioned;
if (!thinProvisioned) {
    // Only meaningful for thick; preserve eager-zeroed if the original was.
    newBacking.eagerlyScrub = eagerlyScrub;
}

var newDisk = new VcVirtualDisk();
newDisk.backing = newBacking;
newDisk.controllerKey = controllerKey;
newDisk.unitNumber = targetUnit;
newDisk.capacityInKB = capacityInKB;
newDisk.key = -1; // negative => let vCenter assign the device key

var addSpec = new VcVirtualDeviceConfigSpec();
addSpec.operation = VcVirtualDeviceConfigSpecOperation.add;
addSpec.fileOperation = VcVirtualDeviceConfigSpecFileOperation.create; // create the VMDK
addSpec.device = newDisk;

var addConfig = new VcVirtualMachineConfigSpec();
addConfig.deviceChange = [ addSpec ];

var addTask = vm.reconfigVM_Task(addConfig);
basic.vim3WaitTaskEnd(addTask, true, 2); // throws on failure
System.log("Recreate Boot Disk: created replacement boot disk (controllerKey="
    + controllerKey + ", unit=" + targetUnit + ", capacityKB=" + capacityInKB
    + ") on datastore '" + datastoreName + "'.");

