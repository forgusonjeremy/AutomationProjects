/* ============================================================================
 * WORKFLOW: Format Disks (Windows)   (workflow_MountFormatDisks_Windows)
 * MODULE:   com.broadcom.pso.vcfa.vm.guestScripting
 * WF ID:    2114fa72-0162-4928-8016-3ab0002472b6
 *
 * Single-file reference. In vRO these are SEPARATE artifacts:
 *   - Actions (extractDiskUUIDs, uploadGuestScript, utf8ByteLength)
 *   - 1 Workflow: 5 scriptable tasks + 1 action call + 1 decision, wired as a
 *     manual per-disk loop.
 * Each section below maps 1:1 to a canvas object.
 *
 * PURPOSE:
 *   Initialize, partition, format, and assign drive letters to additional data
 *   disks on a Windows VM via VMware Tools. Correlation is by VMDK UUID
 *   (exposed in-guest as disk SerialNumber, WITHOUT dashes, lowercase) and is
 *   controller-agnostic; data disks may reside on SCSI Controllers 1-3.
 *
 * WORKFLOW INPUTS:
 *   vm              {VC:VirtualMachine}  Target VM
 *   guestUsername   {string}             Local admin username (post-rename)
 *   guestPassword   {SecureString}       Local admin password (post-update)
 *   additionalDisks {string}             JSON array: [{driveLetter, driveLabel, sizeGb, SCSIController}]
 *
 * WORKFLOW OUTPUT:
 *   executionSummary {string}            Per-disk result log
 *
 * WORKFLOW ATTRIBUTES:
 *   MAX_WAIT_MS         {number} = 120000  (per-disk script timeout; NTFS format
 *                                           time scales with volume size)
 *   POLL_MS             {number} = 5000
 *   SCRIPT_THRESHOLD_GB {number} = 2048    (< threshold: MBR, >= threshold: GPT)
 *   diskCount           {number}
 *   diskIndex           {number}
 *   summary             {Array/string}
 *   guestAuth           {Any}
 *   processManager      {VC:GuestProcessManager}
 *   fileManager         {VC:GuestFileManager}
 *   curScriptPath       {string}
 *   curUuid             {string}
 *   curDriveLetter      {string}
 *   curDriveLabel       {string}
 *   curSizeGb           {string}
 *   curPartStyle        {string}
 *   diskUuidMapJson     {string}
 *
 * CANVAS FLOW (root = item2):
 *   item2 (extractDiskUUIDs action) -> item1 (Validate Inputs)
 *     -> item3 (Prepare Guest Ops) -> item5 [Decision: More Disks?]
 *        true  -> item6 (Build & Upload) -> item7 (Execute & Poll)
 *                 -> item8 (Increase counter: diskIndex) -> item5
 *        false -> item9 (Compile Results) -> item4 (End)
 *
 * PREREQUISITES:
 *   - VMware Tools installed and running on guest
 *   - disk.EnableUUID = TRUE on base template
 *   - extractDiskUUIDs emits entries in the SAME order as additionalDisks
 *   - vCenter credentials with Guest Operations privilege
 * ==========================================================================*/


/* ============================================================================
 * item2 — extractDiskUUIDs   (Action call: com.broadcom.pso.vcfa.vm.diskManagement/extractDiskUUIDs)
 * ROOT element. Auto-generated; cannot be modified in the editor.
 * IN-binding:  vm <- vm ; additionalDisksJson <- additionalDisks
 * OUT-binding: actionResult -> diskUuidMapJson
 * NEXT: item1
 * ==========================================================================*/
//Auto generated script, cannot be modified !
actionResult = System.getModule("com.broadcom.pso.vcfa.vm.diskManagement").extractDiskUUIDs(vm, additionalDisksJson);


/* ============================================================================
 * item1 — Validate Inputs   (Scriptable Task)
 * IN:  vm, guestUsername, guestPassword, additionalDisks
 * OUT: diskCount, diskIndex, summary
 * NEXT: item3
 * ==========================================================================*/
if (!vm)              throw new Error("Input 'vm' is required.");
if (!guestUsername)   throw new Error("Input 'guestUsername' is required.");
if (!guestPassword)   throw new Error("Input 'guestPassword' is required.");
if (!additionalDisks) throw new Error("Input 'additionalDisks' is required.");

var disks;
try {
    disks = JSON.parse(additionalDisks);
    if (typeof disks === "string") { disks = JSON.parse(disks); }  // unwrap double-encode
} catch (e) {
    throw new Error("Failed to parse additionalDisks JSON: " + e.message);
}

if (!disks || disks.length === 0) throw new Error("additionalDisks array is empty. Nothing to process.");

diskCount = disks.length;
diskIndex = 0;
summary   = [];
System.log("workflow_MountFormatDisks_Windows: Processing " + diskCount + " disk(s) on VM: " + vm.name);


/* ============================================================================
 * item3 — Prepare Guest Ops   (Scriptable Task)
 * IN:  guestUsername, guestPassword, vm
 * OUT: guestAuth, fileManager, processManager
 * NEXT: item5
 * ==========================================================================*/
guestAuth          = new VcNamePasswordAuthentication();
guestAuth.username = guestUsername;
guestAuth.password = guestPassword;
guestAuth.interactiveSession = false;

var guestOps   = vm.sdkConnection.guestOperationsManager;
processManager = guestOps.processManager;
fileManager    = guestOps.fileManager;


/* ============================================================================
 * item5 — More Disks?   (Decision / custom-condition)
 * IN:  diskIndex, diskCount
 *   true  (diskIndex < diskCount) -> item6
 *   false                          -> item9
 * ==========================================================================*/
if (diskIndex < diskCount) {
    return true;
}
else {
    return false;
}


/* ============================================================================
 * item6 — Build & Upload Current Disk   (Scriptable Task)
 * IN:  vm, guestAuth, fileManager, additionalDisks, diskUuidMapJson, diskIndex,
 *      SCRIPT_THRESHOLD_GB
 * OUT: curScriptPath, curUuid, curDriveLetter, curDriveLabel, curSizeGb, curPartStyle
 * NEXT: item7
 *
 * NOTE: the in-guest UUID match normalizes BOTH sides — Get-Disk SerialNumber
 *       exposes the VMDK UUID without dashes and lowercase.
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
        "$targetNorm = ($targetUuid -replace '[-:]','').ToLower()",
        "$disk = Get-Disk | Where-Object {($_.SerialNumber -replace '[-:]','').ToLower() -eq $targetNorm}",
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
 * item7 — Execute & Poll Current Disk   (Scriptable Task)
 * IN:  vm, guestAuth, processManager, curScriptPath, curUuid, curDriveLabel,
 *      curDriveLetter, curPartStyle, curSizeGb, MAX_WAIT_MS, POLL_MS, diskIndex, summary
 * OUT: summary
 * NEXT: item8
 * ==========================================================================*/
var progSpec              = new VcGuestProgramSpec();
progSpec.programPath      = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
progSpec.arguments        = "-NonInteractive -ExecutionPolicy Bypass -File \"" + curScriptPath + "\"";
progSpec.workingDirectory = "C:\\Windows\\Temp";

var pid = processManager.startProgramInGuest(vm, guestAuth, progSpec);
System.log("Disk[" + diskIndex + "]: PowerShell started. PID: " + pid);

var elapsed = 0, exitCode = null, sawRunning = false;
while (elapsed < MAX_WAIT_MS) {
    System.sleep(POLL_MS);
    elapsed += POLL_MS;
    var procInfo = processManager.listProcessesInGuest(vm, guestAuth, [pid]);
    if (procInfo && procInfo.length > 0) {
        sawRunning = true;
        if (procInfo[0].exitCode !== null) { exitCode = procInfo[0].exitCode; break; }
    } else if (sawRunning) {                       // dropped from table after running -> completed
        var all = processManager.listProcessesInGuest(vm, guestAuth, null);
        for (var k = 0; all && k < all.length; k++) {
            if (all[k].pid == pid && all[k].exitCode !== null) { exitCode = all[k].exitCode; break; }
        }
        if (exitCode === null) { System.warn("Disk[" + diskIndex + "]: PID " + pid + " gone, exit code unavailable; relying on in-script verification."); exitCode = 0; }
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
 * item8 — Increase counter   (Library: increase-counter)
 * IN/OUT: counter <- diskIndex ; counter -> diskIndex
 * NEXT: item5  (loop back to the decision)
 * ==========================================================================*/
//Auto-generated script
counter = counter + 1;


/* ============================================================================
 * item9 — Compile Results   (Scriptable Task)
 * IN:  summary
 * OUT: executionSummary
 * NEXT: item4 (End)
 * ==========================================================================*/
executionSummary = summary.join("\n");
System.log("workflow_MountFormatDisks_Windows: Completed.\n" + executionSummary);
