/**
 * Action: buildRemoveFilesInvocation
 * Module:  broadcom.pso.vc.vm.guestOps.files.windows.logs
 *
 * Purpose:
 *   Builds the PowerShell invocation string for the Delete-OldFiles-UNC-Share
 *   action in cvs_functions.ps1.  When whatIf = 'yes' the script performs a
 *   report-only scan with no deletions.  Default is 'yes' to prevent accidental
 *   deletion on a first or unreviewed run.
 *
 * Inputs:
 *   scriptPath    (string) - Full path to cvs_functions.ps1 on the PS host
 *   uncSharePath  (string) - UNC path to scan/clean, e.g. \\server\share$\Windows
 *   olderThanDays (number) - Delete files older than this many days (minimum 1)
 *   whatIf        (string) - 'yes' = report only, 'no' = delete for real
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

if (whatIfNormalised === "no") {
    System.warn(
        "buildRemoveFilesInvocation | whatIf=no — this execution WILL delete files older than " +
        days + " day(s) from " + uncSharePath.trim()
    );
}

// ── Build invocation string ───────────────────────────────────────────────────
// Produces:
//   & "C:\PSO\Scripts\cvs_functions.ps1" `
//       -Action 'Delete-OldFiles-UNC-Share' `
//       -UNCSharePath '\\server\share$\Windows' `
//       -OlderThanDays 370 `
//       -WhatIf 'yes'
//
// VALIDATION REQUIRED: confirm the exact parameter names (-UNCSharePath,
// -OlderThanDays, -WhatIf) match the param block in your deployed
// cvs_functions.ps1.  Adjust names below if they differ.

var invocationString =
    "& \"" + scriptPath.trim() + "\"" +
    " -Action 'Delete-OldFiles-UNC-Share'" +
    " -UNCSharePath '" + uncSharePath.trim() + "'" +
    " -OlderThanDays " + days +
    " -WhatIf '" + whatIfNormalised + "'";

System.log("buildRemoveFilesInvocation | invocationString=" + invocationString);

return invocationString;
