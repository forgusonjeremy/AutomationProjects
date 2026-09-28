/**
 * Action: invokeStagedScript
 * Module:  com.broadcom.pso.vcf.powershell.staging   (SHARED - reference, do not copy)
 *
 * vRO input-parameter order (positional call from the workflow):
 *   (psHost, scriptPath, parameters, stagedScript)
 *
 * WHAT IT DOES
 *   Runs a script that stageScriptOnHost has ALREADY put on the PowerShell host, with the
 *   parameters you give it, and returns what the script reported.
 *
 *   It is the partner of stageScriptOnHost and the successor, for staged scripts, of
 *   runPowerShellScript (Server Reboots / Move Archived Logs). runPowerShellScript embeds
 *   the whole script in every invocation, writes it to %TEMP%, runs it and deletes it.
 *   This action does none of that: the file is already on disk at a fixed path and has been
 *   verified byte-for-byte against the Resource Element seconds earlier, so it is simply
 *   invoked by path. The script body never crosses WinRM on a run where it has not changed.
 *
 * INPUTS (in this order -- vRO passes action inputs positionally)
 *   psHost        PowerShell:PowerShellHost  the host to run on -- the SAME object that was
 *                                            bound to stageScriptOnHost
 *   scriptPath    string                     absolute path of the staged script, the SAME
 *                                            value bound to stageScriptOnHost's targetPath
 *   parameters    Properties                 script parameters; each key becomes -Key 'value'
 *   stagedScript  string                     the label stageScriptOnHost returned. Bind it from
 *                                            that action's output. It is not used to run
 *                                            anything; it exists so this element cannot be
 *                                            wired up without the staging element in front of
 *                                            it, and so the run log names the script generation
 *                                            next to its output.
 *
 * RETURNS
 *   Properties with:
 *     success     boolean     true when the script reported errorCount 0
 *     result      Properties  the fields of the script's PSO_RESULT line. Numbers, booleans,
 *                             strings and arrays of strings arrive as themselves. Anything
 *                             structured (an object, or an array of objects) arrives as a
 *                             JSON STRING -- JSON.parse() it in the consuming task. That keeps
 *                             the attribute serialisable between workflow elements whatever
 *                             shape the script chose.
 *     transcript  string      everything the script printed
 *
 * THE CONTRACT WITH THE SCRIPT
 *   The script must print exactly one line  PSO_RESULT=<compact JSON>  holding at least
 *   errorCount. If the line is missing the script did not run to completion -- the session
 *   died, PowerShell could not start, a parameter failed validation -- and this action
 *   THROWS rather than returning an empty result, so a broken run cannot look like a clean
 *   one that found nothing to do.
 *
 * WHICH SESSION IT USES
 *   psHost.invokeScript() -- the host's own, already-authenticated session -- in preference to
 *   openSession(). The difference is invisible on the host and only shows one hop further
 *   out: a separate session need not carry the delegated credential, so every \\<server>\C$
 *   path comes back 'Access is denied' while the same commands work through the plug-in's
 *   own 'Invoke a PowerShell script' workflow. Which call ran is logged, because a run that
 *   fails at the second hop has to be able to say. (Same reasoning as runPowerShellScript.)
 */

// ---------------------------------------------------------------------------
// 1. Check the bindings
// ---------------------------------------------------------------------------
if (psHost === null || psHost === undefined) {
    throw new Error("invokeStagedScript: psHost is required. Bind it to the same host object used by stageScriptOnHost.");
}
if (!scriptPath || String(scriptPath).replace(/^\s+|\s+$/g, "") === "") {
    throw new Error("invokeStagedScript: scriptPath is required. Bind it to the same value as stageScriptOnHost's targetPath.");
}
if (!stagedScript || String(stagedScript).replace(/^\s+|\s+$/g, "") === "") {
    throw new Error(
        "invokeStagedScript: stagedScript is empty. Bind it to the output of the stageScriptOnHost element -- " +
        "a staged script must be staged (and verified) in the same run before it is invoked."
    );
}

var path = String(scriptPath).replace(/^\s+|\s+$/g, "");

// PowerShell single quotes take everything literally; the only character that needs
// escaping is the single quote itself, which is written twice.
function quote(value) {
    return "'" + String(value).replace(/'/g, "''") + "'";
}

// ---------------------------------------------------------------------------
// 2. Turn the parameters into a PowerShell argument list
// ---------------------------------------------------------------------------
var argumentList = "";
if (parameters !== null && parameters !== undefined) {
    var keys = parameters.keys;
    for (var k = 0; k < keys.length; k++) {
        // The key becomes a parameter NAME on the command line, outside any quoting, so it
        // must be a plain identifier. Nothing legitimate needs more.
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(String(keys[k]))) {
            throw new Error("invokeStagedScript: parameter name '" + keys[k] + "' is not a valid PowerShell parameter name.");
        }
        argumentList += " -" + keys[k] + " " + quote(parameters.get(keys[k]));
    }
}

// ---------------------------------------------------------------------------
// 3. The wrapper: confirm the file is there, run it, capture every stream
// ---------------------------------------------------------------------------
//   *>&1 | Out-String merges every PowerShell stream (output, host, warnings, errors) into
//   one block of text. Without it the plug-in hands back only the success stream, and
//   everything the script logged with Write-Host would be lost. -Width 4096 stops long lines
//   being wrapped, which would otherwise split the PSO_RESULT line in half.
var wrapper = [
    "$ErrorActionPreference = 'Stop'",
    "$scriptFile = " + quote(path),
    "if (-not (Test-Path -LiteralPath $scriptFile -PathType Leaf)) {",
    "    Write-Output ('The staged script ' + $scriptFile + ' is not on this host. It is staged by stageScriptOnHost in the same run -- check that element ran against this host object.')",
    "    return",
    "}",
    "try {",
    "    $transcript = & $scriptFile" + argumentList + " *>&1 | Out-String -Width 4096",
    "}",
    // A terminating error means the pipeline above never finished, so $transcript was never
    // assigned. Keep the error text as the transcript -- without this the run comes back with
    // nothing at all, which is exactly when the log matters most.
    "catch {",
    "    $transcript = [string]$transcript + ($_ | Out-String -Width 4096)",
    "}",
    "Write-Output $transcript"
].join("\r\n");

// ---------------------------------------------------------------------------
// 4. Run it on the host
// ---------------------------------------------------------------------------
System.log("Running " + path + " on " + psHost.name + " -- " + stagedScript);

var invocation;
if (typeof psHost.invokeScript === "function") {
    System.log("Invoking via psHost.invokeScript() -- the host's own session");
    invocation = psHost.invokeScript(wrapper);
}
else {
    System.log("Invoking via psHost.openSession() -- a separate session, as this plug-in does not expose invokeScript() on the host");
    var session = psHost.openSession();
    try {
        invocation = session.invokeScript(wrapper);
    }
    finally {
        psHost.closeSession(session.getSessionId());
    }
}

// ---------------------------------------------------------------------------
// 5. Get the text back out
// ---------------------------------------------------------------------------
var transcript = "";
try {
    transcript = String(invocation.getHostOutput() || "");
}
catch (e) {
    transcript = "";
}

// Tested for blankness rather than for "" exactly: the plug-in can hand back a stray line
// break as host output, and treating that as the transcript would lose the real one.
if (transcript.replace(/^\s+|\s+$/g, "") === "") {
    var returned = invocation.getInvocationResult();
    if (returned !== null && returned !== undefined) {
        var root = returned.getRootObject();
        if (root !== null && root !== undefined) {
            transcript = String(root);
        }
    }
}

// Control characters can cross the connection written out as _x000D_ and _x000A_.
transcript = transcript.replace(/_x([0-9A-Fa-f]{4})_/g, function (whole, hex) {
    return String.fromCharCode(parseInt(hex, 16));
});

System.log("--- " + path + " output ---\n" + transcript);

// ---------------------------------------------------------------------------
// 6. Read the one line the script wrote for us
// ---------------------------------------------------------------------------
var marker = /^\s*PSO_RESULT=(.*)$/m.exec(transcript);

if (marker === null) {
    throw new Error(
        "invokeStagedScript: " + path + " did not report a result. It always writes a PSO_RESULT line, " +
        "so it did not run to completion. Output was:\n" + transcript
    );
}

var reported;
try {
    reported = JSON.parse(marker[1]);
}
catch (eJ) {
    throw new Error("invokeStagedScript: the PSO_RESULT line is not valid JSON (" + eJ + "): " + marker[1].substring(0, 500));
}

if (typeof reported.errorCount !== "number") {
    throw new Error("invokeStagedScript: the PSO_RESULT line has no numeric errorCount, so success cannot be judged: " + marker[1].substring(0, 500));
}

function isPlain(value) {
    return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

var result = new Properties();
for (var field in reported) {
    var value = reported[field];
    if (isPlain(value)) {
        result.put(field, value);
    }
    else if (value instanceof Array && value.every(function (v) { return typeof v === "string"; })) {
        result.put(field, value);
    }
    else {
        result.put(field, JSON.stringify(value));
    }
}

var output = new Properties();
output.put("success", reported.errorCount === 0);
output.put("result", result);
output.put("transcript", transcript);

return output;
