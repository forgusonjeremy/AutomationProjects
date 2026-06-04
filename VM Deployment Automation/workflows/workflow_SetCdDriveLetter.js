/* ============================================================================
 * WORKFLOW: workflow_SetCdromDriveLetter_Windows
 * MODULE:   com.broadcom.pso.vcfa.vm.guestScripting
 *
 * Child workflow. Sets the guest CD-ROM drive letter to Y: via VMware Tools.
 * Reuses actions utf8ByteLength + uploadGuestScript. Idempotent.
 *
 * INPUTS:  vm {VC:VirtualMachine}, guestUsername {string}, guestPassword {SecureString}
 * OUTPUT:  executionResult {string}
 * ATTRIBUTES:
 *   guestAuth      {Any}
 *   processManager {VC:GuestProcessManager}
 *   fileManager    {VC:GuestFileManager}
 *   MAX_WAIT_MS    {number} = 60000
 *   POLL_MS        {number} = 2000
 *   pid            {number}
 *   curScriptPath  {string}
 *
 * CANVAS FLOW: Start -> E1 -> E2 -> End
 * ==========================================================================*/


/* ============================================================================
 * E1 — Prepare Guest Ops   (Scriptable Task)
 * IN:  vm, guestUsername, guestPassword
 * OUT: guestAuth, processManager, fileManager
 * ==========================================================================*/
if (!vm)            throw new Error("Input 'vm' is required.");
if (!guestUsername) throw new Error("Input 'guestUsername' is required.");
if (!guestPassword) throw new Error("Input 'guestPassword' is required.");

guestAuth          = new VcNamePasswordAuthentication();
guestAuth.username = guestUsername;
guestAuth.password = guestPassword;
guestAuth.interactiveSession = false;

var guestOps   = vm.sdkConnection.guestOperationsManager;
processManager = guestOps.processManager;
fileManager    = guestOps.fileManager;

System.log("workflow_SetCdromDriveLetter_Windows: VM = " + vm.name);


/* ============================================================================
 * E2 — Set CD-ROM to Y:   (Scriptable Task)
 * IN:  vm, guestAuth, processManager, fileManager, MAX_WAIT_MS, POLL_MS
 * OUT: pid, curScriptPath, executionResult
 * ==========================================================================*/
var psCdrom = [
    "$ErrorActionPreference = 'Stop'",
    "$cd = Get-WmiObject -Class Win32_Volume -Filter \"DriveType = 5\"",
    "if (-not $cd) { Write-Output 'INFO: No CD-ROM volume present. Skipping.'; exit 0 }",
    "if ($cd -is [array]) { $cd = $cd[0] }",
    "if ($cd.DriveLetter -eq 'Y:') { Write-Output 'INFO: CD-ROM already Y:.'; exit 0 }",
    "$conflict = Get-WmiObject -Class Win32_Volume -Filter \"DriveLetter = 'Y:'\"",
    "if ($conflict) { Write-Error 'Y: is already in use by another volume.'; exit 1 }",
    "$cd.DriveLetter = 'Y:'",
    "$cd.Put() | Out-Null",
    "$check = Get-WmiObject -Class Win32_Volume -Filter \"DriveType = 5\"",
    "if ($check -is [array]) { $check = $check[0] }",
    "if ($check.DriveLetter -ne 'Y:') { Write-Error 'CD-ROM did not move to Y:.'; exit 2 }",
    "Write-Output 'SUCCESS: CD-ROM set to Y:'",
    "exit 0"
].join("\r\n");

var mod       = System.getModule("com.broadcom.pso.vcfa.vm.guestScripting");
curScriptPath = "C:\\Windows\\Temp\\vcf_set_cdrom_Y.ps1";

var winFileAttr = new VcGuestWindowsFileAttributes();
var byteLen     = mod.utf8ByteLength(psCdrom);
var transferUrl = fileManager.initiateFileTransferToGuest(vm, guestAuth, curScriptPath, winFileAttr, byteLen, true);
mod.uploadGuestScript(vm, transferUrl, psCdrom, "CDROM-Y");

var progSpec              = new VcGuestProgramSpec();
progSpec.programPath      = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
progSpec.arguments        = "-NonInteractive -ExecutionPolicy Bypass -File \"" + curScriptPath + "\"";
progSpec.workingDirectory = "C:\\Windows\\Temp";

pid = processManager.startProgramInGuest(vm, guestAuth, progSpec);
System.log("CD-ROM relabel started on " + vm.name + ". PID: " + pid);

var elapsed  = 0;
var exitCode = null;
while (elapsed < MAX_WAIT_MS) {
    System.sleep(POLL_MS);
    elapsed += POLL_MS;
    var procInfo = processManager.listProcessesInGuest(vm, guestAuth, [pid]);
    if (procInfo && procInfo.length > 0 && procInfo[0].exitCode !== null) {
        exitCode = procInfo[0].exitCode;
        break;
    }
    System.log("CD-ROM relabel: Waiting... " + elapsed + "ms elapsed.");
}

if (exitCode === null) throw new Error("Set CD-ROM Y: timed out after " + MAX_WAIT_MS + "ms. PID: " + pid);
if (exitCode !== 0)    throw new Error("Set CD-ROM Y: failed on " + vm.name + ", exit code " + exitCode);

executionResult = "SUCCESS: CD-ROM set to Y: on " + vm.name;
System.log(executionResult);