/**
 * Action: buildMoveLocalHostInvocation
 * Module:  broadcom.pso.vc.vm.guestOps.files.windows.logs
 *
 * Purpose:
 *   Builds the PowerShell invocation string for the move-archived-logs-ByHostList
 *   action in cvs_functions.ps1.  The PS host's own FQDN is passed as the single
 *   HostList entry so the script constructs the UNC source path itself:
 *     \\<pshostfqdn>\C$\Windows\System32\winevt\Logs
 *
 * Inputs:
 *   scriptPath      (string)                        - Full path to cvs_functions.ps1 on the PS host
 *   psHost          (PowerShell:PowerShellHost)     - PS host plugin object; FQDN derived from .name
 *   fileShareTarget (string)                        - UNC destination root, e.g. \\server\share$\Windows
 *
 * Return type: string
 *
 * Validation note:
 *   Confirm that psHost.name returns the FQDN (not a short name or display label) in your
 *   installed PS plugin version via the vRO scripting API browser before deploying.
 *   If the property differs, update the psHostFqdn assignment below.
 */

// ── Input validation ──────────────────────────────────────────────────────────

if (!scriptPath || scriptPath.trim() === "") {
    throw new Error("buildMoveLocalHostInvocation: scriptPath is required and must not be empty.");
}

if (!psHost) {
    throw new Error("buildMoveLocalHostInvocation: psHost is required.");
}

if (!fileShareTarget || fileShareTarget.trim() === "") {
    throw new Error("buildMoveLocalHostInvocation: fileShareTarget is required and must not be empty.");
}

// ── Derive PS host FQDN ───────────────────────────────────────────────────────
// VALIDATION REQUIRED: confirm psHost.name is the FQDN in your PS plugin version.
// Fallback candidates: psHost.hostName, psHost.host, psHost.displayName

var psHostFqdn = psHost.name;

if (!psHostFqdn || psHostFqdn.trim() === "") {
    throw new Error(
        "buildMoveLocalHostInvocation: Unable to derive FQDN from psHost.name. " +
        "Validate the correct property name in the vRO scripting API browser for PowerShell:PowerShellHost."
    );
}

System.log(
    "buildMoveLocalHostInvocation | scriptPath=" + scriptPath +
    " | psHostFqdn=" + psHostFqdn +
    " | fileShareTarget=" + fileShareTarget
);

// ── Build invocation string ───────────────────────────────────────────────────
// Produces:
//   & "C:\PSO\Scripts\cvs_functions.ps1" `
//       -Action 'move-archived-logs-ByHostList' `
//       -FileShareTarget '\\server\share$\Windows' `
//       -HostList 'pshostfqdn.corp.local'

var invocationString =
    "& \"" + scriptPath.trim() + "\"" +
    " -Action 'move-archived-logs-ByHostList'" +
    " -FileShareTarget '" + fileShareTarget.trim() + "'" +
    " -HostList '" + psHostFqdn.trim() + "'";

System.log("buildMoveLocalHostInvocation | invocationString=" + invocationString);

return invocationString;
