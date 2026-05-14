/**
 * Action: buildMoveByGroupNameInvocation
 * Module:  broadcom.pso.vc.vm.guestOps.files.windows.logs
 *
 * Purpose:
 *   Builds the PowerShell invocation string for the move-archived-logs action
 *   in cvs_functions.ps1.  AD group is resolved internally by the script using
 *   Get-ListOfServers with the sAMAccountName supplied here.
 *
 * Inputs:
 *   scriptPath      (string) - Full path to cvs_functions.ps1 on the PS host
 *   adGroupMember   (string) - sAMAccountName of the AD security group
 *   domainName      (string) - AD domain name, e.g. corp.local
 *   fileShareTarget (string) - UNC destination root, e.g. \\server\share$\Windows
 *
 * Return type: string
 */

// ── Input validation ──────────────────────────────────────────────────────────

if (!scriptPath || scriptPath.trim() === "") {
    throw new Error("buildMoveByGroupNameInvocation: scriptPath is required and must not be empty.");
}

if (!adGroupMember || adGroupMember.trim() === "") {
    throw new Error("buildMoveByGroupNameInvocation: adGroupMember is required and must not be empty.");
}

if (!domainName || domainName.trim() === "") {
    throw new Error("buildMoveByGroupNameInvocation: domainName is required and must not be empty.");
}

if (!fileShareTarget || fileShareTarget.trim() === "") {
    throw new Error("buildMoveByGroupNameInvocation: fileShareTarget is required and must not be empty.");
}

System.log(
    "buildMoveByGroupNameInvocation | scriptPath=" + scriptPath +
    " | adGroupMember=" + adGroupMember +
    " | domainName=" + domainName +
    " | fileShareTarget=" + fileShareTarget
);

// ── Build invocation string ───────────────────────────────────────────────────
// Produces:
//   & "C:\PSO\Scripts\cvs_functions.ps1" `
//       -Action 'move-archived-logs' `
//       -ADGroupMember 'GroupSAMName' `
//       -DomainName 'corp.local' `
//       -FileShareTarget '\\server\share$\Windows'

var invocationString =
    "& \"" + scriptPath.trim() + "\"" +
    " -Action 'move-archived-logs'" +
    " -ADGroupMember '" + adGroupMember.trim() + "'" +
    " -DomainName '" + domainName.trim() + "'" +
    " -FileShareTarget '" + fileShareTarget.trim() + "'";

System.log("buildMoveByGroupNameInvocation | invocationString=" + invocationString);

return invocationString;
