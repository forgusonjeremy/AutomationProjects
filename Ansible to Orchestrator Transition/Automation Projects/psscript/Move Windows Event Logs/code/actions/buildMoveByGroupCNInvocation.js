/**
 * Action: buildMoveByGroupCNInvocation
 * Module:  broadcom.pso.vc.vm.guestOps.files.windows.logs
 *
 * Purpose:
 *   Builds the PowerShell invocation string for the move-archived-logs-ByCN
 *   action in cvs_functions.ps1.  AD group is resolved internally by the script
 *   using Get-ListOfServers-ByCN with -Recursive expansion, Enabled -eq $true
 *   filter, and -Server $DomainName for explicit DC targeting.
 *
 *   Script parameter name: $SecurityGroup_CN (underscore — confirmed from script)
 *
 * Inputs:
 *   scriptPath       (string) - Full path to cvs_functions.ps1 on the PS host
 *   securityGroupCN  (string) - Common Name (CN) of the AD security group
 *   domainName       (string) - AD domain name used as -Server target
 *   fileShareTarget  (string) - UNC destination root
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
// Script parameter is -SecurityGroup_CN (with underscore), confirmed from
// cvs_functions.ps1 param block: [string]$SecurityGroup_CN

var invocationString =
    "& \"" + scriptPath.trim() + "\"" +
    " -Action 'move-archived-logs-ByCN'" +
    " -SecurityGroup_CN '" + securityGroupCN.trim() + "'" +
    " -DomainName '" + domainName.trim() + "'" +
    " -FileShareTarget '" + fileShareTarget.trim() + "'";

System.log("buildMoveByGroupCNInvocation | invocationString=" + invocationString);

return invocationString;
