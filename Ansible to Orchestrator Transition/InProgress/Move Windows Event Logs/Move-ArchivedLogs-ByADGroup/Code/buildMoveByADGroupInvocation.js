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
 *     - filters to enabled computers only (Enabled -eq $true), logging skips
 *     - isolates per-object resolution failures so one bad object does not abort
 *     - targets a specific DC via -Server $DomainName
 *   This is the most comprehensive resolution path in the script: it finds all
 *   computers requiring archive-log cleanup while skipping disabled/decommissioned
 *   accounts.
 *
 *   Group identity: the script passes the value straight to
 *   Get-ADGroupMember -Identity, so a distinguishedName (DN) is the preferred,
 *   unambiguous identifier — e.g.
 *     CN=All-Servers,OU=Groups,OU=Lab,DC=vcf,DC=lab
 *   CN / sAMAccountName / GUID / SID also resolve, but the operator-facing input
 *   is named 'groupDN' to make DN the intended form.  The script parameter it
 *   maps to is -SecurityGroup_CN (underscore — confirmed from the script param
 *   block: [string]$SecurityGroup_CN).
 *
 * Inputs:
 *   scriptPath      (string) - Full path to cvs_functions.ps1 on the PS host
 *   groupDN         (string) - AD group distinguishedName (preferred) or other
 *                              unambiguous identifier (CN / sAMAccountName / GUID / SID)
 *   domainName      (string) - AD domain name used as -Server target
 *   fileShareTarget (string) - UNC destination root, e.g. \\server\share$\Windows
 *   fileFilter      (string) - File name filter, e.g. Archive-*.evtx  → -FilterOn
 *   fileAgeDays     (number) - Move files older than N days.  Uses the script's
 *                              AddDays() convention: negative or 0 (e.g. -1 = files
 *                              last written before yesterday).  → -NumberOfDays
 *
 * Return type: string
 */

// ── Input validation ──────────────────────────────────────────────────────────

if (!scriptPath || scriptPath.trim() === "") {
    throw new Error("buildMoveByADGroupInvocation: scriptPath is required and must not be empty.");
}
if (!groupDN || groupDN.trim() === "") {
    throw new Error("buildMoveByADGroupInvocation: groupDN is required and must not be empty.");
}
if (!domainName || domainName.trim() === "") {
    throw new Error("buildMoveByADGroupInvocation: domainName is required and must not be empty.");
}
if (!fileShareTarget || fileShareTarget.trim() === "") {
    throw new Error("buildMoveByADGroupInvocation: fileShareTarget is required and must not be empty.");
}
if (!fileFilter || fileFilter.trim() === "") {
    throw new Error("buildMoveByADGroupInvocation: fileFilter is required and must not be empty (e.g. 'Archive-*.evtx').");
}
if (fileAgeDays === null || fileAgeDays === undefined || String(fileAgeDays).trim() === "") {
    throw new Error("buildMoveByADGroupInvocation: fileAgeDays is required.");
}

// fileAgeDays must be a whole number. The move uses (Get-Date).AddDays(N), so a
// value of 0 (all files) or a negative value (older than |N| days) is expected;
// positive values are unusual but permitted (they select future-dated files only).
var ageDays = parseInt(fileAgeDays, 10);
if (isNaN(ageDays) || String(ageDays) !== String(fileAgeDays).trim()) {
    throw new Error(
        "buildMoveByADGroupInvocation: fileAgeDays must be a whole number (e.g. -1, 0). Received: " + fileAgeDays
    );
}

// DN nudge: warn (do not fail) when the identifier does not look like a DN, so
// CN / sAMAccountName still work but operators are steered toward the DN form.
if (groupDN.trim().toUpperCase().indexOf("DC=") === -1) {
    System.warn(
        "buildMoveByADGroupInvocation | groupDN='" + groupDN.trim() +
        "' does not look like a distinguishedName (no 'DC=' component). It will be " +
        "passed to Get-ADGroupMember -Identity as-is, but a full DN is recommended " +
        "for unambiguous group resolution."
    );
}

System.log(
    "buildMoveByADGroupInvocation | scriptPath=" + scriptPath +
    " | groupDN=" + groupDN +
    " | domainName=" + domainName +
    " | fileShareTarget=" + fileShareTarget +
    " | fileFilter=" + fileFilter +
    " | fileAgeDays=" + ageDays
);

// ── Build invocation string ───────────────────────────────────────────────────
// Script parameters confirmed from cvs_functions.ps1 param block:
//   -SecurityGroup_CN (underscore)   ← groupDN
//   -DomainName                      ← domainName
//   -FileShareTarget                 ← fileShareTarget
//   -FilterOn                        ← fileFilter
//   -NumberOfDays                    ← fileAgeDays (script maps NumberOfDays → Move-files -Days)
// Produces:
//   & "C:\PSO\Scripts\cvs_functions.ps1" `
//       -Action 'move-archived-logs-ByCN' `
//       -SecurityGroup_CN 'CN=All-Servers,OU=Groups,DC=vcf,DC=lab' `
//       -DomainName 'vcf.lab' `
//       -FileShareTarget '\\server\share$\Windows' `
//       -FilterOn 'Archive-*.evtx' `
//       -NumberOfDays '-1' *>&1 | Out-String -Width 4096
//
// Stream capture ( *>&1 | Out-String -Width 4096 ):
//   cvs_functions.ps1 emits everything through Write-Log -> Write-Host (the host/
//   information stream) and Write-Warning. The vRO PowerShell plugin only returns
//   the SUCCESS (pipeline) stream via getRootObject(); Write-Host output is logged
//   but NOT returned, so without this redirect the OOTB "Invoke a PowerShell script"
//   workflow hands back a null output object and parseScriptOutput has nothing to
//   parse. '*>&1' merges all streams (Info/Warning/Error/Verbose) into the success
//   stream and 'Out-String' collapses them to a single multi-line string, which the
//   plugin returns as a String root object for parseScriptOutput to scan.
//   '-Width 4096' prevents Out-String from wrapping at the default console width
//   (~80 cols) — without it, a long log line (e.g. an "Error:" message with a UNC
//   path) is split across several physical lines, so parseScriptOutput's per-line
//   "Error:" scan would capture only the first fragment and truncate the message.

var invocationString =
    "& \"" + scriptPath.trim() + "\"" +
    " -Action 'move-archived-logs-ByCN'" +
    " -SecurityGroup_CN '" + groupDN.trim() + "'" +
    " -DomainName '" + domainName.trim() + "'" +
    " -FileShareTarget '" + fileShareTarget.trim() + "'" +
    " -FilterOn '" + fileFilter.trim() + "'" +
    " -NumberOfDays '" + ageDays + "'" +
    " *>&1 | Out-String -Width 4096";

System.log("buildMoveByADGroupInvocation | invocationString=" + invocationString);

return invocationString;
