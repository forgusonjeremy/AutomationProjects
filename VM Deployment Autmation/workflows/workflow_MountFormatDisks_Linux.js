/**
 * Workflow: workflow_MountFormatDisks_Linux
 * Module: com.vcf.guestcustomization
 *
 * Purpose:
 *   Partitions, formats, mounts, and persists additional data disks on a RHEL
 *   Linux VM via VMware Tools (RunProgramInGuest). Disks are correlated by UUID
 *   to physical block devices and processed in additionalDisks array order.
 *
 * Invocation:
 *   Called synchronously as a nested workflow from workflow_VMDeployParent.
 *   Must be called AFTER disk UUID extraction (diskUuidMapJson must be populated).
 *   Only called when additionalDisks array is non-empty.
 *
 * Prerequisites:
 *   - open-vm-tools installed and running on guest
 *   - disk.EnableUUID = TRUE on base image template (V3 validation)
 *   - Blueprint assigns additional disks to SCSI Controller 1 (V6 validation)
 *   - extractDiskUUIDs action has been run; diskUuidMapJson passed in
 *   - vCenter credentials with Guest Operations privilege
 *   - Base image includes: parted, mkfs.ext4, mkfs.xfs, blkid, lsblk, partprobe
 *   - Guest account is root or has passwordless sudo for disk operations
 *
 * Partition/filesystem logic:
 *   - All disks: GPT partition table
 *   - sizeGb < 2048:  ext4 filesystem
 *   - sizeGb >= 2048: xfs filesystem
 *
 * Inputs:
 *   vm              {VC:VirtualMachine} - Target VM
 *   guestUsername   {string}            - Root or sudo-enabled username
 *   guestPassword   {SecureString}      - Guest password
 *   additionalDisks {string}            - JSON array: [{mountPoint, driveLabel, sizeGb}]
 *   diskUuidMapJson {string}            - JSON from extractDiskUUIDs: [{index, uuid, unitNumber}]
 *
 * Output:
 *   executionSummary {string}           - Per-disk result log
 *
 * Idempotency:
 *   Script checks for existing partitions and active mounts before proceeding.
 *   fstab entries are added only if the filesystem UUID is not already present.
 *   Disks with existing partitions exit with code 3 (no data loss).
 */

var SCRIPT_THRESHOLD_GB = 2048;
var MAX_WAIT_MS         = 180000; // 3 minutes per disk (large volume format time)
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

    System.log("workflow_MountFormatDisks_Linux: Processing " + disks.length + " disk(s) on VM: " + vm.name);

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

        var mountPoint = disk.mountPoint ? disk.mountPoint.trim() : null;
        var driveLabel = disk.driveLabel ? disk.driveLabel.trim() : "data";
        var sizeGb     = disk.sizeGb    ? parseInt(disk.sizeGb)  : 0;
        var diskUuid   = uuidEntry.uuid;

        // Per-disk validation
        if (!mountPoint || mountPoint.charAt(0) !== "/") {
            throw new Error(
                "Disk[" + i + "]: Invalid mountPoint '" + disk.mountPoint +
                "'. Must be an absolute path starting with /."
            );
        }
        if (!diskUuid) {
            throw new Error("Disk[" + i + "]: Missing UUID at index " + i);
        }
        if (sizeGb <= 0) {
            throw new Error("Disk[" + i + "]: Invalid sizeGb: " + sizeGb);
        }

        // Sanitize label: no spaces, max 12 chars (safe for both ext4 and xfs)
        var safeLabel  = driveLabel.replace(/[^a-zA-Z0-9_\-]/g, "_").substring(0, 12);
        var filesystem = (sizeGb >= SCRIPT_THRESHOLD_GB) ? "xfs" : "ext4";

        System.log(
            "Disk[" + i + "]: UUID=" + diskUuid +
            " MountPoint=" + mountPoint +
            " Label=" + safeLabel +
            " Size=" + sizeGb + "GB Filesystem=" + filesystem
        );

        // --- Build Bash script ---
        var bashScript = [
            "#!/bin/bash",
            "set -euo pipefail",
            "",
            "TARGET_UUID='" + diskUuid.replace(/'/g, "") + "'",
            "MOUNT_POINT='" + mountPoint.replace(/'/g, "") + "'",
            "FS_LABEL='"    + safeLabel.replace(/'/g, "")  + "'",
            "FILESYSTEM='"  + filesystem + "'",
            "",
            "# ---------------------------------------------------------------",
            "# Locate block device by VMware disk UUID",
            "# VMware exposes the VMDK UUID as the SCSI serial number.",
            "# Match via /dev/disk/by-id/ (primary) with lsblk fallback.",
            "# ---------------------------------------------------------------",
            "DEVICE=''",
            "CLEAN_UUID=$(echo \"$TARGET_UUID\" | tr -d '-' | tr '[:upper:]' '[:lower:]')",
            "",
            "for dev in /dev/disk/by-id/scsi-* /dev/disk/by-id/wwn-*; do",
            "    [ -e \"$dev\" ] || continue",
            "    SERIAL=$(basename \"$dev\" | sed 's/^scsi-//;s/^wwn-//')",
            "    CLEAN_SERIAL=$(echo \"$SERIAL\" | tr -d '-' | tr '[:upper:]' '[:lower:]')",
            "    if echo \"$CLEAN_SERIAL\" | grep -q \"$CLEAN_UUID\"; then",
            "        DEVICE=$(readlink -f \"$dev\")",
            "        break",
            "    fi",
            "done",
            "",
            "# Fallback: lsblk serial match",
            "if [ -z \"$DEVICE\" ]; then",
            "    while IFS= read -r line; do",
            "        DEV_NAME=$(echo \"$line\" | awk '{print $1}')",
            "        DEV_SERIAL=$(echo \"$line\" | awk '{print $2}')",
            "        CLEAN_SERIAL=$(echo \"$DEV_SERIAL\" | tr -d '-' | tr '[:upper:]' '[:lower:]')",
            "        if echo \"$CLEAN_SERIAL\" | grep -q \"$CLEAN_UUID\"; then",
            "            DEVICE=\"$DEV_NAME\"",
            "            break",
            "        fi",
            "    done < <(lsblk -dpno NAME,SERIAL 2>/dev/null)",
            "fi",
            "",
            "if [ -z \"$DEVICE\" ]; then",
            "    echo \"ERROR: Block device with UUID '$TARGET_UUID' not found.\" >&2",
            "    exit 1",
            "fi",
            "",
            "echo \"INFO: UUID $TARGET_UUID resolved to device $DEVICE\"",
            "",
            "# ---------------------------------------------------------------",
            "# Safety checks — prevent data loss on re-run",
            "# ---------------------------------------------------------------",
            "if mount | grep -q \"^${DEVICE}\"; then",
            "    echo \"ERROR: Device $DEVICE is already mounted. Skipping.\" >&2",
            "    exit 2",
            "fi",
            "",
            "EXISTING_PARTS=$(lsblk -no NAME \"$DEVICE\" 2>/dev/null | grep -v \"^$(basename $DEVICE)$\" | wc -l)",
            "if [ \"$EXISTING_PARTS\" -gt 0 ]; then",
            "    echo \"ERROR: Device $DEVICE already has partitions. Skipping.\" >&2",
            "    exit 3",
            "fi",
            "",
            "# ---------------------------------------------------------------",
            "# Partition with GPT (all sizes — consistent, supports >2TB)",
            "# ---------------------------------------------------------------",
            "parted -s \"$DEVICE\" mklabel gpt",
            "parted -s \"$DEVICE\" mkpart primary 0% 100%",
            "partprobe \"$DEVICE\"",
            "sleep 2",
            "",
            "# Resolve partition device node",
            "PARTITION=\"${DEVICE}1\"",
            "[ -b \"$PARTITION\" ] || PARTITION=\"${DEVICE}p1\"",
            "if [ ! -b \"$PARTITION\" ]; then",
            "    echo \"ERROR: Could not identify partition on $DEVICE\" >&2",
            "    exit 4",
            "fi",
            "",
            "# ---------------------------------------------------------------",
            "# Format filesystem",
            "# ---------------------------------------------------------------",
            "if [ \"$FILESYSTEM\" = 'xfs' ]; then",
            "    mkfs.xfs -L \"$FS_LABEL\" -f \"$PARTITION\"",
            "else",
            "    mkfs.ext4 -L \"$FS_LABEL\" -F \"$PARTITION\"",
            "fi",
            "echo \"INFO: Formatted $PARTITION as $FILESYSTEM with label $FS_LABEL\"",
            "",
            "# ---------------------------------------------------------------",
            "# Mount and persist via fstab",
            "# ---------------------------------------------------------------",
            "mkdir -p \"$MOUNT_POINT\"",
            "",
            "FS_UUID=$(blkid -s UUID -o value \"$PARTITION\")",
            "if [ -z \"$FS_UUID\" ]; then",
            "    echo \"ERROR: Could not retrieve filesystem UUID from $PARTITION\" >&2",
            "    exit 5",
            "fi",
            "",
            "# Add fstab entry (idempotent — skip if UUID already present)",
            "FSTAB_ENTRY=\"UUID=$FS_UUID  $MOUNT_POINT  $FILESYSTEM  defaults  0  2\"",
            "if grep -q \"UUID=$FS_UUID\" /etc/fstab; then",
            "    echo \"INFO: fstab entry for UUID=$FS_UUID already present. Skipping.\"",
            "else",
            "    echo \"$FSTAB_ENTRY\" >> /etc/fstab",
            "    echo \"INFO: fstab entry added: $FSTAB_ENTRY\"",
            "fi",
            "",
            "mount \"$MOUNT_POINT\"",
            "",
            "if mountpoint -q \"$MOUNT_POINT\"; then",
            "    echo \"SUCCESS: $MOUNT_POINT mounted from $PARTITION (FS_UUID=$FS_UUID) Filesystem=$FILESYSTEM Label=$FS_LABEL\"",
            "    exit 0",
            "else",
            "    echo \"ERROR: Mount verification failed for $MOUNT_POINT\" >&2",
            "    exit 6",
            "fi"
        ].join("\n");

        var scriptPath = "/tmp/vcf_disk_" + i + ".sh";

        // --- Transfer script to guest ---
        var linuxFileAttr         = new VcGuestPosixFileAttributes();
        linuxFileAttr.permissions = 0700;
        var transferUrl           = fileManager.initiateFileTransferToGuest(
            vm, guestAuth, scriptPath, linuxFileAttr, bashScript.length, true
        );
        _uploadScript(vm, transferUrl, bashScript, "Disk" + i + "-Linux");

        // --- Execute script ---
        var progSpec              = new VcGuestProgramSpec();
        progSpec.programPath      = "/bin/bash";
        progSpec.arguments        = scriptPath;
        progSpec.workingDirectory = "/tmp";

        var pid = processManager.startProgram(vm, guestAuth, progSpec);
        System.log("Disk[" + i + "]: Bash script started. PID: " + pid);

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
                ". UUID=" + diskUuid + " MountPoint=" + mountPoint
            );
        }

        // --- Cleanup script from guest ---
        try {
            fileManager.deleteFileInGuest(vm, guestAuth, scriptPath);
            System.log("Disk[" + i + "]: Temp script removed from guest.");
        } catch (cleanupErr) {
            System.warn("Disk[" + i + "]: Script cleanup warning: " + cleanupErr.message);
        }

        var diskResult = "Disk[" + i + "]: SUCCESS — " + mountPoint +
                         " (" + safeLabel + ") " + sizeGb + "GB " +
                         filesystem + " UUID=" + diskUuid;
        System.log(diskResult);
        summary.push(diskResult);
    }

    executionSummary = summary.join("\n");
    System.log("workflow_MountFormatDisks_Linux: Completed.\n" + executionSummary);

} catch (e) {
    System.error("workflow_MountFormatDisks_Linux FAILED: " + e.message);
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
