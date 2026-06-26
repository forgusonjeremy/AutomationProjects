/**
 * Action: parseScriptOutput
 * Module:  broadcom.pso.vc.vm.guestOps.files.windows.logs
 *
 * Purpose:
 *   Parses the PowerShellRemotePSObject returned by the OOTB
 *   "Invoke a PowerShell script" workflow into a structured Properties object.
 *
 *   cvs_functions.ps1 emits all output via Write-Host (through Write-Log) and
 *   Write-Warning.  It does not use Write-Output or Write-Error for operational
 *   messages.  There are no structured objects returned.  getRootObject() will
 *   return a string (the console output stream) or null if nothing was emitted.
 *
 *   Because all error messages are non-terminating and written to stdout via
 *   Write-Host with an "Error:" or "error:" prefix, success/failure is
 *   determined by scanning the output string for those prefixes.
 *
 *   The only terminating error in the relevant actions is the HostList null
 *   check in move-archived-logs-ByHostList — that is caught by the OOTB
 *   workflow exception path (handlePSFailure) before this action is reached.
 *
 * Inputs:
 *   psOutput         (PowerShell:PowerShellRemotePSObject) - Raw PS output object
 *   executionContext (string)                              - Label for log messages
 *
 * Return type: Properties
 *   Keys:
 *     success    (boolean) - true if no "Error:" lines detected in output
 *     outputText (string)  - full output string from getRootObject()
 *     errorLines (string)  - newline-joined lines containing "Error:" or "error:"
 */

// ── Input validation ──────────────────────────────────────────────────────────

if (!psOutput) {
    throw new Error("parseScriptOutput: psOutput is required and must not be null.");
}

var context = (executionContext && executionContext.trim() !== "")
    ? executionContext.trim()
    : "(unknown context)";

System.log("parseScriptOutput | context=" + context + " | calling getRootObject()");

// ── Extract output via getRootObject() ───────────────────────────────────────
//
// cvs_functions.ps1 uses Write-Host exclusively for all output in the four
// log management actions.  Write-Host output is captured by the PS plugin and
// surfaced via getRootObject() as a string.
//
// Possible return types per plugin documentation:
//   simple type (string) — expected for Write-Host output
//   ArrayList            — if multiple objects were emitted
//   Properties           — if a hashtable/PSCustomObject was returned
//   PowerShellPSObject   — if a complex PS object was returned
//   null                 — if the script emitted nothing
//
// For our four actions, we expect string or null.

var outputText = "";

try {
    var rootObj = psOutput.getRootObject();

    if (rootObj === null || rootObj === undefined) {
        System.warn(
            "parseScriptOutput | context=" + context +
            " | getRootObject() returned null — script produced no output."
        );
    } else {
        outputText = String(rootObj);
        System.log(
            "parseScriptOutput | context=" + context +
            " | getRootObject() type=" + typeof rootObj +
            " | length=" + outputText.length
        );
    }
} catch (e) {
    System.error(
        "parseScriptOutput | context=" + context +
        " | getRootObject() threw an exception: " + e.message
    );
    // Do not rethrow — let the caller decide based on success=false
    outputText = "";
}

// ── Scan for error lines ──────────────────────────────────────────────────────
//
// Write-Log prefixes error messages with "Error:" or "error:" (case varies).
// Remove-OldFiles-UNCPath uses Write-Warning for per-file delete failures;
// Write-Warning output may or may not appear in getRootObject() depending on
// PS plugin stream capture behaviour — treat Warning lines as informational,
// not as failures, since the script continues and reports a summary.
//
// A line is treated as an error indicator if it contains "Error:" or "error:"
// (case-insensitive match to handle both Write-Log variants).

var errorLines = [];
var hasErrors  = false;

if (outputText.trim() !== "") {
    var lines = outputText.split("\n");
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        // Case-insensitive check for Error: prefix in log output
        if (line.toLowerCase().indexOf("error:") !== -1) {
            errorLines.push(line.trim());
            hasErrors = true;
        }
    }
}

var errorText = errorLines.join("\n");

// ── Determine success ─────────────────────────────────────────────────────────

var success = !hasErrors;

// ── Log results ───────────────────────────────────────────────────────────────

System.log(
    "parseScriptOutput | context=" + context +
    " | success=" + success +
    " | errorLineCount=" + errorLines.length +
    " | outputLength=" + outputText.length
);

if (outputText.trim() !== "") {
    System.log("parseScriptOutput | context=" + context + " | OUTPUT:\n" + outputText);
}

if (hasErrors) {
    System.error(
        "parseScriptOutput | context=" + context +
        " | Error lines detected in script output:\n" + errorText
    );
}

// ── Build and return Properties ───────────────────────────────────────────────

var result = new Properties();
result.put("success",    success);
result.put("outputText", outputText);
result.put("errorLines", errorText);

return result;
