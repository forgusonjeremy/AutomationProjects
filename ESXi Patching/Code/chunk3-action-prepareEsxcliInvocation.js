// ===================================================================
// ACTION:    prepareEsxcliInvocation
// MODULE:    com.broadcom.pso.vc.esxi.remediation.staging
// PURPOSE:   Compose the exact `esxcli software vib install` command
//            line for the per-host install phase. Centralizes the
//            command construction so all hosts get the same flags
//            and so the command is testable independently.
//
// PHASE:     STAGING / EXECUTE (per host, just before PATCH_INSTALL)
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-STAGING]
//
// INPUTS:
//   absolutePath              (string)  — On-host depot path from
//                                          resolveDepotFilePath.
//   noLiveInstall             (boolean) — When true, adds
//                                          --no-live-install to force
//                                          a deferred (post-reboot)
//                                          install. KB 000345284
//                                          requires this for major
//                                          ESXi update bundles.
//                                          Default: true.
//   maintenanceModeRequired   (boolean) — When true, adds
//                                          --maintenance-mode flag
//                                          (which esxcli respects
//                                          for safety even though
//                                          we have separate MM
//                                          control). Default: true.
//   dryRun                    (boolean) — When true, adds --dry-run
//                                          flag. esxcli will list
//                                          which VIBs would be
//                                          installed/updated/
//                                          removed without making
//                                          changes. Used for the
//                                          PATCH_LIST phase.
//
// RETURNS: Properties — {
//            commandLine     (string)
//            timeoutSeconds  (number)  — recommended SSH timeout
//                                         for this command:
//                                          dryRun ? 60 : 1800
//                                         (30 minutes for a real
//                                         install, 60s for a list).
//          }
//
// REQUIREMENT TRACE:
//   Implements: FR-19 (KB step 5: list, step 6: install).
//
// NOTES:
//   - The action does NOT run the command. It returns the string
//     that the host workflow's PATCH_LIST and PATCH_INSTALL phases
//     will pass to executeAndCheck via the SSH session.
//   - --no-live-install: VxRail major patches almost always require
//     this; the patch is staged to bootbank and applied on reboot.
//     For minor security-only VIBs, live install may be possible —
//     but per AD-01 and EX-03, this workflow is for full update
//     bundles, not single VIBs.
//   - --maintenance-mode: passed for double-safety. Even though
//     the workflow puts the host in MM via vCenter before invoking
//     esxcli, this flag tells esxcli to refuse if MM is somehow
//     not active. Cheap defense in depth.
//   - --dry-run: passed only when the caller is doing the
//     PATCH_LIST phase. The output lists VIBs that would be
//     installed and exits 0; we then re-invoke without --dry-run
//     for the actual install.
//   - Command quoting: absolutePath is double-quoted to handle
//     datastore names with spaces.
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-STAGING]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

if (arguments.length < 4) {
    throw new Error(
        "prepareEsxcliInvocation requires 4 inputs: " +
        "(absolutePath, noLiveInstall, maintenanceModeRequired, dryRun)."
    );
}
var absolutePath            = arguments[0];
var noLiveInstall           = arguments[1];
var maintenanceModeRequired = arguments[2];
var dryRun                  = arguments[3];

if (typeof absolutePath !== "string" || absolutePath.length === 0) {
    throw new Error("prepareEsxcliInvocation: 'absolutePath' must be non-empty.");
}
if (typeof noLiveInstall !== "boolean") noLiveInstall = true;
if (typeof maintenanceModeRequired !== "boolean") maintenanceModeRequired = true;
if (typeof dryRun !== "boolean") dryRun = false;

// -------------------------------------------------------------------
// Compose command. Base form:
//   esxcli software vib install -d "<path>" [flags]
// -------------------------------------------------------------------

var parts = [];
parts.push("esxcli");
parts.push("software");
parts.push("vib");
parts.push("install");
parts.push("-d");
parts.push('"' + absolutePath + '"');

if (noLiveInstall) {
    parts.push("--no-live-install");
}
if (maintenanceModeRequired) {
    parts.push("--maintenance-mode");
}
if (dryRun) {
    parts.push("--dry-run");
}

var commandLine = parts.join(" ");

// 30-minute timeout for a real install (large depots can take a
// while on slower NFS); 60-second timeout for dry-run / list.
var timeoutSeconds = dryRun ? 60 : 1800;

var result = new Properties();
result.put("commandLine", commandLine);
result.put("timeoutSeconds", timeoutSeconds);

auditLogger.auditLog(
    LOG_PREFIX, "EXECUTE", "OK",
    "Prepared esxcli command | dryRun=" + dryRun +
    " | timeoutSec=" + timeoutSeconds +
    " | cmd=" + commandLine
);

return result;
