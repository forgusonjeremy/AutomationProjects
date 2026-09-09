/**
 * Action:  runPowerShellScript
 * Module:  com.broadcom.pso.windows.logs
 *
 * WHAT IT DOES
 *   Takes a PowerShell script that is stored in Orchestrator as a Resource Element,
 *   copies it to the PowerShell host, runs it with the parameters you give it,
 *   deletes it again, and returns the result.
 *
 *   Every workflow in this package calls this one action to run its script. It is the
 *   only place that knows anything about the PowerShell plug-in, so if the plug-in ever
 *   behaves differently, this is the only file that changes.
 *
 *   The Resource Element itself is handed in, not looked up by name in here, so the
 *   workflow shows which script a run used rather than that being decided out of sight.
 *
 * INPUTS (in this order -- vRO passes action inputs positionally)
 *   psHost      PowerShell:PowerShellHost   the host that will run the script
 *   script      ResourceElement             the element holding the .ps1. Its name is used
 *                                           as the file name on the host, e.g.
 *                                           "Move-ArchivedLogs.ps1"
 *   parameters  Properties                  script parameters, e.g. { SourcePath : "C$\\Windows" }
 *
 * RETURNS
 *   Properties with:
 *     success     boolean  true when the script reported no errors
 *     result      Properties  the values the script reported (moved, deleted, errorCount, ...)
 *     transcript  string   everything the script printed, for the run log
 *
 * WHY THE SCRIPT IS COPIED RATHER THAN PASTED INLINE
 *   The script is written to a real .ps1 file on the host and invoked by path. That means
 *   it runs exactly as it would if an administrator ran it by hand, so what you test at a
 *   console is what the workflow does. It is removed straight afterwards, so no stale copy
 *   is ever left behind to drift out of date with the version held in Orchestrator.
 */

// ---------------------------------------------------------------------------
// 1. Get the script content
// ---------------------------------------------------------------------------
if (script === null || script === undefined) {
    throw new Error(
        "runPowerShellScript: no script was supplied. Bind the script input to the Resource " +
        "Element that holds the .ps1, for example Move-ArchivedLogs.ps1."
    );
}

// The Resource Element's own name becomes the file name on the host, so the file sitting
// in the working folder during a run is recognisably the one held in Orchestrator.
var scriptName = String(script.name);

// That name is used to build a path on the host. A separator in it would put the file
// somewhere other than the working folder, so it is refused rather than quietly cleaned up.
if (/[\\\/:]/.test(scriptName)) {
    throw new Error(
        "runPowerShellScript: the Resource Element is named '" + scriptName + "'. That name " +
        "becomes the file name on the host, so it cannot contain \\ / or :. Rename the element."
    );
}

var attachment = script.getContentAsMimeAttachment();

if (attachment === null || attachment === undefined ||
    attachment.content === null || attachment.content === undefined ||
    String(attachment.content) === "") {
    throw new Error(
        "runPowerShellScript: the Resource Element '" + scriptName + "' holds no content. " +
        "Re-import the .ps1 file into it."
    );
}

var scriptText = String(attachment.content);

// The script is handed to PowerShell inside a single-quoted here-string, which treats
// every character literally. The only thing that can break it is a line consisting of
// just  '@  -- that would end the here-string early. No normal script contains one,
// but check rather than produce a corrupted file on the host.
if (/^\s*'@\s*$/m.test(scriptText)) {
    throw new Error(
        "runPowerShellScript: '" + scriptName + "' contains a line that is just  '@  which would " +
        "truncate it when it is copied to the host. Reword or indent that line."
    );
}

// ---------------------------------------------------------------------------
// 2. Turn the parameters into a PowerShell argument list
// ---------------------------------------------------------------------------

// PowerShell single quotes take everything literally; the only character that needs
// escaping is the single quote itself, which is written twice.
function quote(value) {
    return "'" + String(value).replace(/'/g, "''") + "'";
}

var argumentList = "";
if (parameters !== null && parameters !== undefined) {
    var keys = parameters.keys;
    for (var k = 0; k < keys.length; k++) {
        argumentList += " -" + keys[k] + " " + quote(parameters.get(keys[k]));
    }
}

// ---------------------------------------------------------------------------
// 3. Build the wrapper that copies the script over, runs it, and cleans up
// ---------------------------------------------------------------------------
//
//   *>&1 | Out-String  merges every PowerShell stream (output, host, warnings,
//   errors) into one block of text and returns it as a single string. Without it
//   the plug-in hands back only the success stream, and everything the script
//   logged with Write-Host would be lost. -Width 4096 stops long lines being
//   wrapped, which would otherwise split the result line in half.
//
var wrapper = [
    "$ErrorActionPreference = 'Stop'",
    "$folder = Join-Path $env:TEMP 'Orchestrator'",
    "if (-not (Test-Path -LiteralPath $folder)) { New-Item -ItemType Directory -Path $folder -Force | Out-Null }",
    "$scriptFile = Join-Path $folder " + quote(scriptName),
    "$scriptBody = @'",
    scriptText,
    "'@",
    "Set-Content -LiteralPath $scriptFile -Value $scriptBody -Encoding UTF8",
    "try {",
    "    $transcript = & $scriptFile" + argumentList + " *>&1 | Out-String -Width 4096",
    "}",
    // A terminating error means the pipeline above never finished, so $transcript
    // was never assigned. Keep the error text as the transcript instead -- without this
    // the run comes back with nothing at all, which is when the log matters most.
    "catch {",
    "    $transcript = [string]$transcript + ($_ | Out-String)",
    "}",
    "finally {",
    "    Remove-Item -LiteralPath $scriptFile -Force -ErrorAction SilentlyContinue",
    "}",
    "Write-Output $transcript"
].join("\r\n");

// ---------------------------------------------------------------------------
// 4. Run it on the host
// ---------------------------------------------------------------------------
System.log("Running " + scriptName + " on " + psHost.name);

var invocation;
var session = psHost.openSession();
try {
    invocation = session.invokeScript(wrapper);
}
finally {
    // Always close the session, even if the script failed, so sessions do not
    // accumulate on the host.
    psHost.closeSession(session.getSessionId());
}

// ---------------------------------------------------------------------------
// 5. Get the text back out
// ---------------------------------------------------------------------------
var transcript = "";

// Preferred: whatever the script printed to the host.
try {
    transcript = invocation.getHostOutput() || "";
}
catch (e) {
    transcript = "";
}

// Fallback: the value the script returned. This is what the *>&1 redirect above
// produces, so it holds the same text.
//
// Tested for blankness rather than for "" exactly: the plug-in can hand back a stray
// line break as host output, and treating that as the transcript would skip this
// fallback and lose the real one.
if (transcript.replace(/^\s+|\s+$/g, "") === "") {
    var returned = invocation.getInvocationResult();
    if (returned !== null && returned !== undefined) {
        var root = returned.getRootObject();
        if (root !== null && root !== undefined) {
            transcript = String(root);
        }
    }
}

// When text crosses the connection to the host, control characters can arrive
// written out as _x000D_ and _x000A_ rather than as real line breaks. Put them back,
// otherwise the whole transcript is one unreadable line.
transcript = transcript.replace(/_x([0-9A-Fa-f]{4})_/g, function (whole, hex) {
    return String.fromCharCode(parseInt(hex, 16));
});

System.log("--- " + scriptName + " output ---\n" + transcript);

// ---------------------------------------------------------------------------
// 6. Read the one line the script wrote for us
// ---------------------------------------------------------------------------
//
// The script always writes a PSO_RESULT= line, even when it does nothing. If that
// line is missing, the script never finished -- the session died, PowerShell could
// not start, or the file never made it across. Treat that as a failure rather than
// as "zero files processed", which would let a broken run look like a clean one.
//
var marker = /^\s*PSO_RESULT=(.*)$/m.exec(transcript);

if (marker === null) {
    throw new Error(
        "runPowerShellScript: " + scriptName + " did not report a result. It always writes a " +
        "PSO_RESULT line, so it did not run to completion. Output was:\n" + transcript
    );
}

var reported = JSON.parse(marker[1]);

// Copy the reported values into a Properties object so workflows can read them
// with .get("moved") and so on.
var result = new Properties();
for (var field in reported) {
    result.put(field, reported[field]);
}

var output = new Properties();
output.put("success", reported.errorCount === 0);
output.put("result", result);
output.put("transcript", transcript);

return output;
