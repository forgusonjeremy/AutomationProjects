/**
 * Action: parseScriptOutput
 * Module:  broadcom.pso.vc.vm.guestOps.files.windows.logs
 *
 * Purpose:
 *   Parses a PowerShell:PowerShellRemotePSObject returned by the OOTB
 *   "Invoke a PowerShell script" workflow into a structured Properties object
 *   containing success/failure status, stdout text, and stderr text.
 *
 * Inputs:
 *   psOutput         (PowerShell:PowerShellRemotePSObject) - Raw PS execution output object
 *   executionContext (string)                              - Human-readable label for log messages
 *                                                           e.g. "GroupName @ corp.local"
 *
 * Return type: Properties
 *   Keys:
 *     success    (boolean) - true if exit code == 0 AND no error lines detected
 *     outputText (string)  - joined stdout content
 *     errorText  (string)  - joined stderr content
 *
 * ── VALIDATION REQUIRED ───────────────────────────────────────────────────────
 * The method names below must be confirmed against the PowerShell plugin version
 * installed in your vRO environment.  Open the vRO scripting API browser,
 * navigate to PowerShell plugin types, and locate PowerShellRemotePSObject.
 *
 * Methods assumed here:
 *   psOutput.getOutputLine()  → String[] or array-like — stdout lines
 *   psOutput.getErrorLine()   → String[] or array-like — stderr lines
 *   psOutput.getExitCode()    → Number                 — process exit code
 *                               NOTE: getExitCode() may not exist in all plugin
 *                               versions.  The code below handles its absence
 *                               gracefully by falling back to stderr-only detection.
 *
 * If method names differ in your environment, update the three variable
 * assignments in the "Collect output" section below.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Input validation ──────────────────────────────────────────────────────────

if (!psOutput) {
    throw new Error("parseScriptOutput: psOutput is required and must not be null.");
}

var context = (executionContext && executionContext.trim() !== "")
    ? executionContext.trim()
    : "(unknown context)";

System.log("parseScriptOutput | context=" + context + " | parsing PS output object");

// ── Collect output ────────────────────────────────────────────────────────────

var outputLines = [];
var errorLines  = [];
var exitCode    = 0;   // default to 0; overwritten if getExitCode() exists

try {
    var rawOut = psOutput.getOutputLine();
    if (rawOut) {
        // getOutputLine() may return a Java array or JS array depending on plugin version
        for (var i = 0; i < rawOut.length; i++) {
            if (rawOut[i] !== null && rawOut[i] !== undefined) {
                outputLines.push(String(rawOut[i]));
            }
        }
    }
} catch (outErr) {
    System.warn("parseScriptOutput | context=" + context +
        " | getOutputLine() failed — stdout unavailable. Error: " + outErr.message);
}

try {
    var rawErr = psOutput.getErrorLine();
    if (rawErr) {
        for (var j = 0; j < rawErr.length; j++) {
            if (rawErr[j] !== null && rawErr[j] !== undefined) {
                errorLines.push(String(rawErr[j]));
            }
        }
    }
} catch (errErr) {
    System.warn("parseScriptOutput | context=" + context +
        " | getErrorLine() failed — stderr unavailable. Error: " + errErr.message);
}

try {
    // getExitCode() may not exist in all PS plugin versions — catch and continue
    exitCode = psOutput.getExitCode();
    if (exitCode === null || exitCode === undefined) {
        exitCode = 0;
    }
    exitCode = parseInt(exitCode, 10);
    if (isNaN(exitCode)) {
        exitCode = 0;
    }
} catch (ecErr) {
    System.warn("parseScriptOutput | context=" + context +
        " | getExitCode() not available in this PS plugin version. " +
        "Falling back to stderr-only success detection.");
    exitCode = 0;
}

// ── Assemble text blocks ──────────────────────────────────────────────────────

var outputText = outputLines.join("\n");
var errorText  = errorLines.join("\n");

// ── Determine success ─────────────────────────────────────────────────────────
// Success requires:
//   1. Exit code == 0  (if available)
//   2. No lines in stderr
//
// This is intentionally conservative — any stderr content is treated as a
// failure indicator.  If your script writes informational content to stderr
// (e.g. Write-Warning output), adjust the condition below.

var hasErrors  = (errorLines.length > 0);
var success    = (!hasErrors && exitCode === 0);

// ── Log results ───────────────────────────────────────────────────────────────

System.log(
    "parseScriptOutput | context=" + context +
    " | exitCode=" + exitCode +
    " | stdoutLines=" + outputLines.length +
    " | stderrLines=" + errorLines.length +
    " | success=" + success
);

if (outputText.trim() !== "") {
    System.log("parseScriptOutput | context=" + context + " | STDOUT:\n" + outputText);
}

if (errorText.trim() !== "") {
    System.error("parseScriptOutput | context=" + context + " | STDERR:\n" + errorText);
}

if (!success) {
    System.warn(
        "parseScriptOutput | context=" + context +
        " | Script completed with errors. exitCode=" + exitCode +
        " hasErrors=" + hasErrors
    );
}

// ── Build and return Properties ───────────────────────────────────────────────

var result = new Properties();
result.put("success",    success);
result.put("outputText", outputText);
result.put("errorText",  errorText);

return result;
