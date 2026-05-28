/**
 * Workflow: workflow_MountFormatDisks_Windows
 * Module: com.vcf.guestcustomization
 *
 * Purpose:
 *   Initializes, partitions, formats, and assigns drive letters to additional
 *   data disks on a Windows VM via VMware Tools (RunProgramInGuest).
 *   Disks are processed in the order defined in the additionalDisks input array,
 *   correlated by UUID to physical devices on SCSI Controller 1.
 *
 * Invocation:
 *   Called synchronously as a nested workflow from workflow_VMDeployParent.
 *   Must be called AFTER disk UUID extraction (diskUuidMapJson must be populated).
 *   Only called when additionalDisks array is non-empty.
 *
 * Prerequisites:
 *   - VMware Tools installed and running on guest
 *   - disk.EnableUUID = TRUE on base image template (V3 validation)
 *   - Blueprint assigns additional disks to SCSI Controller 1 (V6 validation)
 *   - extractDiskUUIDs action has been run; diskUuidMapJson passed in
 *   - vCenter credentials with Guest Operations privilege
 *   - Windows PowerShell available (all Server 2016+ include 5.1)
 *   - Guest account has local admin rights
 *
 * Partition/filesystem logic:
 *   - sizeGb < 2048:  MBR partition table, NTFS
 *   - sizeGb >= 2048: GPT partition table, NTFS
 *
 * Inputs:
 *   vm             {VC:VirtualMachine} - Target VM
 *   guestUsername  {string}            - Local admin username (post-rename if applicable)
 *   guestPassword  {SecureString}      - Local admin password (post-update if applicable)
 *   additionalDisks {string}           - JSON array: [{driveLetter, driveLabel, sizeGb}]
 *   diskUuidMapJson {string}           - JSON from extractDiskUUIDs: [{index, uuid, unitNumber}]
 *
 * Output:
 *   executionSummary {string}          - Per-disk result log
 *
 * Idempotency:
 *   Script checks PartitionStyle before initializing. Disks that are not RAW
 *   are skipped with exit code 2 to prevent data loss on re-run.
 */

var SCRIPT_THRESHOLD_GB = 2048;
var MAX_WAIT_MS         = 120000; // 2 minutes per disk
var POLL_MS             = 5000;

var disks   = null;
var uuidMap = null;
var summary = [];

try {
    // --- Input validation ---
    if (!vm)              throw new Error("Input 'vm' is required.");
    if (!guestUsername)   throw new Error("Input 'guestUsername' is required.");
    if (!guestPassword)   throw new Error("Input 'guestPassword' is required.");
    if (!additionalDisks) throw new Error("Input 'additionalDisks' is required.");
    if (!diskUuidMapJson) throw new Error("Input 'diskUuidMapJson' is required.");

    // --- Parse inputs ---
    try { disks   = JSON.parse(additionalDisks); }
    catch (e) { throw new Error("Failed to parse additionalDisks JSON: " + e.message); }

    try { uuidMap = JSON.parse(diskUuidMapJson); }
    catch (e) { throw new Error("Failed to parse diskUuidMapJson: " + e.message); }

    if (!disks || disks.length === 0) {
        throw new Error("additionalDisks array is empty. Nothing to process.");
    }
    if (disks.length !== uuidMap.length) {
        throw new Error(
            "Array length mismatch. additionalDisks: " + disks.length +
            " diskUuidMap: " + uuidMap.length
        );
    }

    System.log("workflow_MountFormatDisks_Windows: Processing " + disks.length + " disk(s) on VM: " + vm.name);

    // --- Guest credentials ---
    var guestAuth      = new VcNamePasswordAuthentication();
    guestAuth.username = guestUsername;
    guestAuth.password = guestPassword;

    // --- Guest operations managers ---
    var serviceInstance = VcPlugin.getAllSdkConnections()[0].serviceInstance;
    var guestOps        = serviceInstance.content.guestOperationsManager;
    var processManager  = guestOps.processManager;
    var fileManager     = guestOps.fileManager;

    // --- Process each disk sequentially ---
    for (var i = 0; i < disks.length; i++) {
        var disk      = disks[i];
        var uuidEntry = uuidMap[i];

        var driveLetter = disk.driveLetter
            ? disk.driveLetter.replace(":", "").trim().toUpperCase()
            : null;
        var driveLabel  = disk.driveLabel ? disk.driveLabel.trim()  : "Data";
        var sizeGb      = disk.sizeGb     ? parseInt(disk.sizeGb)   : 0;
        var diskUuid    = uuidEntry.uuid;

        // Per-disk validation
        if (!driveLetter || driveLetter.length !== 1 || !/[D-Z]/.test(driveLetter)) {
            throw new Error(
                "Disk[" + i + "]: Invalid driveLetter '" + disk.driveLetter +
                "'. Must be a single letter D-Z."
            );
        }
        if (!diskUuid) {
            throw new Error("Disk[" + i + "]: Missing UUID at index " + i);
        }
        if (sizeGb <= 0) {
            throw new Error("Disk[" + i + "]: Invalid sizeGb: " + sizeGb);
        }

        var partitionStyle = (sizeGb >= SCRIPT_THRESHOLD_GB) ? "GPT" : "MBR";

        System.log(
            "Disk[" + i + "]: UUID=" + diskUuid +
            " Letter=" + driveLetter + ": Label=" + driveLabel +
            " Size=" + sizeGb + "GB PartitionStyle=" + partitionStyle
        );

        // --- Build PowerShell script ---
        var psScript = [
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
            "# Initialize disk",
            "Initialize-Disk -Number $disk.Number -PartitionStyle $partStyle -Confirm:$false",
            "",
            "# Create primary partition using full disk",
            "New-Partition -DiskNumber $disk.Number -UseMaximumSize -DriveLetter $driveLetter | Out-Null",
            "",
            "# Format NTFS with label",
            "Format-Volume -DriveLetter $driveLetter -FileSystem NTFS -NewFileSystemLabel $driveLabel -Confirm:$false -Force | Out-Null",
            "",
            "Write-Output \"SUCCESS: UUID=$targetUuid formatted NTFS ($partStyle), Letter=${driveLetter}:, Label=$driveLabel\"",
            "exit 0"
        ].join("\r\n");

        var scriptPath = "C:\\Windows\\Temp\\vcf_disk_" + i + "_" + driveLetter + ".ps1";

        // --- Transfer script to guest ---
        var winFileAttr = new VcGuestWindowsFileAttributes();
        var transferUrl = fileManager.initiateFileTransferToGuest(
            vm, guestAuth, scriptPath, winFileAttr, psScript.length, true
        );
        _uploadScript(vm, transferUrl, psScript, "Disk" + i + "-Win");

        // --- Execute script ---
        var progSpec              = new VcGuestProgramSpec();
        progSpec.programPath      = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
        progSpec.arguments        = "-NonInteractive -ExecutionPolicy Bypass -File \"" + scriptPath + "\"";
        progSpec.workingDirectory = "C:\\Windows\\Temp";

        var pid = processManager.startProgram(vm, guestAuth, progSpec);
        System.log("Disk[" + i + "]: PowerShell started. PID: " + pid);

        // --- Poll for completion ---
        var elapsed  = 0;
        var exitCode = null;

        while (elapsed < MAX_WAIT_MS) {
            System.sleep(POLL_MS);
            elapsed += POLL_MS;

            var pids     = new java.util.ArrayList();
            pids.add(pid);
            var procInfo = processManager.listProcessesInGuest(vm, guestAuth, pids);

            if (procInfo && procInfo.length > 0 && procInfo[0].exitCode !== null) {
                exitCode = procInfo[0].exitCode;
                break;
            }
            System.log("Disk[" + i + "]: Waiting... " + elapsed + "ms elapsed.");
        }

        if (exitCode === null) {
            throw new Error("Disk[" + i + "]: Script timed out after " + MAX_WAIT_MS + "ms. PID: " + pid);
        }
        if (exitCode !== 0) {
            throw new Error(
                "Disk[" + i + "]: Script exited with code " + exitCode +
                ". UUID=" + diskUuid + " Letter=" + driveLetter + ":"
            );
        }

        var diskResult = "Disk[" + i + "]: SUCCESS — " + driveLetter + ": (" +
                         driveLabel + ") " + sizeGb + "GB " + partitionStyle + "+NTFS UUID=" + diskUuid;
        System.log(diskResult);
        summary.push(diskResult);
    }

    executionSummary = summary.join("\n");
    System.log("workflow_MountFormatDisks_Windows: Completed.\n" + executionSummary);

} catch (e) {
    System.error("workflow_MountFormatDisks_Windows FAILED: " + e.message);
    throw e;
}

// =========================================================================
// Helper: Upload script via transient REST host
// =========================================================================
function _uploadScript(vm, transferUrl, content, tag) {
    var baseUrl       = transferUrl.substring(0, transferUrl.indexOf("/", 8));
    var uploadHost    = RESTHostManager.createHost("upload-" + tag + "-" + vm.name);
    var transientHost = RESTHostManager.createTransientHostFrom(uploadHost);
    RESTHostManager.reloadConfiguration();
    transientHost.url              = baseUrl;
    transientHost.hostVerification = false;

    try {
        var req = transientHost.createRequest("PUT", transferUrl, "application/octet-stream");
        req.setContent(content);
        var resp = req.execute();
        if (resp.statusCode !== 200) {
            throw new Error(
                "Script upload failed [" + tag + "]. HTTP " + resp.statusCode +
                ": " + resp.contentAsString
            );
        }
        System.log("Script uploaded [" + tag + "].");
    } finally {
        try {
            RESTHostManager.removeHost(transientHost);
        } catch (err) {
            System.warn("Upload host cleanup [" + tag + "]: " + err.message);
        }
    }
}
