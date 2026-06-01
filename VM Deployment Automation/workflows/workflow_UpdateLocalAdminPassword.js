/**
 * Workflow: workflow_UpdateLocalAdminPassword
 * Module:   com.vcf.guestcustomization
 *
 * Purpose:
 *   Updates the local administrator/root password on Windows or Linux via
 *   VMware Tools (RunProgramInGuest / startProgram). Intended to be called
 *   after workflow_RenameLocalAdmin so the renamed account name is used for
 *   authentication.
 *
 * Invocation:
 *   Called synchronously as a nested workflow from workflow_VMDeployParent.
 *   Must be called AFTER workflow_RenameLocalAdmin if rename is part of the
 *   sequence (guestUsername must be the post-rename account name).
 *
 * Prerequisites:
 *   - VMware Tools installed and running on guest
 *   - vCenter credentials with Guest Operations privilege
 *   - vRO truststore contains the SSL cert of every ESXi host in the cluster
 *     (initiateFileTransferToGuest returns an ESXi-hosted PUT URL)
 *   - guestUsername is the CURRENT (post-rename if applicable) account name
 *   - guestPassword is the CURRENT password (may be blank post-sysprep)
 *
 * Structure (vRO workflow canvas):
 *   item2  "Upload and Execute Script"  (Scriptable Task)
 *   item3  "Poll for Completion"        (Scriptable Task)
 *
 * Security:
 *   - newPassword is injected into the guest script at runtime, never logged.
 *   - Script is deleted from the guest immediately after execution.
 *
 * CRITICAL credential behaviour:
 *   The guest script changes the account password. As soon as it commits,
 *   the original credentials (guestPassword) become invalid. Any poll cycle
 *   that runs after the change must authenticate with newPassword. Element
 *   item3 therefore tries originalAuth first, then falls back to newAuth.
 */


// =============================================================================
// CANVAS ELEMENT: item2 — "Upload and Execute Script"  (Scriptable Task)
// -----------------------------------------------------------------------------
// IN : vm            {VC:VirtualMachine}
//      vcenter       {VC:SdkConnection}
//      osType        {string}            "windows" | "linux"
//      guestUsername {string}            current admin username (post-rename)
//      guestPassword {SecureString}      current password (may be blank)
//      newPassword   {SecureString}      target password
// OUT: scriptPath    {string}
//      pid           {number}
// =============================================================================
try {
    // --- Input validation ---
    if (!vm)            throw new Error("Input 'vm' is required.");
    if (!vcenter)       throw new Error("Input 'vcenter' is required.");
    if (!osType)        throw new Error("Input 'osType' is required. Expected 'windows' or 'linux'.");
    if (!guestUsername) throw new Error("Input 'guestUsername' is required.");
    if (newPassword === null || newPassword === undefined)
                        throw new Error("Input 'newPassword' is required.");

    var osTypeLower = osType.toLowerCase().trim();
    if (osTypeLower !== "windows" && osTypeLower !== "linux") {
        throw new Error("Input 'osType' must be 'windows' or 'linux'. Received: '" + osType + "'");
    }

    System.log(
        "workflow_UpdateLocalAdminPassword [item2]: VM=" + vm.name +
        " OS=" + osTypeLower +
        " Username=" + guestUsername    // password intentionally not logged
    );

    // --- Guest credentials (CURRENT password — still valid until script commits) ---
    var guestAuth      = new VcNamePasswordAuthentication();
    guestAuth.username = guestUsername;
    guestAuth.password = guestPassword;
    guestAuth.interactiveSession = false;   // REQUIRED — non-interactive guest ops

    // --- Guest operations managers (resolve from explicit vcenter input) ---
    var guestOps       = vcenter.guestOperationsManager;
    var fileManager    = guestOps.fileManager;
    var processManager = guestOps.processManager;

    var scriptContent = null;
    var programPath   = null;
    var programArgs   = null;
    var transferUrl   = null;

    // -------------------------------------------------------------------------
    // WINDOWS BRANCH
    // -------------------------------------------------------------------------
    if (osTypeLower === "windows") {
        scriptPath  = "C:\\Windows\\Temp\\vcf_setpwd.ps1";
        programPath = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
        programArgs = "-NonInteractive -ExecutionPolicy Bypass -File \"" + scriptPath + "\"";

        var winUser = guestUsername.replace(/'/g, "");
        var winPwd  = String(newPassword).replace(/'/g, "''");   // PS single-quote escape

        scriptContent = [
            "$ErrorActionPreference = 'Stop'",
            "$username = '" + winUser + "'",
            "$plainPwd = '" + winPwd + "'",
            "",
            "try {",
            "    $account = Get-LocalUser -Name $username",
            "} catch {",
            "    Write-Error \"Account '$username' not found: $_\"",
            "    exit 1",
            "}",
            "",
            "$securePwd = ConvertTo-SecureString $plainPwd -AsPlainText -Force",
            "Set-LocalUser -Name $username -Password $securePwd",
            "",
            "# Prevent post-deployment lockout — adjust to local password policy",
            "Set-LocalUser -Name $username -PasswordNeverExpires $true",
            "",
            "Write-Output \"SUCCESS: Password updated for account '$username'\"",
            "exit 0"
        ].join("\r\n");

        var winFileAttr = new VcGuestWindowsFileAttributes();
        transferUrl = fileManager.initiateFileTransferToGuest(
            vm, guestAuth, scriptPath, winFileAttr, scriptContent.length, true
        );
        _uploadScript(vm, transferUrl, scriptContent, "UpdatePwd-Windows");

    // -------------------------------------------------------------------------
    // LINUX BRANCH
    // -------------------------------------------------------------------------
    } else {
        scriptPath  = "/tmp/vcf_setpwd.sh";
        programPath = "/bin/bash";
        programArgs = scriptPath;

        var nixUser = guestUsername.replace(/'/g, "");
        // Escape backslashes then single quotes for safe embedding in single-quoted bash
        var nixPwd  = String(newPassword).replace(/\\/g, "\\\\").replace(/'/g, "'\\''");

        scriptContent = [
            "#!/bin/bash",
            "set -euo pipefail",
            "",
            "USERNAME='" + nixUser + "'",
            "",
            "if ! id \"$USERNAME\" &>/dev/null; then",
            "    echo \"ERROR: Account '$USERNAME' not found.\" >&2",
            "    exit 1",
            "fi",
            "",
            "echo \"${USERNAME}:" + nixPwd + "\" | chpasswd",
            "passwd -u \"$USERNAME\" 2>/dev/null || true",
            "",
            "echo \"SUCCESS: Password updated for account '$USERNAME'\"",
            "exit 0"
        ].join("\n");

        var nixFileAttr         = new VcGuestPosixFileAttributes();
        nixFileAttr.permissions = 0700;
        transferUrl = fileManager.initiateFileTransferToGuest(
            vm, guestAuth, scriptPath, nixFileAttr, scriptContent.length, true
        );
        _uploadScript(vm, transferUrl, scriptContent, "UpdatePwd-Linux");
    }

    // --- Execute script (still under CURRENT credentials) ---
    var progSpec              = new VcGuestProgramSpec();
    progSpec.programPath      = programPath;
    progSpec.arguments        = programArgs;
    progSpec.workingDirectory = (osTypeLower === "windows") ? "C:\\Windows\\Temp" : "/tmp";

    pid = processManager.startProgram(vm, guestAuth, progSpec);
    System.log("workflow_UpdateLocalAdminPassword [item2]: Script started. PID=" + pid +
               " Path=" + scriptPath);

} catch (e) {
    System.error("workflow_UpdateLocalAdminPassword [item2] FAILED: " + e.message);
    throw e;
}

// -----------------------------------------------------------------------------
// Helper (scoped to item2): upload script via transient REST host.
// Transient + base host are created AND destroyed within this single block.
// -----------------------------------------------------------------------------
function _uploadScript(vm, transferUrl, content, tag) {
    var baseUrl       = transferUrl.substring(0, transferUrl.indexOf("/", 8)); // strip path after https://host:port
    var uploadHost    = RESTHostManager.createHost("upload-" + tag + "-" + vm.name);
    var transientHost = RESTHostManager.createTransientHostFrom(uploadHost);

    // Configuration MUST be set before reloadConfiguration()
    transientHost.url              = baseUrl;
    transientHost.hostVerification = false;
    RESTHostManager.reloadConfiguration();

    try {
        // Body is the 3rd argument to createRequest; contentType is a property.
        // RESTRequest has no setContent()/setRequestBody() method.
        var req = transientHost.createRequest("PUT", transferUrl, content);
        req.contentType = "application/octet-stream";
        var resp = req.execute();

        if (resp.statusCode !== 200) {
            throw new Error("Script upload failed [" + tag + "]. HTTP " +
                resp.statusCode + ": " + resp.contentAsString);
        }
        System.log("workflow_UpdateLocalAdminPassword [item2]: Script uploaded [" + tag + "].");
    } finally {
        if (transientHost) {
            try { RESTHostManager.removeHost(transientHost); }
            catch (e1) { System.warn("[item2] transient host cleanup [" + tag + "]: " + e1.message); }
        }
        try { RESTHostManager.removeHost(uploadHost); }
        catch (e2) { System.warn("[item2] base host cleanup [" + tag + "]: " + e2.message); }
    }
}


// =============================================================================
// CANVAS ELEMENT: item3 — "Poll for Completion"  (Scriptable Task)
// -----------------------------------------------------------------------------
// IN : vm            {VC:VirtualMachine}
//      vcenter       {VC:SdkConnection}
//      guestUsername {string}
//      guestPassword {SecureString}      original/current password
//      newPassword   {SecureString}      target password (valid post-commit)
//      scriptPath    {string}            from item2
//      pid           {number}            from item2
// OUT: executionResult {string}
// =============================================================================
var MAX_WAIT_MS = 60000;  // 1 minute
var POLL_MS     = 5000;

try {
    var processManager = vcenter.guestOperationsManager.processManager;
    var fileManager    = vcenter.guestOperationsManager.fileManager;

    // Both credential objects declared BEFORE the poll loop.
    // The script changes the password mid-flight: originalAuth dies the instant
    // it commits, after which only newAuth authenticates.
    var originalAuth      = new VcNamePasswordAuthentication();
    originalAuth.username = guestUsername;
    originalAuth.password = guestPassword;
    originalAuth.interactiveSession = false;

    var newAuth      = new VcNamePasswordAuthentication();
    newAuth.username = guestUsername;
    newAuth.password = newPassword;
    newAuth.interactiveSession = false;

    var elapsed  = 0;
    var exitCode = null;

    while (elapsed < MAX_WAIT_MS) {
        System.sleep(POLL_MS);
        elapsed += POLL_MS;

        // null pids => return all processes; filter by PID in JS.
        // (pids is long[] in the vSphere API; ArrayList/JS-array coercion fail here.)
        var procInfo = null;
        try {
            procInfo = processManager.listProcessesInGuest(vm, originalAuth, null);
        } catch (e1) {
            try {
                procInfo = processManager.listProcessesInGuest(vm, newAuth, null);
            } catch (e2) {
                throw new Error("listProcessesInGuest failed with both credentials. " +
                    "Original: " + e1.message + " | New: " + e2.message);
            }
        }

        for (var i = 0; i < procInfo.length; i++) {
            if (procInfo[i].pid == pid) {
                if (procInfo[i].exitCode != null) {
                    exitCode = procInfo[i].exitCode;
                }
                break;   // matched; exitCode null means still running
            }
        }

        if (exitCode != null) { break; }
        System.log("workflow_UpdateLocalAdminPassword [item3]: Waiting... " +
                   elapsed + "ms elapsed (PID=" + pid + ").");
    }

    if (exitCode == null) {
        throw new Error("Script timed out after " + MAX_WAIT_MS + "ms. PID=" + pid +
                        " VM=" + vm.name);
    }
    if (exitCode !== 0) {
        throw new Error("Script exited with code " + exitCode + " on VM " + vm.name +
                        " (username '" + guestUsername + "').");
    }

    // --- Cleanup: password has changed, so prefer newAuth; fall back to original ---
    try {
        try {
            fileManager.deleteFileInGuest(vm, newAuth, scriptPath);
        } catch (delErr) {
            fileManager.deleteFileInGuest(vm, originalAuth, scriptPath);
        }
        System.log("workflow_UpdateLocalAdminPassword [item3]: Temp script removed from guest.");
    } catch (cleanupErr) {
        System.warn("workflow_UpdateLocalAdminPassword [item3]: Script cleanup warning: " +
                    cleanupErr.message);   // non-fatal
    }

    executionResult = "SUCCESS: Password updated for '" + guestUsername + "' on VM " + vm.name;
    System.log(executionResult);

} catch (e) {
    System.error("workflow_UpdateLocalAdminPassword [item3] FAILED: " + e.message);
    throw e;
}