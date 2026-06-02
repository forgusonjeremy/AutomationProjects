/**
 * Workflow: workflow_UpdateLocalAdminPassword
 * Module:   com.vcf.guestcustomization
 *
 * Purpose:
 *   Updates the local administrator/root password on Windows or Linux via
 *   VMware Tools (RunProgramInGuest / startProgram). Called after
 *   workflow_RenameLocalAdmin so guestUsername is the post-rename account.
 *
 * Invocation:
 *   Synchronous nested workflow from workflow_VMDeployParent.
 *
 * Prerequisites:
 *   - VMware Tools installed and running on guest
 *   - vCenter credentials with Guest Operations privilege
 *   - vRO truststore contains the SSL cert of every ESXi host in the cluster
 *     (initiateFileTransferToGuest returns an ESXi-hosted PUT URL)
 *   - guestUsername = CURRENT (post-rename) account name
 *   - guestPassword = CURRENT password (may be blank post-sysprep)
 *
 * Canvas layout:
 *   item1   "isWindows"                 (Custom Decision -> Boolean)
 *               true  -> item2a, false -> item2b
 *   item2a  "Upload and Execute (Windows)"  (Scriptable Task)
 *   item2b  "Upload and Execute (Linux)"    (Scriptable Task)
 *               both -> item3
 *   item3   "Poll for Completion"            (Scriptable Task)
 *
 * Security:
 *   - newPassword injected into the guest script at runtime, never logged.
 *   - Script deleted from guest immediately after execution.
 *
 * CRITICAL credential behaviour:
 *   The guest script changes the account password. The instant it commits,
 *   the original credentials (guestPassword) become invalid. Any poll cycle
 *   running after the change must use newPassword. item3 tries originalAuth
 *   first, then falls back to newAuth.
 */


// =============================================================================
// CANVAS ELEMENT: item1 — "isWindows"  (Custom Decision -> Boolean)
// -----------------------------------------------------------------------------
// IN : vm     {VC:VirtualMachine}, vcenter {VC:SdkConnection}, osType {string}
// OUT: decisionResult {boolean}    true => item2a (Windows), false => item2b (Linux)
//
// Single point of input validation and OS routing. A custom decision returns a
// Boolean via `return`; the "true" connector wires to item2a, "false" to item2b.
// =============================================================================
if (!vm)      throw new Error("Input 'vm' is required.");
if (!vcenter) throw new Error("Input 'vcenter' is required.");
if (!osType)  throw new Error("Input 'osType' is required. Expected 'windows' or 'linux'.");
if (newPassword === null || newPassword === undefined)
              throw new Error("Input 'newPassword' is required.");
if (!guestUsername) throw new Error("Input 'guestUsername' is required.");

var osTypeLower = osType.toLowerCase().trim();
if (osTypeLower !== "windows" && osTypeLower !== "linux") {
    throw new Error("Input 'osType' must be 'windows' or 'linux'. Received: '" + osType + "'");
}

System.log("workflow_UpdateLocalAdminPassword [item1]: VM=" + vm.name +
           " OS=" + osTypeLower + " Username=" + guestUsername); // password not logged

return (osTypeLower === "windows");


// =============================================================================
// CANVAS ELEMENT: item2a — "Upload and Execute (Windows)"  (Scriptable Task)
// -----------------------------------------------------------------------------
// IN : vm            {VC:VirtualMachine}
//      vcenter       {VC:SdkConnection}
//      guestUsername {string}
//      guestPassword {SecureString}     current password
//      newPassword   {SecureString}     target password
// OUT: scriptPath    {string}
//      pid           {number}
// =============================================================================
try {
    var guestAuth      = new VcNamePasswordAuthentication();
    guestAuth.username = guestUsername;
    guestAuth.password = guestPassword;
    guestAuth.interactiveSession = false;   // REQUIRED

    var guestOps       = vcenter.guestOperationsManager;
    var fileManager    = guestOps.fileManager;
    var processManager = guestOps.processManager;

    scriptPath      = "C:\\Windows\\Temp\\vcf_setpwd.ps1";
    var programPath = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    var programArgs = "-NonInteractive -ExecutionPolicy Bypass -File \"" + scriptPath + "\"";

    var winUser = guestUsername.replace(/'/g, "");
    var winPwd  = String(newPassword).replace(/'/g, "''");   // PS single-quote escape

    var scriptContent = [
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
    var transferUrl = fileManager.initiateFileTransferToGuest(
        vm, guestAuth, scriptPath, winFileAttr, scriptContent.length, true
    );
    _uploadScript(vm, transferUrl, scriptContent, "UpdatePwd-Windows");

    var progSpec              = new VcGuestProgramSpec();
    progSpec.programPath      = programPath;
    progSpec.arguments        = programArgs;
    progSpec.workingDirectory = "C:\\Windows\\Temp";

    pid = processManager.startProgram(vm, guestAuth, progSpec);
    System.log("workflow_UpdateLocalAdminPassword [item2a]: Script started. PID=" + pid +
               " Path=" + scriptPath);

} catch (e) {
    System.error("workflow_UpdateLocalAdminPassword [item2a] FAILED: " + e.message);
    throw e;
}

// --- Helper scoped to item2a ---
function _uploadScript(vm, transferUrl, content, tag) {
    var baseUrl       = transferUrl.substring(0, transferUrl.indexOf("/", 8));
    var uploadHost    = RESTHostManager.createHost("upload-" + tag + "-" + vm.name);
    var transientHost = RESTHostManager.createTransientHostFrom(uploadHost);

    transientHost.url              = baseUrl;          // set BEFORE reload
    transientHost.hostVerification = false;
    RESTHostManager.reloadConfiguration();

    try {
        var req = transientHost.createRequest("PUT", transferUrl, content); // body = 3rd arg
        req.contentType = "application/octet-stream";
        var resp = req.execute();
        if (resp.statusCode !== 200) {
            throw new Error("Script upload failed [" + tag + "]. HTTP " +
                resp.statusCode + ": " + resp.contentAsString);
        }
        System.log("workflow_UpdateLocalAdminPassword [item2a]: Script uploaded [" + tag + "].");
    } finally {
        if (transientHost) {
            try { RESTHostManager.removeHost(transientHost); }
            catch (e1) { System.warn("[item2a] transient host cleanup [" + tag + "]: " + e1.message); }
        }
        try { RESTHostManager.removeHost(uploadHost); }
        catch (e2) { System.warn("[item2a] base host cleanup [" + tag + "]: " + e2.message); }
    }
}


// =============================================================================
// CANVAS ELEMENT: item2b — "Upload and Execute (Linux)"  (Scriptable Task)
// -----------------------------------------------------------------------------
// IN : vm            {VC:VirtualMachine}
//      vcenter       {VC:SdkConnection}
//      guestUsername {string}
//      guestPassword {SecureString}     current password
//      newPassword   {SecureString}     target password
// OUT: scriptPath    {string}
//      pid           {number}
// =============================================================================
try {
    var guestAuth      = new VcNamePasswordAuthentication();
    guestAuth.username = guestUsername;
    guestAuth.password = guestPassword;
    guestAuth.interactiveSession = false;   // REQUIRED

    var guestOps       = vcenter.guestOperationsManager;
    var fileManager    = guestOps.fileManager;
    var processManager = guestOps.processManager;

    scriptPath      = "/tmp/vcf_setpwd.sh";
    var programPath = "/bin/bash";
    var programArgs = scriptPath;

    var nixUser = guestUsername.replace(/'/g, "");
    // Escape backslashes then single quotes for safe embedding in single-quoted bash
    var nixPwd  = String(newPassword).replace(/\\/g, "\\\\").replace(/'/g, "'\\''");

    var scriptContent = [
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
    var transferUrl = fileManager.initiateFileTransferToGuest(
        vm, guestAuth, scriptPath, nixFileAttr, scriptContent.length, true
    );
    _uploadScript(vm, transferUrl, scriptContent, "UpdatePwd-Linux");

    var progSpec              = new VcGuestProgramSpec();
    progSpec.programPath      = programPath;
    progSpec.arguments        = programArgs;
    progSpec.workingDirectory = "/tmp";

    pid = processManager.startProgram(vm, guestAuth, progSpec);
    System.log("workflow_UpdateLocalAdminPassword [item2b]: Script started. PID=" + pid +
               " Path=" + scriptPath);

} catch (e) {
    System.error("workflow_UpdateLocalAdminPassword [item2b] FAILED: " + e.message);
    throw e;
}

// --- Helper scoped to item2b ---
function _uploadScript(vm, transferUrl, content, tag) {
    var baseUrl       = transferUrl.substring(0, transferUrl.indexOf("/", 8));
    var uploadHost    = RESTHostManager.createHost("upload-" + tag + "-" + vm.name);
    var transientHost = RESTHostManager.createTransientHostFrom(uploadHost);

    transientHost.url              = baseUrl;          // set BEFORE reload
    transientHost.hostVerification = false;
    RESTHostManager.reloadConfiguration();

    try {
        var req = transientHost.createRequest("PUT", transferUrl, content); // body = 3rd arg
        req.contentType = "application/octet-stream";
        var resp = req.execute();
        if (resp.statusCode !== 200) {
            throw new Error("Script upload failed [" + tag + "]. HTTP " +
                resp.statusCode + ": " + resp.contentAsString);
        }
        System.log("workflow_UpdateLocalAdminPassword [item2b]: Script uploaded [" + tag + "].");
    } finally {
        if (transientHost) {
            try { RESTHostManager.removeHost(transientHost); }
            catch (e1) { System.warn("[item2b] transient host cleanup [" + tag + "]: " + e1.message); }
        }
        try { RESTHostManager.removeHost(uploadHost); }
        catch (e2) { System.warn("[item2b] base host cleanup [" + tag + "]: " + e2.message); }
    }
}


// =============================================================================
// CANVAS ELEMENT: item3a — "Poll for Completion (Windows)"  (Scriptable Task)
// -----------------------------------------------------------------------------
// Reached only from item2a (Windows branch).
// IN : vm            {VC:VirtualMachine}
//      vcenter       {VC:SdkConnection}
//      guestUsername {string}
//      guestPassword {SecureString}     original/current password
//      newPassword   {SecureString}     target password (valid post-commit)
//      scriptPath    {string}           from item2a (C:\Windows\Temp\vcf_setpwd.ps1)
//      pid           {number}           from item2a
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
        // (pids is long[] in the vSphere API; ArrayList/JS-array coercion fail.)
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
        System.log("workflow_UpdateLocalAdminPassword [item3a]: Waiting... " +
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
        System.log("workflow_UpdateLocalAdminPassword [item3a]: Temp script removed from guest.");
    } catch (cleanupErr) {
        System.warn("workflow_UpdateLocalAdminPassword [item3a]: Script cleanup warning: " +
                    cleanupErr.message);   // non-fatal
    }
 
    executionResult = "SUCCESS: Password updated for '" + guestUsername + "' on VM " + vm.name + " (Windows)";
    System.log(executionResult);
 
} catch (e) {
    System.error("workflow_UpdateLocalAdminPassword [item3a] FAILED: " + e.message);
    throw e;
}
 
 
// =============================================================================
// CANVAS ELEMENT: item3b — "Poll for Completion (Linux)"  (Scriptable Task)
// -----------------------------------------------------------------------------
// Reached only from item2b (Linux branch).
// IN : vm            {VC:VirtualMachine}
//      vcenter       {VC:SdkConnection}
//      guestUsername {string}
//      guestPassword {SecureString}     original/current password
//      newPassword   {SecureString}     target password (valid post-commit)
//      scriptPath    {string}           from item2b (/tmp/vcf_setpwd.sh)
//      pid           {number}           from item2b
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
        // (pids is long[] in the vSphere API; ArrayList/JS-array coercion fail.)
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
        System.log("workflow_UpdateLocalAdminPassword [item3b]: Waiting... " +
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
        System.log("workflow_UpdateLocalAdminPassword [item3b]: Temp script removed from guest.");
    } catch (cleanupErr) {
        System.warn("workflow_UpdateLocalAdminPassword [item3b]: Script cleanup warning: " +
                    cleanupErr.message);   // non-fatal
    }
 
    executionResult = "SUCCESS: Password updated for '" + guestUsername + "' on VM " + vm.name + " (Linux)";
    System.log(executionResult);
 
} catch (e) {
    System.error("workflow_UpdateLocalAdminPassword [item3b] FAILED: " + e.message);
    throw e;
}