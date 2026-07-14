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
 *   messages.  There are no structured objects returned.
 *
 *   IMPORTANT: the vRO PowerShell plugin returns ONLY the success (pipeline)
 *   stream via getRootObject(); Write-Host / Write-Warning output is logged by
 *   the plugin but is NOT part of the returned object. To make the transcript
 *   available here, the build*Invocation actions append ' *>&1 | Out-String' to
 *   the invocation, which merges all host/info/warning/error streams into the
 *   success stream as a single string. getRootObject() therefore returns that
 *   string, or null if the invocation was NOT built with the redirect (in which
 *   case success/failure cannot be determined from output — treated as no output).
 *
 *   Because all error messages are non-terminating and written to stdout via
 *   Write-Host with an "Error:" or "error:" prefix, success/failure is
 *   determined by scanning the output string for those prefixes.
 *
 *   Terminating errors (e.g. an invalid script path, or a hard failure inside
 *   the OOTB "Invoke a PowerShell script" workflow) are caught by the OOTB
 *   workflow exception path (handlePSFailure) before this action is reached.
 *   This action therefore only classifies non-terminating "Error:" output.
 *
 * Inputs:
 *   psOutput         (PowerShell:PowerShellRemotePSObject) - Raw PS output object
 *   executionContext (string)                              - Label for log messages
 *
 * Return type: Properties
 *   Keys:
 *     success    (boolean) - true if no "Error:" lines detected in output
 *     outputText (string)  - full output string from getRootObject() (CLIXML-decoded)
 *     errorText  (string)  - newline-joined lines containing "Error:" or "error:"
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
// For our actions, we expect string or null.

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

// ── Decode CLIXML character escapes ───────────────────────────────────────────
//
// The build*Invocation actions append ' *>&1 | Out-String', producing a single
// multi-line string. When that string crosses the WinRM/PSRP boundary, the vRO
// PowerShell plugin serializes control characters as literal CLIXML escapes
// (_xNNNN_) and does NOT decode them — e.g. CR/LF arrive as the text
// "_x000D__x000A_" and TAB as "_x0009_". Left as-is, the transcript contains no
// real "\n", so the line-based scan below sees the entire output as ONE line and
// cannot isolate individual "Error:" lines. Decode every _xNNNN_ hex escape back
// to its character so split("\n") works and outputText displays correctly.

outputText = outputText.replace(/_x([0-9A-Fa-f]{4})_/g, function (m, hex) {
    return String.fromCharCode(parseInt(hex, 16));
});

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
result.put("errorText",  errorText);

return result;
