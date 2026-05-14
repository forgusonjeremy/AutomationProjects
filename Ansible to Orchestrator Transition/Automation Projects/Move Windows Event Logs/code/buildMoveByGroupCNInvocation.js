/**
 * Action: buildMoveByGroupCNInvocation
 * Module:  broadcom.pso.vc.vm.guestOps.files.windows.logs
 *
 * Purpose:
 *   Builds the PowerShell invocation string for the move-archived-logs-ByCN action
 *   in cvs_functions.ps1.  AD group is resolved internally by the script using
 *   Get-ListOfServers-ByCN with -Recursive expansion, Enabled -eq $true filter,
 *   and -Server targeting for the specified domain controller.
 *
 * Inputs:
 *   scriptPath       (string) - Full path to cvs_functions.ps1 on the PS host
 *   securityGroupCN  (string) - Common Name (CN) of the AD security group
 *   domainName       (string) - AD domain name used as -Server target, e.g. corp.local
 *   fileShareTarget  (string) - UNC destination root, e.g. \\server\share$\Windows
 *
 * Return type: string
 */

// ── Input validation ──────────────────────────────────────────────────────────

if (!scriptPath || scriptPath.trim() === "") {
    throw new Error("buildMoveByGroupCNInvocation: scriptPath is required and must not be empty.");
}

if (!securityGroupCN || securityGroupCN.trim() === "") {
    throw new Error("buildMoveByGroupCNInvocation: securityGroupCN is required and must not be empty.");
}

if (!domainName || domainName.trim() === "") {
    throw new Error("buildMoveByGroupCNInvocation: domainName is required and must not be empty.");
}

if (!fileShareTarget || fileShareTarget.trim() === "") {
    throw new Error("buildMoveByGroupCNInvocation: fileShareTarget is required and must not be empty.");
}

System.log(
    "buildMoveByGroupCNInvocation | scriptPath=" + scriptPath +
    " | securityGroupCN=" + securityGroupCN +
    " | domainName=" + domainName +
    " | fileShareTarget=" + fileShareTarget
);

// ── Build invocation string ───────────────────────────────────────────────────
// Produces:
//   & "C:\PSO\Scripts\cvs_functions.ps1" `
//       -Action 'move-archived-logs-ByCN' `
//       -SecurityGroupCN 'My Group CN' `
//       -DomainName 'corp.local' `
//       -FileShareTarget '\\server\share$\Windows'
//
// Note: -DomainName is passed to the script which uses it as the -Server value
// in Get-ADGroupMember / Get-ADComputer calls.  Confirm the script parameter
// name that maps to -Server in your deployed cvs_functions.ps1 version.

var invocationString =
    "& \"" + scriptPath.trim() + "\"" +
    " -Action 'move-archived-logs-ByCN'" +
    " -SecurityGroupCN '" + securityGroupCN.trim() + "'" +
    " -DomainName '" + domainName.trim() + "'" +
    " -FileShareTarget '" + fileShareTarget.trim() + "'";

System.log("buildMoveByGroupCNInvocation | invocationString=" + invocationString);

return invocationString;
