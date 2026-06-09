/**
 * Workflow: Rename Windows Local Admin   (workflow_RenameLocalAdmin)
 * Module:   com.vcf.guestcustomization
 * WF ID:    f0be1eb7-54c3-4be7-a41d-05de7854671d
 *
 * Renames the built-in Administrator account (SID -500) inside a Windows guest
 * via VMware Tools. The password is NOT changed here, so the renamed account
 * keeps the original password — that is the credential the password-change
 * child consumes next.
 *
 * CANVAS FLOW (root = item1):
 *   item1 (Validate Inputs) -> item4 (Prepare Guest Ops)
 *     -> item2 (Upload and Execute Script) -> item3 (Poll for Completion) -> item0 (End)
 *
 * WORKFLOW INPUTS:
 *   vm            {VC:VirtualMachine} - Target VM
 *   guestUsername {string}            - Current admin username
 *   guestPassword {SecureString}      - Current admin password
 *   newAdminName  {string}            - Target administrator account name
 *
 * WORKFLOW OUTPUT:
 *   executionResult {string}
 *
 * WORKFLOW ATTRIBUTES:
 *   pid            {number}
 *   scriptPath     {string}
 *   MAX_WAIT_MS    {number} = 60000
 *   POLL_MS        {number} = 5000
 *   guestAuth      {Any}
 *   fileManager    {VC:GuestFileManager}
 *   processManager {VC:GuestProcessManager}
 */


// =========================================================================
// item1 — Validate Inputs   (Scriptable Task)
// IN : vm, guestUsername, guestPassword, newAdminName
// NEXT: item4
// =========================================================================
if (!vm)            throw new Error("Input 'vm' is required.");
if (!guestUsername) throw new Error("Input 'guestUsername' is required.");
if (!guestPassword) throw new Error("Input 'guestPassword' is required.");
if (!newAdminName)  throw new Error("Input 'newAdminName' is required.");

System.log("workflow_RenameLocalAdmin: VM=" + vm.name + " NewName=" + newAdminName);


// =========================================================================
// item4 — Prepare Guest Ops   (Scriptable Task)
// IN : vm, guestPassword, guestUsername
// OUT: guestAuth {Any}, fileManager {VC:GuestFileManager}, processManager {VC:GuestProcessManager}
// NEXT: item2
//
// NOTE: managers resolved from vm.sdkConnection.guestOperationsManager.
// =========================================================================
guestAuth      = new VcNamePasswordAuthentication();
guestAuth.username = guestUsername;
guestAuth.password = guestPassword;
guestAuth.interactiveSession = false;

var guestOpsManager = vm.sdkConnection.guestOperationsManager;  // VcGuestOperationsManager
fileManager    = guestOpsManager.fileManager;                   // VcGuestFileManager
processManager = guestOpsManager.processManager;                // VcGuestProcessManager


// =========================================================================
// item2 — Upload and Execute Script   (Scriptable Task)
// IN : newAdminName, vm, processManager, fileManager, guestAuth
// OUT: pid {number}, scriptPath {string}
// NEXT: item3
// =========================================================================
if (!/^[a-zA-Z0-9_\-\.]{1,20}$/.test(newAdminName)) {
    throw new Error(
        "Input 'newAdminName' contains invalid characters or exceeds 20 characters. " +
        "Received: '" + newAdminName + "'"
    );
}

scriptPath = "C:\\Windows\\Temp\\vcf_rename_admin.ps1";

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

var mod = System.getModule("com.broadcom.pso.vcfa.vm.guestScripting");
var winFileAttr = new VcGuestWindowsFileAttributes();
var byteLen     = mod.utf8ByteLength(scriptContent);
var transferUrl = fileManager.initiateFileTransferToGuest(
    vm, guestAuth, scriptPath, winFileAttr, byteLen, true
);
mod.uploadGuestScript(vm, transferUrl, scriptContent, "RenameAdmin");

System.log("workflow_RenameLocalAdmin: Script uploaded.");

var progSpec              = new VcGuestProgramSpec();
progSpec.programPath      = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
progSpec.arguments        = "-NonInteractive -ExecutionPolicy Bypass -File \"" + scriptPath + "\"";
progSpec.workingDirectory = "C:\\Windows\\Temp";

pid = processManager.startProgramInGuest(vm, guestAuth, progSpec);
System.log("workflow_RenameLocalAdmin: Script started. PID: " + pid);


// =========================================================================
// item3 — Poll for Completion   (Scriptable Task)
// IN : newAdminName, pid, scriptPath, vm, POLL_MS, processManager,
//      fileManager, guestUsername, guestPassword, MAX_WAIT_MS
// OUT: executionResult {string}
// NEXT: item0 (End)
//
// Dual-credential poll: the account NAME changes mid-flight, so the original
// session credentials may stop authenticating once the rename commits. Try
// originalAuth (guestUsername) first, then renamedAuth (newAdminName); the
// password is unchanged by a rename. Poll with a null filter and match PID
// in JS.
// =========================================================================
var originalAuth      = new VcNamePasswordAuthentication();
originalAuth.username = guestUsername;
originalAuth.password = guestPassword;
originalAuth.interactiveSession = false;

var renamedAuth      = new VcNamePasswordAuthentication();
renamedAuth.username = newAdminName;
renamedAuth.password = guestPassword;        // password unchanged by the rename
renamedAuth.interactiveSession = false;

var elapsed  = 0;
var exitCode = null;

while (elapsed < MAX_WAIT_MS) {
    System.sleep(POLL_MS);
    elapsed += POLL_MS;

    var procInfo;
    try {
        procInfo = processManager.listProcessesInGuest(vm, originalAuth, null);
    } catch (e1) {
        try {
            procInfo = processManager.listProcessesInGuest(vm, renamedAuth, null);
        } catch (e2) {
            throw new Error("listProcessesInGuest failed with both credentials. Original: " + e1.message + " | Renamed: " + e2.message);
        }
    }

    if (procInfo && procInfo.length > 0) {
        for (var i = 0; i < procInfo.length; i++) {
            if (procInfo[i].pid == pid) {
                if (procInfo[i].exitCode !== null) { exitCode = procInfo[i].exitCode; }
                break;
            }
        }
    }

    if (exitCode !== null) { break; }
    System.log("workflow_RenameLocalAdmin: Waiting... " + elapsed + "ms elapsed.");
}

if (exitCode === null) {
    throw new Error("Script timed out after " + MAX_WAIT_MS + "ms. PID: " + pid);
}
if (exitCode !== 0) {
    throw new Error("Script exited with code " + exitCode + " on VM: " + vm.name);
}

try {
    fileManager.deleteFileInGuest(vm, renamedAuth, scriptPath);
    System.log("workflow_RenameLocalAdmin: Temp script removed from guest.");
} catch (cleanupErr) {
    System.warn("workflow_RenameLocalAdmin: Script cleanup warning: " + cleanupErr.message);
}

executionResult = "SUCCESS: Local admin account renamed to '" + newAdminName + "' on VM: " + vm.name;
System.log(executionResult);
