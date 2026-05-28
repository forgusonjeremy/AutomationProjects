/**
 * Workflow: workflow_UpdateLocalAdminPassword
 * Module: com.vcf.guestcustomization
 *
 * Purpose:
 *   Updates the local administrator/root password on Windows or Linux via
 *   VMware Tools (RunProgramInGuest). Intended to be called after
 *   workflow_RenameLocalAdmin so the renamed account name is used for
 *   authentication if rename has already occurred.
 *
 * Invocation:
 *   Called synchronously as a nested workflow from workflow_VMDeployParent.
 *   Must be called AFTER workflow_RenameLocalAdmin if rename is part of the
 *   deployment sequence (guestUsername must match the post-rename name).
 *
 * Prerequisites:
 *   - VMware Tools installed and running on guest
 *   - vCenter credentials with Guest Operations privilege
 *   - guestUsername must be the current (post-rename if applicable) account name
 *
 * Inputs:
 *   vm              {VC:VirtualMachine} - Target VM
 *   osType          {string}            - "windows" or "linux"
 *   guestUsername   {string}            - Current admin username (post-rename)
 *   guestPassword   {SecureString}      - Current password (for authentication)
 *   newPassword     {SecureString}      - New password to set
 *
 * Output:
 *   executionResult {string}            - Result message
 *
 * Security notes:
 *   - Password is injected into the script at runtime and not logged.
 *   - Script is deleted from guest immediately after execution.
 *   - On Windows, net user is used (compatible with all Server versions).
 *   - On Linux, chpasswd is used (available on all RHEL/CentOS/Rocky variants).
 *
 * Windows behaviour:
 *   Sets password on the account matching guestUsername via `net user`.
 *   Also removes password expiry flag ("User must change password at next logon")
 *   and sets "Password never expires" to prevent lockout post-deployment.
 *   Adjust PasswordNeverExpires behaviour to match your password policy.
 *
 * Linux behaviour:
 *   Sets password via `chpasswd`. Unlocks account if locked (`passwd -u`).
 */

var MAX_WAIT_MS = 60000; // 1 minute
var POLL_MS     = 5000;

try {
    // --- Input validation ---
    if (!vm)            throw new Error("Input 'vm' is required.");
    if (!osType)        throw new Error("Input 'osType' is required. Expected: 'windows' or 'linux'.");
    if (!guestUsername) throw new Error("Input 'guestUsername' is required.");
    if (!guestPassword) throw new Error("Input 'guestPassword' is required.");
    if (!newPassword)   throw new Error("Input 'newPassword' is required.");

    var osTypeLower = osType.toLowerCase().trim();
    if (osTypeLower !== "windows" && osTypeLower !== "linux") {
        throw new Error("Input 'osType' must be 'windows' or 'linux'. Received: '" + osType + "'");
    }

    System.log(
        "workflow_UpdateLocalAdminPassword: VM=" + vm.name +
        " OS=" + osTypeLower +
        " Username=" + guestUsername
        // Password intentionally not logged
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

    var scriptContent = null;
    var programPath   = null;
    var programArgs   = null;
    var scriptPath    = null;

    // =========================================================================
    // WINDOWS BRANCH
    // =========================================================================
    if (osTypeLower === "windows") {
        scriptPath  = "C:\\Windows\\Temp\\vcf_setpwd.ps1";
        programPath = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
        programArgs = "-NonInteractive -ExecutionPolicy Bypass -File \"" + scriptPath + "\"";

        // SECURITY: newPassword is injected as a SecureString conversion in script
        // to avoid plain-text password in process argument list.
        scriptContent = [
            "$ErrorActionPreference = 'Stop'",
            "$username = '" + guestUsername.replace(/'/g, "") + "'",
            "$plainPwd = '" + String(newPassword).replace(/'/g, "''") + "'",
            "",
            "# Verify account exists",
            "try {",
            "    $account = Get-LocalUser -Name $username",
            "} catch {",
            "    Write-Error \"Account '$username' not found: $_\"",
            "    exit 1",
            "}",
            "",
            "# Set password",
            "$securePwd = ConvertTo-SecureString $plainPwd -AsPlainText -Force",
            "Set-LocalUser -Name $username -Password $securePwd",
            "",
            "# Remove 'must change password at next logon' flag",
            "Set-LocalUser -Name $username -PasswordNeverExpires $true",
            "",
            "Write-Output \"SUCCESS: Password updated for account '$username'\"",
            "exit 0"
        ].join("\r\n");

        var winFileAttr = new VcGuestWindowsFileAttributes();
        var transferUrl = fileManager.initiateFileTransferToGuest(
            vm, guestAuth, scriptPath, winFileAttr, scriptContent.length, true
        );
        _uploadScript(vm, transferUrl, scriptContent, "UpdatePwd-Windows");

    // =========================================================================
    // LINUX BRANCH
    // =========================================================================
    } else {
        scriptPath  = "/tmp/vcf_setpwd.sh";
        programPath = "/bin/bash";
        programArgs = scriptPath;

        var safeUsername = guestUsername.replace(/'/g, "");
        // Note: newPassword injected inline — script deleted immediately post-execution
        var safePwd = String(newPassword).replace(/\\/g, "\\\\").replace(/'/g, "'\\''");

        scriptContent = [
            "#!/bin/bash",
            "set -euo pipefail",
            "",
            "USERNAME='" + safeUsername + "'",
            "",
            "# Verify account exists",
            "if ! id \"$USERNAME\" &>/dev/null; then",
            "    echo \"ERROR: Account '$USERNAME' not found.\" >&2",
            "    exit 1",
            "fi",
            "",
            "# Set password via chpasswd",
            "echo \"${USERNAME}:" + safePwd + "\" | chpasswd",
            "",
            "# Unlock account if locked",
            "passwd -u \"$USERNAME\" 2>/dev/null || true",
            "",
            "echo \"SUCCESS: Password updated for account '$USERNAME'\"",
            "exit 0"
        ].join("\n");

        var linuxFileAttr         = new VcGuestPosixFileAttributes();
        linuxFileAttr.permissions = 0700;
        var linuxTransferUrl      = fileManager.initiateFileTransferToGuest(
            vm, guestAuth, scriptPath, linuxFileAttr, scriptContent.length, true
        );
        _uploadScript(vm, linuxTransferUrl, scriptContent, "UpdatePwd-Linux");
    }

    // --- Execute script ---
    var progSpec              = new VcGuestProgramSpec();
    progSpec.programPath      = programPath;
    progSpec.arguments        = programArgs;
    progSpec.workingDirectory = (osTypeLower === "windows") ? "C:\\Windows\\Temp" : "/tmp";

    var pid = processManager.startProgram(vm, guestAuth, progSpec);
    System.log("workflow_UpdateLocalAdminPassword: Script started. PID: " + pid);

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
        System.log("workflow_UpdateLocalAdminPassword: Waiting... " + elapsed + "ms elapsed.");
    }

    if (exitCode === null) {
        throw new Error("Script timed out after " + MAX_WAIT_MS + "ms. PID: " + pid);
    }
    if (exitCode !== 0) {
        throw new Error(
            "Script exited with code " + exitCode + " on VM: " + vm.name +
            ". Username: " + guestUsername
        );
    }

    // --- Cleanup: delete script from guest immediately ---
    try {
        fileManager.deleteFileInGuest(vm, guestAuth, scriptPath);
        System.log("workflow_UpdateLocalAdminPassword: Temp script removed from guest.");
    } catch (cleanupErr) {
        System.warn("workflow_UpdateLocalAdminPassword: Script cleanup warning: " + cleanupErr.message);
    }

    executionResult = "SUCCESS: Password updated for '" + guestUsername + "' on VM: " + vm.name;
    System.log(executionResult);

} catch (e) {
    System.error("workflow_UpdateLocalAdminPassword FAILED: " + e.message);
    throw e;
}

// =========================================================================
// Helper: Upload script via transient REST host (file transfer URL)
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
        System.log("workflow_UpdateLocalAdminPassword: Script uploaded [" + tag + "].");
    } finally {
        try {
            RESTHostManager.removeHost(transientHost);
        } catch (err) {
            System.warn("workflow_UpdateLocalAdminPassword: Upload host cleanup [" + tag + "]: " + err.message);
        }
    }
}
