/* ============================================================================
 * WORKFLOW: Configure CD Drive Letter   (workflow_SetCdromDriveLetter_Windows)
 * MODULE:   com.broadcom.pso.vcfa.vm.guestScripting
 * WF ID:    36328d1b-186d-460c-ad00-d667323d3384
 *
 * Child workflow. Sets the guest CD-ROM drive letter (default Y:) via VMware
 * Tools. Reuses actions utf8ByteLength + uploadGuestScript. Idempotent.
 *
 * Runs BEFORE the rename, so it authenticates with the bootstrap
 * guestUsername / guestPassword.
 *
 * CANVAS FLOW (root = item1):
 *   item1 (Prepare Guest Ops) -> item2 (Set CD-Rom Drive Letter) -> item0 (End)
 *
 * INPUTS:  vm {VC:VirtualMachine}, guestUsername {string},
 *          guestPassword {SecureString}, cdDriveLetter {string}
 * OUTPUT:  executionResult {string}
 * ATTRIBUTES:
 *   guestAuth      {Any}
 *   processManager {VC:GuestProcessManager}
 *   fileManager    {VC:GuestFileManager}
 *   MAX_WAIT_MS    {number} = 60000
 *   POLL_MS        {number} = 2000
 * ==========================================================================*/


/* ============================================================================
 * item1 — Prepare Guest Ops   (Scriptable Task   [ROOT])
 * IN:  vm, guestPassword, guestUsername
 * OUT: guestAuth, processManager, fileManager
 * NEXT: item2
 * ==========================================================================*/
if (!vm)            throw new Error("Input 'vm' is required.");
if (!guestUsername) throw new Error("Input 'guestUsername' is required.");
if (!guestPassword) throw new Error("Input 'guestPassword' is required.");

guestAuth = new VcNamePasswordAuthentication();
guestAuth.username = guestUsername;
guestAuth.password = guestPassword;
guestAuth.interactiveSession = false;

var guestOps   = vm.sdkConnection.guestOperationsManager;
processManager = guestOps.processManager;
fileManager    = guestOps.fileManager;

System.log("workflow_SetCdromDriveLetter_Windows: VM = " + vm.name);


/* ============================================================================
 * item2 — Set CD-Rom Drive Letter   (Scriptable Task)
 * IN:  cdDriveLetter, fileManager, guestAuth, MAX_WAIT_MS, POLL_MS, vm, processManager
 * OUT: executionResult
 * NEXT: item0
 * ==========================================================================*/
if (!cdDriveLetter) throw new Error("Input 'cdDriveLetter' is required.");
var cdLetter = cdDriveLetter.replace(":", "").trim().toUpperCase();
if (cdLetter.length !== 1 || !/[D-Z]/.test(cdLetter)) {
    throw new Error("Invalid cdDriveLetter '" + cdDriveLetter + "'. Must be a single letter D-Z.");
}

var psCdrom = [
    "$ErrorActionPreference = 'Stop'",
    "$cdLetter = '" + cdLetter + "'",
    "$cd = Get-WmiObject -Class Win32_Volume -Filter \"DriveType = 5\"",
    "if (-not $cd) { Write-Output 'INFO: No CD-ROM volume present. Skipping.'; exit 0 }",
    "if ($cd -is [array]) { $cd = $cd[0] }",
    "if ($cd.DriveLetter -eq \"${cdLetter}:\") { Write-Output \"INFO: CD-ROM already ${cdLetter}:.\"; exit 0 }",
    "$conflict = Get-WmiObject -Class Win32_Volume -Filter \"DriveLetter = '${cdLetter}:'\"",
    "if ($conflict) { Write-Error \"${cdLetter}: is already in use by another volume.\"; exit 1 }",
    "$cd.DriveLetter = \"${cdLetter}:\"",
    "$cd.Put() | Out-Null",
    "$check = Get-WmiObject -Class Win32_Volume -Filter \"DriveType = 5\"",
    "if ($check -is [array]) { $check = $check[0] }",
    "if ($check.DriveLetter -ne \"${cdLetter}:\") { Write-Error \"CD-ROM did not move to ${cdLetter}:.\"; exit 2 }",
    "Write-Output \"SUCCESS: CD-ROM set to ${cdLetter}:\"",
    "exit 0"
].join("\r\n");

var mod       = System.getModule("com.broadcom.pso.vcfa.vm.guestScripting");
var curScriptPath = "C:\\Windows\\Temp\\vcf_set_cdrom_" + cdLetter + ".ps1";

var winFileAttr = new VcGuestWindowsFileAttributes();
var byteLen     = mod.utf8ByteLength(psCdrom);
var transferUrl = fileManager.initiateFileTransferToGuest(vm, guestAuth, curScriptPath, winFileAttr, byteLen, true);
mod.uploadGuestScript(vm, transferUrl, psCdrom, "CDROM-" + cdLetter);

var progSpec              = new VcGuestProgramSpec();
progSpec.programPath      = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
progSpec.arguments        = "-NonInteractive -ExecutionPolicy Bypass -File \"" + curScriptPath + "\"";
progSpec.workingDirectory = "C:\\Windows\\Temp";

var pid = processManager.startProgramInGuest(vm, guestAuth, progSpec);
System.log("CD-ROM relabel to " + cdLetter + ": started on " + vm.name + ". PID: " + pid);

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

if (exitCode === null) throw new Error("Set CD-ROM " + cdLetter + ": timed out after " + MAX_WAIT_MS + "ms. PID: " + pid);
if (exitCode !== 0)    throw new Error("Set CD-ROM " + cdLetter + ": failed on " + vm.name + ", exit code " + exitCode);

executionResult = "SUCCESS: CD-ROM set to " + cdLetter + ": on " + vm.name;
System.log(executionResult);

