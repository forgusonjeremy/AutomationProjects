/* ============================================================================
 * Workflow: Change Local Account Password   (workflow_UpdateLocalAdminPassword)
 * Module:   com.vcf.guestcustomization
 * WF ID:    c20a1766-1780-4fe2-a4e6-d553fc4bd1b4
 *
 * Purpose:
 *   Updates the local administrator password on Windows via VMware Tools
 *   (initiateFileTransferToGuest + startProgramInGuest). Called after
 *   workflow_RenameLocalAdmin so guestUsername is the post-rename account.
 *
 * Invocation:
 *   Synchronous nested workflow from the parent "Customize Windows VM Guest".
 *
 * Prerequisites:
 *   - VMware Tools installed and running on guest
 *   - vCenter credentials with Guest Operations privilege
 *   - vRO truststore contains the SSL cert of every ESXi host in the cluster
 *     (initiateFileTransferToGuest returns an ESXi-hosted PUT URL)
 *   - guestUsername = CURRENT (post-rename) account name
 *   - guestPassword = CURRENT password
 *
 * CANVAS FLOW (root = item1):
 *   item1 (Validate Inputs) -> item4 (Prepare Guest Ops)
 *     -> item2 (Upload and Execute Script) -> item3 (Poll for Completion) -> item0 (End)
 *
 * WORKFLOW INPUTS:
 *   vm            {VC:VirtualMachine}
 *   guestUsername {string}            current (post-rename) account
 *   guestPassword {SecureString}      current password
 *   newPassword   {SecureString}      target password (valid post-commit)
 *
 * WORKFLOW OUTPUT:
 *   executionResult {string}
 *
 * WORKFLOW ATTRIBUTES:
 *   pid            {number}
 *   scriptPath     {string}
 *   MAX_WAIT_MS    {number} = 60000
 *   POLL_MS        {number} = 5000
 *   fileManager    {VC:GuestFileManager}
 *   processManager {VC:GuestProcessManager}
 *   guestAuth      {Any}
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
 * ==========================================================================*/


/* ============================================================================
 * item1 — Validate Inputs   (Scriptable Task   [ROOT])
 * IN:  guestPassword, guestUsername, newPassword, vm
 * NEXT: item4
 * ==========================================================================*/
if (!vm){
    throw new Error("Input 'vm' is required.");
}      

if (newPassword === null || newPassword === undefined){
    throw new Error("Input 'newPassword' is required.");
}

if (!guestUsername){
    throw new Error("Input 'guestUsername' is required.");
}

if (!guestPassword){
    throw new Error("Input 'guestPassword' is required.");
} 

System.log("workflow_UpdateLocalAdminPassword [item1]: VM=" + vm.name);


/* ============================================================================
 * item4 — Prepare Guest Ops   (Scriptable Task)
 * IN:  vm, guestPassword, guestUsername
 * OUT: fileManager, processManager, guestAuth
 * NEXT: item2
 * ==========================================================================*/
guestAuth      = new VcNamePasswordAuthentication();
guestAuth.username = guestUsername;
guestAuth.password = guestPassword;
guestAuth.interactiveSession = false;   // REQUIRED

var guestOps       = vm.sdkConnection.guestOperationsManager;
var fileManager    = guestOps.fileManager;
var processManager = guestOps.processManager;


/* ============================================================================
 * item2 — Upload and Execute Script   (Scriptable Task)
 * IN:  newPassword, vm, guestAuth, fileManager, processManager, guestUsername
 * OUT: pid, scriptPath
 * NEXT: item3
 * ==========================================================================*/
try {
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

    var mod = System.getModule("com.broadcom.pso.vcfa.vm.guestScripting");
    var winFileAttr = new VcGuestWindowsFileAttributes();
    var byteLen     = mod.utf8ByteLength(scriptContent);
    var transferUrl = fileManager.initiateFileTransferToGuest(
        vm, guestAuth, scriptPath, winFileAttr, byteLen, true
    );
    mod.uploadGuestScript(vm, transferUrl, scriptContent, "UpdatePwd-Windows");

    var progSpec              = new VcGuestProgramSpec();
    progSpec.programPath      = programPath;
    progSpec.arguments        = programArgs;
    progSpec.workingDirectory = "C:\\Windows\\Temp";

    pid = processManager.startProgramInGuest(vm, guestAuth, progSpec);
    System.log("workflow_UpdateLocalAdminPassword [item2a]: Script started. PID=" + pid +
               " Path=" + scriptPath);

} catch (e) {
    System.error("workflow_UpdateLocalAdminPassword [item2a] FAILED: " + e.message);
    throw e;
}


/* ============================================================================
 * item3 — Poll for Completion   (Scriptable Task)
 * IN:  guestPassword, guestUsername, newPassword, pid, scriptPath, vm, POLL_MS, processManager, fileManager, MAX_WAIT_MS
 * OUT: executionResult
 * NEXT: item0
 * ==========================================================================*/
try {

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

