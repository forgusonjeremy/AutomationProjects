/**
 * Action: stageScriptOnHost
 * Module:  com.broadcom.pso.vcf.powershell.staging
 *
 * vRO input-parameter order (positional call from the workflow):
 *   (psHost, resourcePath, targetPath)
 *
 * Purpose:
 *   Copies a .ps1 held in a vRO Resource Element onto the PowerShell host, over the same
 *   WinRM session the workflow is about to invoke it through. The direct analogue of the
 *   playbooks' `win_copy: src=files/ps_scripts`.
 *
 *   This is what restores the property the transition was about to lose: GitLab holds the
 *   script, CI syncs it into the Resource Element, and every run copies the current one.
 *   Update it in one place and it takes effect wherever it runs - which is the whole reason
 *   the Ansible version copies a file it could have pre-staged.
 *
 * ── Copies on EVERY run, deliberately ─────────────────────────────────────────
 *   No hash, no version marker, no "has it changed" comparison. Ansible copies every run;
 *   so does this. That decision buys three things worth more than the bytes it costs:
 *
 *     - Nothing to stamp. A version-marker scheme needs the CI job to write a marker into
 *       every script before this action will accept it, and "who owns that CI job" is still
 *       an open question. Copying unconditionally has no such prerequisite.
 *     - Nothing to drift. There is no state on the host that can disagree with the
 *       Resource Element, because it is overwritten before it is used.
 *     - Nothing to diagnose. "Which generation ran" is the Resource Element version logged
 *       below, and it was written to disk seconds before the script ran.
 *
 *   The cost is small: cvs_admin.ps1 is ~17 KB (~23 KB base64, one chunk). The playbooks
 *   currently copy the ENTIRE ps_scripts folder - all ~25 scripts, ~600 KB - on every run,
 *   to execute one of them. This copies the one script the workflow needs.
 *
 * ── Transport ─────────────────────────────────────────────────────────────────
 *   The PowerShell plug-in has no file-transfer call, so the content goes as base64 inside
 *   the invocation string and is decoded on the host. The base64 alphabet contains no
 *   quote, backtick or $, so each chunk sits safely in a single-quoted here-string with no
 *   escaping to get wrong.
 *
 *   Chunked at 48000 characters: WinRM's default MaxEnvelopeSizekb is 500 KB, so this stays
 *   an order of magnitude inside it, and the largest script in this family
 *   (cvs_function_formatted_email.ps1, ~60 KB -> ~80 KB base64) is two chunks. State lives
 *   in a file on the host between chunks, not in session variables, so this does not
 *   require Shared Session mode.
 *
 * Inputs:
 *   psHost       (PowerShell:PowerShellHost) - the host to copy to. NOTE: for a multi-domain
 *                                              estate this is the host object for the DOMAIN
 *                                              IDENTITY the run needs (P-52) - all such
 *                                              objects point at the same pool and share one
 *                                              filesystem, so any of them stages for all
 *   resourcePath (string) - Resource Element path, e.g. 'PSO/Scripts/cvs_admin.ps1'
 *   targetPath   (string) - absolute path on the host, e.g. 'C:\PSO\Scripts\cvs_admin.ps1'
 *
 * Returns: string - a run-record label for the staged script, 'PSO/Scripts/cvs_admin.ps1@<version>'.
 *                   Bind it to a workflow OUTPUT: it is the answer to "which generation of
 *                   the script did that run use?", which the pre-staged design could not
 *                   answer at all (Master-Change-Register.md:217).
 *
 * NOTE FOR LAB VALIDATION: the PowerShell plug-in's result accessors differ across plug-in
 * versions. psInvoke() tries getHostOutput(), then getInvocationResult(), then
 * getRootObject(). Confirm which carries output on the deployed plug-in before relying on
 * the verification step.
 */

if (psHost === null || psHost === undefined) { throw new Error("stageScriptOnHost: psHost is required."); }
if (!resourcePath || String(resourcePath).trim() === "") {
    throw new Error("stageScriptOnHost: resourcePath is required, e.g. 'PSO/Scripts/cvs_admin.ps1'.");
}
if (!targetPath || String(targetPath).trim() === "") {
    throw new Error("stageScriptOnHost: targetPath is required, e.g. 'C:\\PSO\\Scripts\\cvs_admin.ps1'.");
}

var resPath = String(resourcePath).trim().replace(/^\/+|\/+$/g, "");
var tgtPath = String(targetPath).trim();

// A relative target resolves against whatever directory the WinRM session started in, so
// the script would land somewhere the invocation does not look for it.
if (!/^[a-zA-Z]:\\/.test(tgtPath) && tgtPath.indexOf("\\\\") !== 0) {
    throw new Error(
        "stageScriptOnHost: targetPath must be an absolute Windows path (e.g. " +
        "'C:\\PSO\\Scripts\\cvs_admin.ps1') or a UNC path - got '" + tgtPath + "'."
    );
}

// ── Load the script from the Resource Element ─────────────────────────────────

var slash = resPath.lastIndexOf("/");
if (slash === -1) {
    throw new Error("stageScriptOnHost: resourcePath must include the category, e.g. 'PSO/Scripts/cvs_admin.ps1' - got '" + resPath + "'.");
}
var catPath = resPath.substring(0, slash);
var resName = resPath.substring(slash + 1);

var category = Server.getResourceElementCategoryWithPath(catPath);
if (category === null || category === undefined) {
    throw new Error("stageScriptOnHost: resource element category '" + catPath + "' not found. Create it and import the script.");
}

var element  = null;
var siblings = category.resourceElements || [];
for (var e = 0; e < siblings.length; e++) {
    if (String(siblings[e].name) === resName) { element = siblings[e]; break; }
}
if (element === null) {
    var names = [];
    for (var n = 0; n < siblings.length; n++) { names.push(String(siblings[n].name)); }
    throw new Error(
        "stageScriptOnHost: resource element '" + resName + "' not found in '" + catPath + "'. Present: " +
        (names.length ? names.join(", ") : "(none)") + "."
    );
}

var content = String(element.getContentAsMimeAttachment().content);
if (content === "") {
    throw new Error(
        "stageScriptOnHost: resource element '" + resPath + "' is empty. Staging it would overwrite a working " +
        "script on the host with nothing."
    );
}

var version = "unversioned";
try { if (element.version) { version = String(element.version); } } catch (eV) { /* not all plug-in versions expose it */ }
var label = resPath + "@" + version;

// ── Encode ────────────────────────────────────────────────────────────────────

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
var encoded = base64(bytes);

// ── Talk to the host ──────────────────────────────────────────────────────────

function psInvoke(script) {
    var session = null;
    try {
        session = psHost.openSession();
        var result = session.invokeScript(script);
        var text = null;
        try { if (result && typeof result.getHostOutput === "function") { text = result.getHostOutput(); } } catch (e1) {}
        if (text === null || text === undefined || String(text) === "") {
            try { if (result && typeof result.getInvocationResult === "function") { text = result.getInvocationResult(); } } catch (e2) {}
        }
        if (text === null || text === undefined || String(text) === "") {
            try { if (result && typeof result.getRootObject === "function") { text = result.getRootObject(); } } catch (e3) {}
        }
        return String(text === null || text === undefined ? "" : text);
    } finally {
        if (session !== null) {
            try { psHost.closeSession(session.getSessionId()); }
            catch (eC) { System.warn("stageScriptOnHost | could not close PS session: " + eC); }
        }
    }
}

function marked(output, key) {
    var m = new RegExp("^[ \\t]*" + key + "=(.*)$", "m").exec(String(output).replace(/\r/g, ""));
    return m === null ? null : m[1].trim();
}

// ── Push ──────────────────────────────────────────────────────────────────────

var CHUNK  = 48000;
var tmpB64 = "$env:TEMP\\pso-stage-" + System.nextUUID() + ".b64";
var chunks = Math.ceil(encoded.length / CHUNK);

System.log("stageScriptOnHost | staging " + label + " (" + wantLen + " bytes) to '" + tgtPath + "' as " + chunks + " chunk(s).");

for (var c = 0; c < chunks; c++) {
    var mode = (c === 0) ? "Set-Content" : "Add-Content";
    var push =
        "$ErrorActionPreference='Stop';" +
        "$b64=@'\n" + encoded.substring(c * CHUNK, (c + 1) * CHUNK) + "\n'@;" +
        mode + " -LiteralPath \"" + tmpB64 + "\" -Value $b64 -Encoding Ascii -NoNewline;" +
        "Write-Output ('PSO_CHUNK=" + (c + 1) + "/" + chunks + "')";
    var pOut = psInvoke(push);
    if (marked(pOut, "PSO_CHUNK") === null) {
        throw new Error(
            "stageScriptOnHost: chunk " + (c + 1) + " of " + chunks + " was not acknowledged by the host, so " +
            "the staged file is incomplete. '" + tgtPath + "' has NOT been modified - only the temp file " +
            tmpB64 + " is affected. Raw output: " + (pOut === "" ? "(empty)" : pOut.substring(0, 500))
        );
    }
}

// Decode and install. The target is written only after the decode succeeds, and via a
// sibling temp file + Move, so an interrupted push cannot leave a half-written script where
// the next run would execute it.
var install =
    "$ErrorActionPreference='Stop';" +
    "$p='" + tgtPath.replace(/'/g, "''") + "';" +
    "$b64f=\"" + tmpB64 + "\";" +
    "$new = $p + '.staging';" +
    "try {" +
    "  $dir = Split-Path -Parent $p;" +
    "  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }" +
    "  [IO.File]::WriteAllBytes($new, [Convert]::FromBase64String((Get-Content -LiteralPath $b64f -Raw)));" +
    "  Move-Item -LiteralPath $new -Destination $p -Force;" +
    "  Write-Output ('PSO_LEN=' + (Get-Item -LiteralPath $p).Length);" +
    "} finally {" +
    "  Remove-Item -LiteralPath $b64f -Force -ErrorAction SilentlyContinue;" +
    "  Remove-Item -LiteralPath $new  -Force -ErrorAction SilentlyContinue;" +
    "}";

var iOut   = psInvoke(install);
var gotRaw = marked(iOut, "PSO_LEN");

if (gotRaw === null) {
    throw new Error(
        "stageScriptOnHost: the install step returned no PSO_LEN line, so it is not known whether '" + tgtPath +
        "' was replaced. Check the file on the host before running the report. Raw output: " +
        (iOut === "" ? "(empty)" : iOut.substring(0, 500))
    );
}

// Verify what landed rather than trusting that it did. A staging step that reports success
// while leaving the previous generation in place is worse than no staging at all, because
// the run then claims to have used a script it did not.
var gotLen = parseInt(gotRaw, 10);
if (gotLen !== wantLen) {
    throw new Error(
        "stageScriptOnHost: verification failed after staging '" + tgtPath + "'. Expected " + wantLen +
        " bytes, the host reports " + gotLen + ". Do not run against this host until the discrepancy is " +
        "understood - the file on disk is not the script this workflow intended to run."
    );
}

System.log("stageScriptOnHost | staged " + label + " to '" + tgtPath + "' (" + wantLen + " bytes verified).");
return label;
