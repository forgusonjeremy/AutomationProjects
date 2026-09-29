/**
 * Action: stageScriptOnHost
 * Module:  com.broadcom.pso.powershell   (SHARED - reference, do not copy)
 *
 * vRO input-parameter order (positional call from the workflow):
 *   (psHost, script, targetPath)
 *
 * Purpose:
 *   Makes sure the PowerShell host holds an EXACT copy of a script kept in an Orchestrator
 *   Resource Element, in a given directory, before the workflow runs it -- and returns the
 *   script's full path for invokeStagedScript to run. The analogue of the playbooks'
 *   `win_copy: src=files/ps_scripts` - except that it copies only when it has to.
 *
 *   The full path is  targetPath + '\' + <Resource Element name>:
 *
 *     targetPath       C:\PSO\Scripts
 *     script           Resource Element named  Invoke-ServerDiskClean.ps1
 *     full path        C:\PSO\Scripts\Invoke-ServerDiskClean.ps1      <- checked, placed, returned
 *
 *   So the file on the host always carries the name of the element it came from, and the
 *   path is built in exactly one place.
 *
 *     First run on a host      the file is absent          -> copy it
 *     Every later run          the file matches exactly    -> run the copy already there
 *     Someone changed either   the file differs            -> overwrite it, then verify
 *
 *   "Matches exactly" means the SHA-256 of the file on the host equals the SHA-256 of the
 *   bytes this action would write, AND the byte lengths agree. Nothing weaker is accepted:
 *   not a timestamp, not a version string, not a length on its own.
 *
 * ── Why a hash comparison (P-67, amends P-56) ─────────────────────────────────
 *   The first version of this action copied on EVERY run, deliberately, to avoid needing a
 *   version marker stamped into each script by a CI job nobody yet owned. A content hash
 *   gets the same guarantee without that prerequisite:
 *
 *     - Nothing to stamp. The hash is computed from the Resource Element's content at run
 *       time, so any script works as-is - no marker line, no CI job.
 *     - Nothing to drift. A copy edited in place on the host, or a Resource Element updated
 *       in Orchestrator, both produce a different hash, and the host copy is overwritten
 *       before it is used. The host can never run anything other than what Orchestrator holds.
 *     - Almost nothing to send. A matching file costs one small probe instead of pushing the
 *       whole script through WinRM - which is what makes it affordable to keep the scripts
 *       FULLY COMMENTED in the Resource Element rather than stripping them to save payload.
 *
 *   "Which generation ran" is answered in the log: every run writes the Resource Element's
 *   version, the SHA-256 verified on disk, and whether the file was a first copy, updated,
 *   or unchanged.
 *
 * ── Transport ─────────────────────────────────────────────────────────────────
 *   The PowerShell plug-in has no file-transfer call, so the content goes as base64 inside
 *   the invocation string and is decoded on the host. The base64 alphabet contains no quote,
 *   backtick or $, so each chunk sits safely in a single-quoted here-string with no escaping
 *   to get wrong.
 *
 *   Chunked at 48000 characters: WinRM's default MaxEnvelopeSizekb is 500 KB, so this stays
 *   an order of magnitude inside it. State lives in a temp file on the host between chunks,
 *   not in session variables, so this does not depend on Shared Session mode.
 *
 *   The target is written via a uniquely named sibling '.staging' file and a Move-Item, so an
 *   interrupted push can never leave a half-written script where the next run would execute
 *   it, and two runs staging at the same moment cannot trip over each other's temp files.
 *
 * ── Which session it uses ─────────────────────────────────────────────────────
 *   psHost.invokeScript() when the plug-in offers it - the host's own session, which is also
 *   the one invokeStagedScript runs the script through. The file is therefore written by the
 *   SAME identity that will execute it, so an ACL that lets one succeed and not the other
 *   cannot exist. openSession() is the fallback for plug-in versions without invokeScript()
 *   on the host, as in runPowerShellScript.
 *
 * Inputs (in this order):
 *   psHost           (PowerShell:PowerShellHost) - the host to stage on. For a multi-domain
 *                                                  estate (P-52) every host object points at
 *                                                  the same pool and shares one filesystem, so
 *                                                  staging via any of them serves all of them.
 *   script           (ResourceElement)           - the element holding the .ps1. Its NAME is the
 *                                                  file name on the host, so it must be a plain
 *                                                  file name ending in .ps1. Bind it to a workflow
 *                                                  ATTRIBUTE set at build time, so the run record
 *                                                  shows which script was staged.
 *   targetPath       (string)                    - the DIRECTORY on the host the script lives in
 *                                                  and runs from, e.g. 'C:\PSO\Scripts' -- not the
 *                                                  file path; the file name comes from the element.
 *                                                  Absolute local path; a trailing '\' is optional.
 *                                                  Created on first copy if it does not exist.
 *
 * Returns: string - the script's full path on the host, e.g.
 *            'C:\PSO\Scripts\Invoke-ServerDiskClean.ps1'
 *          Bind it to a workflow attribute and from there to invokeStagedScript's scriptPath.
 *          It is returned only once the file at that path has been verified to match the
 *          Resource Element, so a path that came from here is a path that is safe to run.
 *
 * Fails the run (throws) when:
 *   - targetPath is not an absolute local directory path, or the element's name is not a plain
 *     .ps1 file name
 *   - the Resource Element is missing or empty (staging it would replace a working script
 *     with nothing)
 *   - the host probe does not answer (deployed state unknown - overwriting blind is worse
 *     than stopping)
 *   - a chunk is not acknowledged (the target is untouched; only the temp file is partial)
 *   - the post-install hash or length does not match (the file on disk is not the script
 *     this workflow intended to run)
 *
 * NOTE FOR LAB VALIDATION: the plug-in's result accessors differ across versions. psInvoke()
 * reads getHostOutput() first, then getInvocationResult().getRootObject(). Every probe below
 * pipes its output through Out-String, so whichever accessor carries it gets one string.
 */

if (psHost === null || psHost === undefined) {
    throw new Error("stageScriptOnHost: psHost is required. Bind it to the resolved PowerShell host.");
}
if (script === null || script === undefined) {
    throw new Error(
        "stageScriptOnHost: script is required. Bind it to the workflow attribute holding the " +
        "Resource Element with the .ps1."
    );
}

var scriptName = String(script.name).replace(/^\s+|\s+$/g, "");

if (!targetPath || String(targetPath).replace(/^\s+|\s+$/g, "") === "") {
    throw new Error("stageScriptOnHost: targetPath is required -- the directory the script goes in, e.g. 'C:\\PSO\\Scripts'.");
}

// Forward slashes are accepted and normalised; trailing separators are dropped so the join
// below always produces exactly one '\' between directory and file name.
var dirPath = String(targetPath).replace(/^\s+|\s+$/g, "").replace(/\//g, "\\").replace(/\\+$/, "");

// A relative directory resolves against whatever directory the WinRM session started in, so
// the script would land somewhere the invocation does not look for it. A UNC directory would
// make "the copy on the host" a copy somewhere else, reached by a second hop.
if (!/^[a-zA-Z]:(\\|$)/.test(dirPath)) {
    throw new Error(
        "stageScriptOnHost: targetPath must be an absolute local directory path on the host, e.g. " +
        "'C:\\PSO\\Scripts' - got '" + targetPath + "'."
    );
}
if (/(^|\\)\.\.(\\|$)/.test(dirPath) || /[*?"<>|]/.test(dirPath.substring(2))) {
    throw new Error("stageScriptOnHost: targetPath '" + targetPath + "' contains '..' or a character not valid in a path.");
}

// The element's name becomes the file name. A separator in it would put the file somewhere
// other than targetPath, and anything but .ps1 cannot be invoked as a script -- so both
// are refused rather than quietly repaired.
if (scriptName === "" || /[\\\/:*?"<>|]/.test(scriptName)) {
    throw new Error(
        "stageScriptOnHost: the Resource Element is named '" + scriptName + "'. That name becomes the " +
        "file name on the host, so it must be a plain file name with no \\ / : * ? \" < > |. Rename the element."
    );
}
if (!/\.ps1$/i.test(scriptName)) {
    throw new Error(
        "stageScriptOnHost: the Resource Element is named '" + scriptName + "'. It becomes the script's file " +
        "name on the host and must end in .ps1, or PowerShell will not run it. Rename the element."
    );
}

// The one place the full path is built.
var tgtPath = dirPath + "\\" + scriptName;

// ── Load the script from the Resource Element ─────────────────────────────────

var attachment = script.getContentAsMimeAttachment();
if (attachment === null || attachment === undefined ||
    attachment.content === null || attachment.content === undefined ||
    String(attachment.content) === "") {
    throw new Error(
        "stageScriptOnHost: the Resource Element '" + scriptName + "' holds no content. Staging it " +
        "would overwrite a working script on the host with nothing. Re-import the .ps1."
    );
}
var content = String(attachment.content);

// The hash is taken over the bytes THIS action writes, so the host and Orchestrator always
// agree with each other. What that cannot catch is Orchestrator having decoded the imported
// file differently from how it was saved - which only happens to non-ASCII characters. The
// scripts in this family are kept pure ASCII for exactly that reason; flag any that are not.
if (/[^\x00-\x7F]/.test(content.replace(/^\uFEFF/, ""))) {
    System.warn(
        "stageScriptOnHost | '" + scriptName + "' contains non-ASCII characters. They are staged exactly " +
        "as Orchestrator decoded them; if the file was not saved as UTF-8 they may not match the " +
        "repository copy. Keep scripts ASCII-only."
    );
}

var version = "unversioned";
try { if (script.version) { version = "v" + String(script.version); } } catch (eV) { /* not every plug-in version exposes it */ }

// ── Encode and hash ───────────────────────────────────────────────────────────

function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
        var c = str.charCodeAt(i);
        if (c < 0x80) { out.push(c); }
        else if (c < 0x800) { out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F)); }
        else if (c < 0xD800 || c >= 0xE000) { out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F)); }
        else {
            i++;
            var cp = 0x10000 + (((c & 0x3FF) << 10) | (str.charCodeAt(i) & 0x3FF));
            out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
        }
    }
    return out;
}

/**
 * SHA-256 (FIPS 180-4) over a byte array, returned as 64 upper-case hex digits - the same
 * form Get-FileHash prints, so the two compare as plain strings.
 *
 * Written out in JavaScript because the Orchestrator scripting engine does not reliably let
 * actions reach java.security.MessageDigest. It is verified against a reference
 * implementation over empty, block-boundary, multi-byte and full-script inputs.
 */
function sha256Hex(bytes) {
    var K = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

    // Padding: 0x80, zeros to 56 mod 64, then the bit length as a 64-bit big-endian integer.
    var msg = bytes.slice(0);
    var bitLenHi = Math.floor((bytes.length * 8) / 0x100000000);
    var bitLenLo = (bytes.length * 8) >>> 0;
    msg.push(0x80);
    while ((msg.length % 64) !== 56) { msg.push(0); }
    msg.push((bitLenHi >>> 24) & 0xFF, (bitLenHi >>> 16) & 0xFF, (bitLenHi >>> 8) & 0xFF, bitLenHi & 0xFF);
    msg.push((bitLenLo >>> 24) & 0xFF, (bitLenLo >>> 16) & 0xFF, (bitLenLo >>> 8) & 0xFF, bitLenLo & 0xFF);

    function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

    var W = new Array(64);
    for (var off = 0; off < msg.length; off += 64) {
        for (var t = 0; t < 16; t++) {
            W[t] = ((msg[off + t * 4] << 24) | (msg[off + t * 4 + 1] << 16) |
                    (msg[off + t * 4 + 2] << 8) | msg[off + t * 4 + 3]) | 0;
        }
        for (t = 16; t < 64; t++) {
            var s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3);
            var s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10);
            W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
        }
        var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
        for (t = 0; t < 64; t++) {
            var S1  = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            var ch  = (e & f) ^ (~e & g);
            var t1  = (h + S1 + ch + K[t] + W[t]) | 0;
            var S0  = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            var maj = (a & b) ^ (a & c) ^ (b & c);
            var t2  = (S0 + maj) | 0;
            h = g; g = f; f = e; e = (d + t1) | 0;
            d = c; c = b; b = a; a = (t1 + t2) | 0;
        }
        H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
        H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }

    var hex = "";
    for (var i = 0; i < 8; i++) {
        var word = (H[i] >>> 0).toString(16).toUpperCase();
        while (word.length < 8) { word = "0" + word; }
        hex += word;
    }
    return hex;
}

var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64(bytes) {
    var out = "", i = 0;
    for (; i + 2 < bytes.length; i += 3) {
        var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
        out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63) + B64.charAt((n >> 6) & 63) + B64.charAt(n & 63);
    }
    var rem = bytes.length - i;
    if (rem === 1) {
        var n1 = bytes[i] << 16;
        out += B64.charAt((n1 >> 18) & 63) + B64.charAt((n1 >> 12) & 63) + "==";
    } else if (rem === 2) {
        var n2 = (bytes[i] << 16) | (bytes[i + 1] << 8);
        out += B64.charAt((n2 >> 18) & 63) + B64.charAt((n2 >> 12) & 63) + B64.charAt((n2 >> 6) & 63) + "=";
    }
    return out;
}

var bytes   = utf8Bytes(content);
var wantLen = bytes.length;
var wantSha = sha256Hex(bytes);

// One line per run that says which generation of the script this run will execute.
function logStaged(outcome) {
    System.log(
        "stageScriptOnHost | staged: " + tgtPath + " | " + scriptName + " " + version +
        " | sha256=" + wantSha.substring(0, 12) + " | " + outcome
    );
}

// ── Talk to the host ──────────────────────────────────────────────────────────

var useHostCall = (typeof psHost.invokeScript === "function");

/**
 * Runs a short PowerShell snippet on the host and returns everything it printed as one
 * string. The snippet is wrapped so every stream is merged and flattened by Out-String -
 * otherwise the plug-in hands back only the success stream, possibly as a collection.
 */
function psInvoke(snippet) {
    var wrapped = "& {\r\n" + snippet + "\r\n} *>&1 | Out-String -Width 4096";
    var result;
    if (useHostCall) {
        result = psHost.invokeScript(wrapped);
    }
    else {
        var session = psHost.openSession();
        try {
            result = session.invokeScript(wrapped);
        }
        finally {
            try { psHost.closeSession(session.getSessionId()); }
            catch (eC) { System.warn("stageScriptOnHost | could not close PS session: " + eC); }
        }
    }

    var text = "";
    try { text = String(result.getHostOutput() || ""); } catch (e1) { text = ""; }
    if (text.replace(/^\s+|\s+$/g, "") === "") {
        try {
            var returned = result.getInvocationResult();
            var root = (returned === null || returned === undefined) ? null : returned.getRootObject();
            text = (root === null || root === undefined) ? "" : String(root);
        } catch (e2) { text = ""; }
    }
    // Control characters can cross the connection written out as _x000D_ / _x000A_.
    return text.replace(/_x([0-9A-Fa-f]{4})_/g, function (whole, hex) {
        return String.fromCharCode(parseInt(hex, 16));
    });
}

function marked(output, key) {
    var m = new RegExp("^[ \\t]*" + key + "=(.*)$", "m").exec(String(output).replace(/\r/g, ""));
    return m === null ? null : m[1].replace(/^\s+|\s+$/g, "");
}

function snippetOf(text) {
    return (text === "") ? "(empty)" : text.substring(0, 500);
}

var psPath = "'" + tgtPath.replace(/'/g, "''") + "'";

// ── 1. Probe: is it there, and is it the same? ────────────────────────────────

var probe =
    "$ErrorActionPreference = 'Stop'\r\n" +
    "$p = " + psPath + "\r\n" +
    "if (Test-Path -LiteralPath $p -PathType Leaf) {\r\n" +
    "    $h = (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash\r\n" +
    "    $l = (Get-Item -LiteralPath $p).Length\r\n" +
    "    Write-Output ('PSO_PROBE=' + $h + '|' + $l)\r\n" +
    "} else {\r\n" +
    "    Write-Output 'PSO_PROBE=ABSENT'\r\n" +
    "}";

var probeOut = psInvoke(probe);
var probed   = marked(probeOut, "PSO_PROBE");

if (probed === null) {
    throw new Error(
        "stageScriptOnHost: the host did not answer the probe for '" + tgtPath + "', so it is not known " +
        "whether the script there is current. Nothing was copied and nothing was run. Raw output: " +
        snippetOf(probeOut)
    );
}

var outcome;

if (probed === "ABSENT") {
    outcome = "first copy";
    System.log("stageScriptOnHost | '" + tgtPath + "' is not on " + psHost.name + " yet - copying " + scriptName + ".");
}
else {
    var parts  = probed.split("|");
    var hasSha = String(parts[0]).toUpperCase();
    var hasLen = parseInt(parts[1], 10);

    if (hasSha === wantSha && hasLen === wantLen) {
        System.log(
            "stageScriptOnHost | '" + tgtPath + "' on " + psHost.name + " is an exact match for " + scriptName +
            " " + version + " (SHA-256 " + wantSha + ", " + wantLen + " bytes) - nothing copied, the existing copy will run."
        );
        logStaged("unchanged");
        return tgtPath;
    }

    outcome = "updated";
    System.warn(
        "stageScriptOnHost | '" + tgtPath + "' on " + psHost.name + " does NOT match " + scriptName + " " + version +
        ". Host: SHA-256 " + hasSha + ", " + hasLen + " bytes. Orchestrator: SHA-256 " + wantSha + ", " + wantLen +
        " bytes. Overwriting it. (Either the Resource Element was updated, or the copy on the host was edited in place.)"
    );
}

// ── 2. Push the content in chunks to a temp file ──────────────────────────────

var CHUNK   = 48000;
var tmpB64  = "$env:TEMP\\pso-stage-" + System.nextUUID() + ".b64";
var encoded = base64(bytes);
var chunks  = Math.ceil(encoded.length / CHUNK);

System.log("stageScriptOnHost | sending " + wantLen + " bytes as " + chunks + " chunk(s).");

for (var c = 0; c < chunks; c++) {
    var mode = (c === 0) ? "Set-Content" : "Add-Content";
    var push =
        "$ErrorActionPreference = 'Stop'\r\n" +
        "$b64 = @'\r\n" + encoded.substring(c * CHUNK, (c + 1) * CHUNK) + "\r\n'@\r\n" +
        mode + " -LiteralPath \"" + tmpB64 + "\" -Value $b64 -Encoding Ascii -NoNewline\r\n" +
        "Write-Output 'PSO_CHUNK=" + (c + 1) + "/" + chunks + "'";
    var pOut = psInvoke(push);
    if (marked(pOut, "PSO_CHUNK") === null) {
        throw new Error(
            "stageScriptOnHost: chunk " + (c + 1) + " of " + chunks + " was not acknowledged by the host. '" +
            tgtPath + "' has NOT been modified - only the temp file " + tmpB64 + " is affected. Raw output: " +
            snippetOf(pOut)
        );
    }
}

// ── 3. Decode, install atomically, and report what landed ─────────────────────

var install =
    "$ErrorActionPreference = 'Stop'\r\n" +
    "$p    = " + psPath + "\r\n" +
    "$b64f = \"" + tmpB64 + "\"\r\n" +
    "$dir  = Split-Path -Parent $p\r\n" +
    "$new  = Join-Path $dir ('.' + (Split-Path -Leaf $p) + '.' + [guid]::NewGuid().ToString('N') + '.staging')\r\n" +
    "try {\r\n" +
    "    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }\r\n" +
    "    [IO.File]::WriteAllBytes($new, [Convert]::FromBase64String((Get-Content -LiteralPath $b64f -Raw)))\r\n" +
    "    Move-Item -LiteralPath $new -Destination $p -Force\r\n" +
    "    $h = (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash\r\n" +
    "    $l = (Get-Item -LiteralPath $p).Length\r\n" +
    "    Write-Output ('PSO_INSTALLED=' + $h + '|' + $l)\r\n" +
    "} finally {\r\n" +
    "    Remove-Item -LiteralPath $b64f -Force -ErrorAction SilentlyContinue\r\n" +
    "    Remove-Item -LiteralPath $new  -Force -ErrorAction SilentlyContinue\r\n" +
    "}";

var iOut      = psInvoke(install);
var installed = marked(iOut, "PSO_INSTALLED");

if (installed === null) {
    throw new Error(
        "stageScriptOnHost: the install step did not report back, so it is not known whether '" + tgtPath +
        "' was replaced. Check the file on the host before running anything against it. Raw output: " +
        snippetOf(iOut)
    );
}

// Verify what landed rather than trusting that it did. A staging step that reports success
// while leaving the previous generation in place is worse than no staging at all, because
// the run would then claim to have used a script it did not.
var got    = installed.split("|");
var gotSha = String(got[0]).toUpperCase();
var gotLen = parseInt(got[1], 10);

if (gotSha !== wantSha || gotLen !== wantLen) {
    throw new Error(
        "stageScriptOnHost: verification failed after staging '" + tgtPath + "'. Expected SHA-256 " + wantSha +
        " (" + wantLen + " bytes); the host reports " + gotSha + " (" + gotLen + " bytes). Do not run against " +
        "this host until the discrepancy is understood - the file on disk is not the script this workflow intended to run."
    );
}

System.log(
    "stageScriptOnHost | " + outcome + ": " + scriptName + " " + version + " written to '" + tgtPath + "' on " +
    psHost.name + " and verified (SHA-256 " + wantSha + ", " + wantLen + " bytes)."
);
logStaged(outcome);
return tgtPath;
