/**
 * Workflow: workflow_RenameLocalAdmin
 * Module: com.vcf.guestcustomization
 *
 * Canvas elements:
 *   1. Scriptable Task: validateInputs
 *   2. Decision:        isWindows
 *   3a. Scriptable Task: skipNonWindows      (FALSE branch → End)
 *   3b. Scriptable Task: uploadAndExecuteScript (TRUE branch)
 *   4. Scriptable Task: pollForCompletion
 *
 * Inputs:  vm, osType, guestUsername, guestPassword, newAdminName
 * Outputs: executionResult {string}
 */

// =========================================================================
// [CANVAS ELEMENT 1 — Scriptable Task: validateInputs]
// Inputs:  vm, osType, guestUsername, guestPassword, newAdminName
// Outputs: osTypeLower {string}
// =========================================================================

if (!vm)            throw new Error("Input 'vm' is required.");
if (!osType)        throw new Error("Input 'osType' is required.");
if (!guestUsername) throw new Error("Input 'guestUsername' is required.");
if (!guestPassword) throw new Error("Input 'guestPassword' is required.");
if (!newAdminName)  throw new Error("Input 'newAdminName' is required.");

osTypeLower = osType.toLowerCase().trim();

System.log("workflow_RenameLocalAdmin: VM=" + vm.name + " OS=" + osTypeLower + " NewName=" + newAdminName);

// =========================================================================
// [CANVAS ELEMENT 2 — Decision: isWindows]
// Condition: osTypeLower === "windows"
//   TRUE  → uploadAndExecuteScript
//   FALSE → skipNonWindows
// =========================================================================

// =========================================================================
// [CANVAS ELEMENT 3a — Scriptable Task: skipNonWindows]  (FALSE branch)
// Inputs:  osTypeLower {string}
// Outputs: executionResult {string}
// =========================================================================

executionResult = "SKIPPED: workflow_RenameLocalAdmin does not run on OS type '" + osTypeLower + "'.";
System.log(executionResult);

// =========================================================================
// [CANVAS ELEMENT 3b — Scriptable Task: uploadAndExecuteScript]  (TRUE branch)
// Inputs:  vm, guestUsername, guestPassword, newAdminName
// Outputs: pid {number}
// =========================================================================

if (!/^[a-zA-Z0-9_\-\.]{1,20}$/.test(newAdminName)) {
    throw new Error(
        "Input 'newAdminName' contains invalid characters or exceeds 20 characters. " +
        "Received: '" + newAdminName + "'"
    );
}

var guestAuth      = new VcNamePasswordAuthentication();
guestAuth.username = guestUsername;
guestAuth.password = guestPassword;

var serviceInstance = VcPlugin.getAllSdkConnections()[0].serviceInstance;
var guestOps        = serviceInstance.content.guestOperationsManager;
var fileManager     = guestOps.fileManager;

var scriptPath    = "C:\\Windows\\Temp\\vcf_rename_admin.ps1";
var scriptContent = [
    "$ErrorActionPreference = 'Stop'",
    "$newName = '" + newAdminName.replace(/'/g, "") + "'",
    "$adminAccount = Get-LocalUser | Where-Object { $_.SID.Value -match '-500$' }",
    "if (-not $adminAccount) { Write-Error 'Built-in Administrator account (SID -500) not found.'; exit 1 }",
    "if ($adminAccount.Name -eq $newName) {",
    "    Write-Output \"INFO: Already named '$newName'. No change required.\"",
    "    exit 0",
    "}",
    "Rename-LocalUser -Name $adminAccount.Name -NewName $newName",
    "Write-Output \"SUCCESS: Renamed '$($adminAccount.Name)' to '$newName'\"",
    "exit 0"
].join("\r\n");

var winFileAttr = new VcGuestWindowsFileAttributes();
var transferUrl = fileManager.initiateFileTransferToGuest(
    vm, guestAuth, scriptPath, winFileAttr, scriptContent.length, true
);

var baseUrl       = transferUrl.substring(0, transferUrl.indexOf("/", 8));
var uploadHost    = RESTHostManager.createHost("upload-RenameAdmin-" + vm.name);
var transientHost = RESTHostManager.createTransientHostFrom(uploadHost);
RESTHostManager.reloadConfiguration();
transientHost.url              = baseUrl;
transientHost.hostVerification = false;

try {
    var req = transientHost.createRequest("PUT", transferUrl, "application/octet-stream");
    req.setContent(scriptContent);
    var resp = req.execute();
    if (resp.statusCode !== 200) {
        throw new Error("Script upload failed. HTTP " + resp.statusCode + ": " + resp.contentAsString);
    }
    System.log("workflow_RenameLocalAdmin: Script uploaded.");
} finally {
    try {
        RESTHostManager.removeHost(transientHost);
    } catch (err) {
        System.warn("Upload host cleanup: " + err.message);
    }
}

var progSpec              = new VcGuestProgramSpec();
progSpec.programPath      = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
progSpec.arguments        = "-NonInteractive -ExecutionPolicy Bypass -File \"" + scriptPath + "\"";
progSpec.workingDirectory = "C:\\Windows\\Temp";

pid = serviceInstance.content.guestOperationsManager.processManager.startProgram(vm, guestAuth, progSpec);
System.log("workflow_RenameLocalAdmin: Script started. PID: " + pid);

// =========================================================================
// [CANVAS ELEMENT 4 — Scriptable Task: pollForCompletion]
// Inputs:  vm, guestUsername, guestPassword, pid {number}
// Outputs: executionResult {string}
// =========================================================================

var MAX_WAIT_MS = 60000;
var POLL_MS     = 5000;

var guestAuth2      = new VcNamePasswordAuthentication();
guestAuth2.username = guestUsername;
guestAuth2.password = guestPassword;

var si2            = VcPlugin.getAllSdkConnections()[0].serviceInstance;
var processManager = si2.content.guestOperationsManager.processManager;
var fileManager2   = si2.content.guestOperationsManager.fileManager;

var elapsed  = 0;
var exitCode = null;

while (elapsed < MAX_WAIT_MS) {
    System.sleep(POLL_MS);
    elapsed += POLL_MS;

    var pids     = new java.util.ArrayList();
    pids.add(pid);
    var procInfo = processManager.listProcessesInGuest(vm, guestAuth2, pids);

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

try {
    fileManager2.deleteFileInGuest(vm, guestAuth2, scriptPath);
    System.log("workflow_RenameLocalAdmin: Temp script removed from guest.");
} catch (cleanupErr) {
    System.warn("workflow_RenameLocalAdmin: Script cleanup warning: " + cleanupErr.message);
}

executionResult = "SUCCESS: Local admin account renamed to '" + newAdminName + "' on VM: " + vm.name;
System.log(executionResult);