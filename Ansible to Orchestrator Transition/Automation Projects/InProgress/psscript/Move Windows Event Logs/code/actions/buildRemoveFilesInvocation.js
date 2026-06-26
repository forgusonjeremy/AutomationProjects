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
 *   Script behaviour:
 *     WhatIf='yes' → calls Remove-OldFiles-UNCPath with -Force $false
 *                    The function checks: if (-not $Force -and -not $WhatIfPreference)
 *                    and calls Read-Host for confirmation.
 *
 *   !! IMPORTANT — WhatIf='yes' WILL PROMPT for confirmation !!
 *   The Remove-OldFiles-UNCPath function calls Read-Host when -Force $false
 *   and $WhatIfPreference is not set.  In a non-interactive PS host session
 *   (as used by vRO), Read-Host will either block indefinitely or throw.
 *   This is a script-level issue to address before production use.
 *   Recommended fix (Phase 2): add a -WhatIf switch or -ReportOnly parameter
 *   to Remove-OldFiles-UNCPath that lists files without prompting.
 *   For Phase 1: use WhatIf='no' (-Force $true) for non-interactive execution,
 *   accepting that the safety report-only mode is not functional as-is.
 *   Document this risk explicitly in the validation plan.
 *
 *   WhatIf='no'  → calls Remove-OldFiles-UNCPath with -Force $true
 *                  Deletes files older than OlderThanDays without prompting.
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
    System.warn(
        "buildRemoveFilesInvocation | whatIf=yes — NOTE: Remove-OldFiles-UNCPath calls " +
        "Read-Host for confirmation when -Force $false in non-interactive sessions. " +
        "This may block or fail. Validate script behaviour before scheduling. " +
        "See action header comment for details."
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

var invocationString =
    "& \"" + scriptPath.trim() + "\"" +
    " -Action 'Delete-OldFiles-UNC-Share'" +
    " -UNC_SharePath '" + uncSharePath.trim() + "'" +
    " -OlderThanDays " + days +
    " -WhatIf '" + whatIfNormalised + "'";

System.log("buildRemoveFilesInvocation | invocationString=" + invocationString);

return invocationString;
