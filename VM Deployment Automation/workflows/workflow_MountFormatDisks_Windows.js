/* ============================================================================
 * WORKFLOW: workflow_MountFormatDisks_Windows
 * MODULE:   com.broadcom.pso.vcfa.vm.guestScripting
 *
 * Single-file reference. In vRO these are SEPARATE artifacts:
 *   - 3 Actions
 *   - 1 Workflow with 6 scriptable tasks + 1 decision, wired as a manual loop.
 * Each section below maps 1:1 to a canvas object; copy each block into the
 * matching element/action in the vRO editor.
 *
 * PURPOSE:
 *   Initialize, partition, format, and assign drive letters to additional data
 *   disks on a Windows VM via VMware Tools (RunProgramInGuest). Correlation is
 *   by UUID (exposed in-guest as disk SerialNumber) and is controller-agnostic;
 *   data disks may reside on SCSI Controllers 1-3.
 *
 * WORKFLOW INPUTS:
 *   vm              {VC:VirtualMachine}  Target VM
 *   guestUsername   {string}             Local admin username (post-rename if applicable)
 *   guestPassword   {SecureString}       Local admin password (post-update if applicable)
 *   additionalDisks {string}             JSON array: [{driveLetter, driveLabel, sizeGb}]
 *   
 *
 * WORKFLOW OUTPUT:
 *   executionSummary {string}            Per-disk result log
 *
 * WORKFLOW ATTRIBUTES:
 *   SCRIPT_THRESHOLD_GB {number} = 2048    (< threshold: MBR, >= threshold: GPT)
 *   MAX_WAIT_MS         {number} = 120000  (per-disk script timeout)
 *   POLL_MS             {number} = 5000
 *   diskCount           {number}
 *   diskIndex           {number} = 0
 *   summary             {Array/string}
 *   guestAuth           {VC:GuestAuthentication}
 *   processManager      {VC:GuestProcessManager}
 *   fileManager         {VC:GuestFileManager}
 *   curScriptPath       {string}
 *   curUuid             {string}
 *   curDriveLetter      {string}
 *   curDriveLabel       {string}
 *   curSizeGb           {number}
 *   curPartStyle        {string}
 *
 * CANVAS FLOW:
 *   Start -> E1 -> E2 -> D1
 *   D1[true]  -> E3 -> E4 -> E5 -> D1
 *   D1[false] -> E6 -> End
 *   Bind each scriptable task's exception output to a common error handler
 *   (or end-with-exception) that logs and rethrows.
 *
 * PREREQUISITES:
 *   - VMware Tools installed and running on guest
 *   - disk.EnableUUID = TRUE on base template (enforced by assertDiskUuidEnabled
 *     gate in the parent workflow)
 *   - Blueprint assigns additional disks to SCSI Controllers 1-3 (controller 0
 *     reserved for OS/boot disk)
 *   - extractDiskUUIDs scoped to controllers with busNumber != 0, emitting entries
 *     in the SAME order as additionalDisks
 *   - vCenter credentials with Guest Operations privilege
 *   - Windows PowerShell available (Server 2016+ ships 5.1)
 *   - Guest account has local admin rights
 *
 * IDEMPOTENCY:
 *   PowerShell skips non-RAW disks (exit 2) to prevent data loss on re-run.
 * ==========================================================================*/


/* ////////////////
 * //  ACTIONS )
 * ///////////// */


/* ----------------------------------------------------------------------------
 * ACTION: utf8ByteLength
 * MODULE: com.broadcom.pso.vcfa.vm.guestScripting
 * IN:  str {string}
 * OUT: {number}  true UTF-8 byte length (java.lang.String is not constructable
 *                 in this Rhino context, so this is pure JS)
 * -------------------------------------------------------------------------- */
var len = 0;
for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c < 0x80) len += 1;
    else if (c < 0x800) len += 2;
    else if (c >= 0xD800 && c <= 0xDBFF) { len += 4; i++; } // surrogate pair
    else len += 3;
}
return len;


/* ----------------------------------------------------------------------------
 * ACTION: uploadGuestScript
 * MODULE: com.broadcom.pso.vcfa.vm.guestScripting
 * IN:  vm {VC:VirtualMachine}, transferUrl {string}, content {string}, tag {string}
 * OUT: void  (throws on failure; both REST hosts created+destroyed here, null-guarded)
 * -------------------------------------------------------------------------- */
var baseUrl       = transferUrl.substring(0, transferUrl.indexOf("/", 8));
var uploadHost    = null;
var transientHost = null;

try {
    uploadHost    = RESTHostManager.createHost("upload-" + tag + "-" + vm.name);
    transientHost = RESTHostManager.createTransientHostFrom(uploadHost);
    RESTHostManager.reloadConfiguration();
    transientHost.url              = baseUrl;
    transientHost.hostVerification = false;

    var req = transientHost.createRequest("PUT", transferUrl, "application/octet-stream");
    req.setContent(content);
    var resp = req.execute();
    if (resp.statusCode !== 200) {
        throw new Error("Script upload failed [" + tag + "]. HTTP " + resp.statusCode + ": " + resp.contentAsString);
    }
    System.log("Script uploaded [" + tag + "].");
} finally {
    if (transientHost) {
        try { RESTHostManager.removeHost(transientHost); }
        catch (err) { System.warn("Transient host cleanup [" + tag + "]: " + err.message); }
    }
    if (uploadHost) {
        try { RESTHostManager.removeHost(uploadHost); }
        catch (err) { System.warn("Upload host cleanup [" + tag + "]: " + err.message); }
    }
}


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


/* ////////////////////////////////////////////////////////////////////////////
 * //  WORKFLOW CANVAS ELEMENTS
 * ////////////////////////////////////////////////////////////////////////// */


/* ============================================================================
 * E1 — Validate & Parse Inputs   (Scriptable Task)
 * IN:  vm, guestUsername, guestPassword, additionalDisks, diskUuidMapJson
 * OUT: diskCount, diskIndex, summary
 * ==========================================================================*/
if (!vm)              throw new Error("Input 'vm' is required.");
if (!guestUsername)   throw new Error("Input 'guestUsername' is required.");
if (!guestPassword)   throw new Error("Input 'guestPassword' is required.");
if (!additionalDisks) throw new Error("Input 'additionalDisks' is required.");

var disks, uuidMap;
try { disks = JSON.parse(additionalDisks); }
catch (e) { throw new Error("Failed to parse additionalDisks JSON: " + e.message); }

if (!disks || disks.length === 0) throw new Error("additionalDisks array is empty. Nothing to process.");
if (disks.length !== uuidMap.length) {
    throw new Error("Array length mismatch. additionalDisks: " + disks.length + " diskUuidMap: " + uuidMap.length);
}

diskCount = disks.length;
diskIndex = 0;
summary   = [];
System.log("workflow_MountFormatDisks_Windows: Processing " + diskCount + " disk(s) on VM: " + vm.name);

/* ============================================================================
 * A1 - Extract Disk UUIDs   (Action: extractDiskUUIDs)
 * IN:  vm, diskCount
 * OUT: diskUuidMapJson
 * ==========================================================================*/
diskUuidMapJson = System.getModule("com.broadcom.pso.vcfa.vm.diskManagement").extractDiskUUIDs(vm, diskCount);

/* ============================================================================
 * E2 — Prepare Guest Ops   (Scriptable Task)
 * IN:  guestUsername, guestPassword
 * OUT: guestAuth, processManager, fileManager
 * ==========================================================================*/
guestAuth          = new VcNamePasswordAuthentication();
guestAuth.username = guestUsername;
guestAuth.password = guestPassword;

var serviceInstance = VcPlugin.getAllSdkConnections()[0].serviceInstance;
var guestOps        = serviceInstance.content.guestOperationsManager;
processManager      = guestOps.processManager;
fileManager         = guestOps.fileManager;


/* ============================================================================
 * D1 — More disks?   (Decision)
 * Condition:  diskIndex < diskCount
 *   true  -> E3
 *   false -> E6
 * ==========================================================================*/
// (Decision element — no scriptable body; use the condition above.)


/* ============================================================================
 * E3 — Build & Upload Current Disk   (Scriptable Task)
 * IN:  vm, guestAuth, fileManager, additionalDisks, diskUuidMapJson, diskIndex,
 *      SCRIPT_THRESHOLD_GB
 * OUT: curScriptPath, curUuid, curDriveLetter, curDriveLabel, curSizeGb, curPartStyle
 * ==========================================================================*/

function buildDiskPartitionScript(diskUuid, driveLetter, driveLabel, partitionStyle) {
    return [
        "$ErrorActionPreference = 'Stop'",
        "$targetUuid   = '" + diskUuid.replace(/'/g, "") + "'",
        "$driveLetter  = '" + driveLetter + "'",
        "$driveLabel   = '" + driveLabel.replace(/'/g, "") + "'",
        "$partStyle    = '" + partitionStyle + "'",
        "",
        "# Locate disk by serial number (VMware exposes VMDK UUID as serial)",
        "$disk = Get-Disk | Where-Object { $_.SerialNumber -eq $targetUuid }",
        "if (-not $disk) {",
        "    Write-Error \"Disk with serial '$targetUuid' not found.\"",
        "    exit 1",
        "}",
        "",
        "# Safety check: skip non-RAW disks to prevent data loss",
        "if ($disk.PartitionStyle -ne 'RAW') {",
        "    Write-Output \"INFO: Disk '$targetUuid' is not RAW (PartitionStyle=$($disk.PartitionStyle)). Skipping.\"",
        "    exit 2",
        "}",
        "",
        "# Guard: fail clearly if the requested drive letter is already in use",
        "if (Get-Volume -DriveLetter $driveLetter -ErrorAction SilentlyContinue) {",
        "    Write-Error \"Drive letter '${driveLetter}:' is already in use.\"",
        "    exit 3",
        "}",
        "",
        "Initialize-Disk -Number $disk.Number -PartitionStyle $partStyle -Confirm:$false",
        "New-Partition -DiskNumber $disk.Number -UseMaximumSize -DriveLetter $driveLetter | Out-Null",
        "Format-Volume -DriveLetter $driveLetter -FileSystem NTFS -NewFileSystemLabel $driveLabel -Confirm:$false -Force | Out-Null",
        "",
        "Write-Output \"SUCCESS: UUID=$targetUuid formatted NTFS ($partStyle), Letter=${driveLetter}:, Label=$driveLabel\"",
        "exit 0"
    ].join("\r\n");
}

var disks   = JSON.parse(additionalDisks);
var uuidMap = JSON.parse(diskUuidMapJson);
var disk      = disks[diskIndex];
var uuidEntry = uuidMap[diskIndex];

var driveLetter = disk.driveLetter ? disk.driveLetter.replace(":", "").trim().toUpperCase() : null;
var driveLabel  = disk.driveLabel  ? disk.driveLabel.trim() : "Data";
var sizeGb      = disk.sizeGb       ? parseInt(disk.sizeGb)  : 0;
var diskUuid    = uuidEntry.uuid;

if (!driveLetter || driveLetter.length !== 1 || !/[D-Z]/.test(driveLetter)) {
    throw new Error("Disk[" + diskIndex + "]: Invalid driveLetter '" + disk.driveLetter + "'. Must be a single letter D-Z.");
}
if (!diskUuid)   throw new Error("Disk[" + diskIndex + "]: Missing UUID at index " + diskIndex);
if (sizeGb <= 0) throw new Error("Disk[" + diskIndex + "]: Invalid sizeGb: " + sizeGb);

var partitionStyle = (sizeGb >= SCRIPT_THRESHOLD_GB) ? "GPT" : "MBR";
System.log("Disk[" + diskIndex + "]: UUID=" + diskUuid + " Letter=" + driveLetter + ": Label=" + driveLabel +
           " Size=" + sizeGb + "GB PartitionStyle=" + partitionStyle);

var mod = System.getModule("com.broadcom.pso.vcfa.vm.guestScripting");
var psScript = buildDiskPartitionScript(diskUuid, driveLetter, driveLabel, partitionStyle);
var scriptPath = "C:\\Windows\\Temp\\vcf_disk_" + diskIndex + "_" + driveLetter + ".ps1";

// Size MUST be UTF-8 byte count (driveLabel may be non-ASCII) or ESXi returns HTTP 500.
var winFileAttr = new VcGuestWindowsFileAttributes();
var byteLen     = mod.utf8ByteLength(psScript);
var transferUrl = fileManager.initiateFileTransferToGuest(vm, guestAuth, scriptPath, winFileAttr, byteLen, true);
mod.uploadGuestScript(vm, transferUrl, psScript, "Disk" + diskIndex + "-Win");

curScriptPath  = scriptPath;
curUuid        = diskUuid;
curDriveLetter = driveLetter;
curDriveLabel  = driveLabel;
curSizeGb      = sizeGb;
curPartStyle   = partitionStyle;


/* ============================================================================
 * E4 — Execute & Poll Current Disk   (Scriptable Task)
 * IN:  vm, guestAuth, processManager, curScriptPath, curUuid, curDriveLetter,
 *      curDriveLabel, curSizeGb, curPartStyle, MAX_WAIT_MS, POLL_MS, diskIndex, summary
 * OUT: summary
 * ==========================================================================*/
var progSpec              = new VcGuestProgramSpec();
progSpec.programPath      = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
progSpec.arguments        = "-NonInteractive -ExecutionPolicy Bypass -File \"" + curScriptPath + "\"";
progSpec.workingDirectory = "C:\\Windows\\Temp";

// Correct plug-in method is startProgramInGuest (startProgram does not exist).
var pid = processManager.startProgramInGuest(vm, guestAuth, progSpec);
System.log("Disk[" + diskIndex + "]: PowerShell started. PID: " + pid);

var elapsed  = 0;
var exitCode = null;
while (elapsed < MAX_WAIT_MS) {
    System.sleep(POLL_MS);
    elapsed += POLL_MS;

    var pids = new java.util.ArrayList();
    pids.add(pid);
    var procInfo = processManager.listProcessesInGuest(vm, guestAuth, pids);
    if (procInfo && procInfo.length > 0 && procInfo[0].exitCode !== null) {
        exitCode = procInfo[0].exitCode;
        break;
    }
    System.log("Disk[" + diskIndex + "]: Waiting... " + elapsed + "ms elapsed.");
}

if (exitCode === null) throw new Error("Disk[" + diskIndex + "]: Script timed out after " + MAX_WAIT_MS + "ms. PID: " + pid);
if (exitCode !== 0)    throw new Error("Disk[" + diskIndex + "]: Script exited with code " + exitCode + ". UUID=" + curUuid + " Letter=" + curDriveLetter + ":");

var diskResult = "Disk[" + diskIndex + "]: SUCCESS — " + curDriveLetter + ": (" + curDriveLabel + ") " +
                 curSizeGb + "GB " + curPartStyle + "+NTFS UUID=" + curUuid;
System.log(diskResult);
summary.push(diskResult);


/* ============================================================================
 * E5 — Increment Index   (Scriptable Task)
 * IN:  diskIndex
 * OUT: diskIndex
 * ==========================================================================*/
diskIndex = diskIndex + 1;


/* ============================================================================
 * E6 — Finalize   (Scriptable Task)
 * IN:  summary
 * OUT: executionSummary
 * ==========================================================================*/
executionSummary = summary.join("\n");
System.log("workflow_MountFormatDisks_Windows: Completed.\n" + executionSummary);