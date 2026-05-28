/**
 * Workflow: workflow_RenameLocalAdmin
 * Module: com.vcf.guestcustomization
 *
 * Purpose:
 *   Renames the built-in local administrator account on Windows or the root-equivalent
 *   account on Linux via VMware Tools (RunProgramInGuest). OS type is determined
 *   from the workflow input and the appropriate script branch is executed.
 *
 * Invocation:
 *   Called synchronously as a nested workflow from workflow_VMDeployParent.
 *   Blocking — parent waits for completion before proceeding.
 *
 * Prerequisites:
 *   - VMware Tools installed and running on guest
 *   - vCenter credentials with Guest Operations privilege
 *   - Windows: script runs as local admin (built-in Administrator)
 *   - Linux: script runs as root or sudo-enabled user
 *   - For Windows: Built-in Administrator account must be enabled (default on Server OS)
 *
 * Inputs:
 *   vm              {VC:VirtualMachine} - Target VM
 *   osType          {string}            - "windows" or "linux"
 *   guestUsername   {string}            - Current admin/root username for authentication
 *   guestPassword   {SecureString}      - Current admin/root password
 *   newAdminName    {string}            - New name for the administrator account
 *
 * Output:
 *   executionResult {string}            - Result message
 *
 * Windows behaviour:
 *   Renames the built-in Administrator account (SID S-1-5-21-*-500) by SID lookup,
 *   not by current name, making the rename idempotent and name-independent.
 *
 * Linux behaviour:
 *   Renames the account matching guestUsername using `usermod -l`.
 *   Updates the home directory if it matches the old username pattern.
 *   Updates /etc/sudoers.d entry if present.
 */

var MAX_WAIT_MS  = 60000;  // 1 minute
var POLL_MS      = 5000;

try {
    // --- Input validation ---
    if (!vm)            throw new Error("Input 'vm' is required.");
    if (!osType)        throw new Error("Input 'osType' is required. Expected: 'windows' or 'linux'.");
    if (!guestUsername) throw new Error("Input 'guestUsername' is required.");
    if (!guestPassword) throw new Error("Input 'guestPassword' is required.");
    if (!newAdminName)  throw new Error("Input 'newAdminName' is required.");

    var osTypeLower = osType.toLowerCase().trim();
    if (osTypeLower !== "windows" && osTypeLower !== "linux") {
        throw new Error("Input 'osType' must be 'windows' or 'linux'. Received: '" + osType + "'");
    }

    // Validate newAdminName — no spaces or special shell characters
    if (!/^[a-zA-Z0-9_\-\.]{1,20}$/.test(newAdminName)) {
        throw new Error(
            "Input 'newAdminName' contains invalid characters or exceeds 20 characters. " +
            "Allowed: alphanumeric, underscore, hyphen, period. Received: '" + newAdminName + "'"
        );
    }

    System.log(
        "workflow_RenameLocalAdmin: VM=" + vm.name +
        " OS=" + osTypeLower +
        " CurrentUser=" + guestUsername +
        " NewName=" + newAdminName
    );

    // --- Guest credentials ---
    var guestAuth      = new VcNamePasswordAuthentication();
    guestAuth.username = guestUsername;
    guestAuth.password = guestPassword;

    // --- Guest operations managers ---
    var serviceInstance = VcPlugin.getAllSdkConnections()[0].serviceInstance;
    var guestOps        = serviceInstance.content.guestOperationsManager;
    var processManager  = guestOps.processManager;
    var fileManager     = guestOps.fileManager;

    var scriptContent   = null;
    var programPath     = null;
    var programArgs     = null;
    var scriptPath      = null;

    // =========================================================================
    // WINDOWS BRANCH
    // =========================================================================
    if (osTypeLower === "windows") {
        scriptPath  = "C:\\Windows\\Temp\\vcf_rename_admin.ps1";
        programPath = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
        programArgs = "-NonInteractive -ExecutionPolicy Bypass -File \"" + scriptPath + "\"";

        // Rename built-in Administrator by SID suffix -500 (idempotent, name-independent)
        scriptContent = [
            "$ErrorActionPreference = 'Stop'",
            "$newName = '" + newAdminName.replace(/'/g, "") + "'",
            "",
            "# Locate built-in Administrator account by SID (ends in -500)",
            "$adminAccount = Get-LocalUser | Where-Object {",
            "    $_.SID.Value -match '-500$'",
            "}",
            "",
            "if (-not $adminAccount) {",
            "    Write-Error 'Built-in Administrator account (SID -500) not found.'",
            "    exit 1",
            "}",
            "",
            "if ($adminAccount.Name -eq $newName) {",
            "    Write-Output \"INFO: Administrator account is already named '$newName'. No change required.\"",
            "    exit 0",
            "}",
            "",
            "Rename-LocalUser -Name $adminAccount.Name -NewName $newName",
            "Write-Output \"SUCCESS: Renamed '$($adminAccount.Name)' to '$newName'\"",
            "exit 0"
        ].join("\r\n");

        // Transfer script
        var winFileAttr = new VcGuestWindowsFileAttributes();
        var transferUrl = fileManager.initiateFileTransferToGuest(
            vm, guestAuth, scriptPath, winFileAttr, scriptContent.length, true
        );

        _uploadScript(vm, transferUrl, scriptContent, "RenameLocalAdmin-Windows");

    // =========================================================================
    // LINUX BRANCH
    // =========================================================================
    } else {
        scriptPath  = "/tmp/vcf_rename_admin.sh";
        programPath = "/bin/bash";
        programArgs = scriptPath;

        var safeOldName = guestUsername.replace(/'/g, "");
        var safeNewName = newAdminName.replace(/'/g, "");

        scriptContent = [
            "#!/bin/bash",
            "set -euo pipefail",
            "",
            "OLD_NAME='" + safeOldName + "'",
            "NEW_NAME='" + safeNewName + "'",
            "",
            "# Check if target name already exists (idempotent)",
            "if id \"$NEW_NAME\" &>/dev/null; then",
            "    echo \"INFO: Account '$NEW_NAME' already exists. No rename required.\"",
            "    exit 0",
            "fi",
            "",
            "# Verify source account exists",
            "if ! id \"$OLD_NAME\" &>/dev/null; then",
            "    echo \"ERROR: Source account '$OLD_NAME' not found.\" >&2",
            "    exit 1",
            "fi",
            "",
            "# Rename account",
            "usermod -l \"$NEW_NAME\" \"$OLD_NAME\"",
            "",
            "# Rename home directory if it matches old name pattern",
            "OLD_HOME=\"/home/$OLD_NAME\"",
            "NEW_HOME=\"/home/$NEW_NAME\"",
            "if [ -d \"$OLD_HOME\" ] && [ ! -d \"$NEW_HOME\" ]; then",
            "    usermod -d \"$NEW_HOME\" -m \"$NEW_NAME\"",
            "    echo \"INFO: Home directory moved from $OLD_HOME to $NEW_HOME\"",
            "fi",
            "",
            "# Update /etc/sudoers.d entry if present",
            "SUDOERS_FILE=\"/etc/sudoers.d/$OLD_NAME\"",
            "if [ -f \"$SUDOERS_FILE\" ]; then",
            "    sed -i \"s/^$OLD_NAME /$NEW_NAME /g\" \"$SUDOERS_FILE\"",
            "    mv \"$SUDOERS_FILE\" \"/etc/sudoers.d/$NEW_NAME\"",
            "    echo \"INFO: sudoers.d entry updated from $OLD_NAME to $NEW_NAME\"",
            "fi",
            "",
            "echo \"SUCCESS: Account renamed from '$OLD_NAME' to '$NEW_NAME'\"",
            "exit 0"
        ].join("\n");

        var linuxFileAttr       = new VcGuestPosixFileAttributes();
        linuxFileAttr.permissions = 0700;
        var linuxTransferUrl    = fileManager.initiateFileTransferToGuest(
            vm, guestAuth, scriptPath, linuxFileAttr, scriptContent.length, true
        );

        _uploadScript(vm, linuxTransferUrl, scriptContent, "RenameLocalAdmin-Linux");
    }

    // --- Execute script ---
    var progSpec              = new VcGuestProgramSpec();
    progSpec.programPath      = programPath;
    progSpec.arguments        = programArgs;
    progSpec.workingDirectory = (osTypeLower === "windows") ? "C:\\Windows\\Temp" : "/tmp";

    var pid = processManager.startProgram(vm, guestAuth, progSpec);
    System.log("workflow_RenameLocalAdmin: Script started. PID: " + pid);

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
        System.log("workflow_RenameLocalAdmin: Waiting... " + elapsed + "ms elapsed.");
    }

    if (exitCode === null) {
        throw new Error("Script timed out after " + MAX_WAIT_MS + "ms. PID: " + pid);
    }
    if (exitCode !== 0) {
        throw new Error("Script exited with code " + exitCode + " on VM: " + vm.name);
    }

    // --- Cleanup script from guest ---
    try {
        fileManager.deleteFileInGuest(vm, guestAuth, scriptPath);
        System.log("workflow_RenameLocalAdmin: Temp script removed from guest.");
    } catch (cleanupErr) {
        System.warn("workflow_RenameLocalAdmin: Script cleanup warning: " + cleanupErr.message);
    }

    executionResult = "SUCCESS: Local admin account renamed to '" + newAdminName +
                      "' on VM: " + vm.name;
    System.log(executionResult);

} catch (e) {
    System.error("workflow_RenameLocalAdmin FAILED: " + e.message);
    throw e;
}

// =========================================================================
// Helper: Upload script content via transient REST host (file transfer URL)
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
        System.log("workflow_RenameLocalAdmin: Script uploaded [" + tag + "].");
    } finally {
        try {
            RESTHostManager.removeHost(transientHost);
            System.log("workflow_RenameLocalAdmin: Upload transient host removed [" + tag + "].");
        } catch (err) {
            System.warn("workflow_RenameLocalAdmin: Upload host cleanup warning [" + tag + "]: " + err.message);
        }
    }
}
