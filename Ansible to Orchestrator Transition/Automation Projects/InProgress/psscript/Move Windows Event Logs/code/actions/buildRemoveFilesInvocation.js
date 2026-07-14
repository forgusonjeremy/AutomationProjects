/**
 * Action: buildRemoveFilesInvocation
 * Module:  broadcom.pso.vc.vm.guestOps.files.windows.logs
 *
 * Purpose:
 *   Builds the PowerShell invocation string for the Delete-OldFiles-UNC-Share
 *   action in cvs_functions.ps1.
 *
 *   Script parameter names (confirmed from cvs_functions.ps1 param block):
 *     $UNC_SharePath   (with underscore)
 *     $OlderThanDays
 *     $WhatIf
 *
 *   Script behaviour (with the report-only fix applied to cvs_functions.ps1 —
 *   see Change-Register.md, change S-1):
 *     WhatIf='yes' → script calls Remove-OldFiles-UNCPath with -ReportOnly $true
 *                    Lists the files that WOULD be deleted (via Write-Log) and
 *                    deletes nothing.  Runs non-interactively — no prompt.
 *     WhatIf='no'  → script calls Remove-OldFiles-UNCPath with -Force $true
 *                    Deletes files older than OlderThanDays without prompting.
 *
 *   This action builds the same -WhatIf 'yes'/'no' string in both cases; the
 *   script's Delete-OldFiles-UNC-Share switch case maps it to -ReportOnly/-Force.
 *
 *   NOTE: report-only behaviour requires the UPDATED cvs_functions.ps1 (with the
 *   -ReportOnly parameter) deployed on the PS host.  On an un-patched script,
 *   WhatIf='yes' hits an interactive Read-Host prompt that blocks/cancels under
 *   vRO — confirm the deployed script includes -ReportOnly (Validation Plan A11).
 *
 * Inputs:
 *   scriptPath    (string) - Full path to cvs_functions.ps1 on the PS host
 *   uncSharePath  (string) - UNC path to scan/clean
 *   olderThanDays (number) - Delete files older than this many days (minimum 1)
 *   whatIf        (string) - 'yes' = report only (see warning above), 'no' = delete
 *
 * Return type: string
 */

// ── Input validation ──────────────────────────────────────────────────────────

if (!scriptPath || scriptPath.trim() === "") {
    throw new Error("buildRemoveFilesInvocation: scriptPath is required and must not be empty.");
}
if (!uncSharePath || uncSharePath.trim() === "") {
    throw new Error("buildRemoveFilesInvocation: uncSharePath is required and must not be empty.");
}
if (olderThanDays === null || olderThanDays === undefined) {
    throw new Error("buildRemoveFilesInvocation: olderThanDays is required.");
}

var days = parseInt(olderThanDays, 10);
if (isNaN(days) || days < 1) {
    throw new Error(
        "buildRemoveFilesInvocation: olderThanDays must be an integer >= 1. Received: " + olderThanDays
    );
}

if (!whatIf || (whatIf.trim().toLowerCase() !== "yes" && whatIf.trim().toLowerCase() !== "no")) {
    throw new Error(
        "buildRemoveFilesInvocation: whatIf must be 'yes' or 'no'. Received: " + whatIf
    );
}

var whatIfNormalised = whatIf.trim().toLowerCase();

System.log(
    "buildRemoveFilesInvocation | scriptPath=" + scriptPath +
    " | uncSharePath=" + uncSharePath +
    " | olderThanDays=" + days +
    " | whatIf=" + whatIfNormalised
);

if (whatIfNormalised === "yes") {
    System.log(
        "buildRemoveFilesInvocation | whatIf=yes — report-only mode: candidate files " +
        "are listed and nothing is deleted. Requires the updated cvs_functions.ps1 " +
        "(-ReportOnly support, Change-Register S-1) deployed on the PS host."
    );
}

if (whatIfNormalised === "no") {
    System.warn(
        "buildRemoveFilesInvocation | whatIf=no — this execution WILL delete files older than " +
        days + " day(s) from " + uncSharePath.trim()
    );
}

// ── Build invocation string ───────────────────────────────────────────────────
// Script parameters confirmed from cvs_functions.ps1:
//   -UNC_SharePath  (with underscore)
//   -OlderThanDays
//   -WhatIf
//
// Stream capture ( *>&1 | Out-String -Width 4096 ):
//   cvs_functions.ps1 emits everything through Write-Log -> Write-Host (the host/
//   information stream) and Write-Warning. The vRO PowerShell plugin only returns
//   the SUCCESS (pipeline) stream via getRootObject(); Write-Host output is logged
//   but NOT returned, so without this redirect the OOTB "Invoke a PowerShell script"
//   workflow hands back a null output object and parseScriptOutput has nothing to
//   parse. '*>&1' merges all streams into the success stream and 'Out-String'
//   collapses them to a single multi-line string returned as a String root object.
//   '-Width 4096' prevents wrapping at the default console width (~80 cols) so long
//   log lines (e.g. an "Error:" message with a UNC path) stay on one physical line
//   and are not truncated by parseScriptOutput's per-line "Error:" scan.

var invocationString =
    "& \"" + scriptPath.trim() + "\"" +
    " -Action 'Delete-OldFiles-UNC-Share'" +
    " -UNC_SharePath '" + uncSharePath.trim() + "'" +
    " -OlderThanDays " + days +
    " -WhatIf '" + whatIfNormalised + "'" +
    " *>&1 | Out-String -Width 4096";

System.log("buildRemoveFilesInvocation | invocationString=" + invocationString);

return invocationString;
