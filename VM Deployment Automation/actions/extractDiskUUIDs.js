/**
 * Action: extractDiskUUIDs
 * Module: com.broadcom.pso.vcfa.vm.diskManagement
 *
 * Purpose:
 *   Queries VM hardware configuration and returns a UUID-ordered array of
 *   additional disks attached to SCSI Controller 1 (busNumber === 1).
 *   Output is matched positionally to the additionalDisks input array.
 *
 * Prerequisites:
 *   - vCenter Server plugin configured in Orchestrator
 *   - disk.EnableUUID = TRUE on base image template VM
 *   - Disks provisioned on SCSI Controller 1 via blueprint (SCSIController: SCSI_Controller_1)
 *
 * Inputs:
 *   vm        {VC:VirtualMachine} - Target VM object
 *   diskCount {number}            - Expected number of additional disks (length of additionalDisks array)
 *
 * Output:
 *   {string} JSON array: [{index, uuid, unitNumber}] sorted by unitNumber ascending
 *
 * Error conditions:
 *   - No hardware devices on VM
 *   - Disk count on Controller 1 does not match diskCount input
 *   - disk.EnableUUID not set (UUID will be undefined/null)
 */

var additionalVmdks = [];

try {
    if (!vm) {
        throw new Error("Input 'vm' is required.");
    }
    if (diskCount === null || diskCount === undefined || diskCount < 1) {
        throw new Error("Input 'diskCount' must be a positive integer. Received: " + diskCount);
    }

    var devices = vm.config.hardware.device;

    if (!devices || devices.length === 0) {
        throw new Error("No hardware devices found on VM: " + vm.name);
    }

    System.log("extractDiskUUIDs: Scanning " + devices.length + " hardware device(s) on VM: " + vm.name);

    for (var d = 0; d < devices.length; d++) {
        var device = devices[d];

        // Skip devices without disk backing (not a VMDK)
        if (!device.backing || device.backing.uuid === undefined || device.backing.uuid === null) {
            continue;
        }

        // Find the controller this device is attached to
        var ctrl = null;
        for (var c = 0; c < devices.length; c++) {
            if (devices[c].key === device.controllerKey) {
                ctrl = devices[c];
                break;
            }
        }

        // Filter: Controller 1 only (additional disks)
        if (!ctrl || ctrl.busNumber !== 1) {
            continue;
        }

        System.log(
            "extractDiskUUIDs: Found disk on Controller 1 — " +
            "unitNumber=" + device.unitNumber +
            " uuid=" + device.backing.uuid
        );

        additionalVmdks.push({
            index:      additionalVmdks.length, // temporary; re-indexed after sort
            unitNumber: device.unitNumber,
            uuid:       device.backing.uuid
        });
    }

    // Sort ascending by unitNumber to match blueprint count.index ordering
    additionalVmdks.sort(function(a, b) { return a.unitNumber - b.unitNumber; });

    // Re-index after sort to reflect final array position
    for (var i = 0; i < additionalVmdks.length; i++) {
        additionalVmdks[i].index = i;
    }

    // Validate count matches expectation
    if (additionalVmdks.length !== diskCount) {
        throw new Error(
            "Disk count mismatch on VM '" + vm.name + "'. " +
            "Expected: " + diskCount + " disk(s) on SCSI Controller 1. " +
            "Found: " + additionalVmdks.length + ". " +
            "Verify: (1) disk.EnableUUID=TRUE on base image, " +
            "(2) Blueprint assigns SCSIController: SCSI_Controller_1, " +
            "(3) VM provisioning completed successfully."
        );
    }

    var result = JSON.stringify(additionalVmdks);
    System.log("extractDiskUUIDs: Success. Result: " + result);
    return result;

} catch (e) {
    System.error("extractDiskUUIDs FAILED: " + e.message);
    throw e;
}
