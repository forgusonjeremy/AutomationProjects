/**
 * Action: buildMoveByADGroupInvocation
 * Module:  broadcom.pso.vc.vm.guestOps.files.windows.logs
 *
 * Purpose:
 *   Builds the PowerShell invocation string for the move-archived-logs-ByCN
 *   action in cvs_functions.ps1.  This is the single, consolidated AD-group
 *   targeting method for the package.  AD resolution and per-server iteration
 *   are handled entirely inside the script via Get-ListOfServers-ByCN, which:
 *     - expands nested groups recursively (-Recursive)
 *     - filters to computer objects only (objectClass -eq 'computer')
 *     - filters to enabled computers only (Enabled -eq $true)
 *     - targets a specific DC via -Server $DomainName
 *   This is the most comprehensive resolution path in the script: it finds all
 *   computers requiring archive-log cleanup while skipping disabled/decommissioned
 *   accounts.
 *
 *   Script parameter name: $SecurityGroup_CN (underscore — confirmed from script).
 *   The script passes this value straight to Get-ADGroupMember -Identity, which
 *   accepts any unambiguous group identifier (sAMAccountName, CN, distinguishedName,
 *   GUID, or SID) — so the operator-facing input is named simply 'adGroup'.
 *
 * Inputs:
 *   scriptPath      (string) - Full path to cvs_functions.ps1 on the PS host
 *   adGroup         (string) - AD security group identifier (name / CN / DN / sAMAccountName)
 *   domainName      (string) - AD domain name used as -Server target
 *   fileShareTarget (string) - UNC destination root, e.g. \\server\share$\Windows
 *
 * Return type: string
 */

// ── Input validation ──────────────────────────────────────────────────────────

if (!scriptPath || scriptPath.trim() === "") {
    throw new Error("buildMoveByADGroupInvocation: scriptPath is required and must not be empty.");
}
if (!adGroup || adGroup.trim() === "") {
    throw new Error("buildMoveByADGroupInvocation: adGroup is required and must not be empty.");
}
if (!domainName || domainName.trim() === "") {
    throw new Error("buildMoveByADGroupInvocation: domainName is required and must not be empty.");
}
if (!fileShareTarget || fileShareTarget.trim() === "") {
    throw new Error("buildMoveByADGroupInvocation: fileShareTarget is required and must not be empty.");
}

System.log(
    "buildMoveByADGroupInvocation | scriptPath=" + scriptPath +
    " | adGroup=" + adGroup +
    " | domainName=" + domainName +
    " | fileShareTarget=" + fileShareTarget
);

// ── Build invocation string ───────────────────────────────────────────────────
// Script parameter is -SecurityGroup_CN (with underscore), confirmed from
// cvs_functions.ps1 param block: [string]$SecurityGroup_CN
// Produces:
//   & "C:\PSO\Scripts\cvs_functions.ps1" `
//       -Action 'move-archived-logs-ByCN' `
//       -SecurityGroup_CN 'WinLogServers' `
//       -DomainName 'corp.local' `
//       -FileShareTarget '\\server\share$\Windows'

var invocationString =
    "& \"" + scriptPath.trim() + "\"" +
    " -Action 'move-archived-logs-ByCN'" +
    " -SecurityGroup_CN '" + adGroup.trim() + "'" +
    " -DomainName '" + domainName.trim() + "'" +
    " -FileShareTarget '" + fileShareTarget.trim() + "'";

System.log("buildMoveByADGroupInvocation | invocationString=" + invocationString);

return invocationString;
