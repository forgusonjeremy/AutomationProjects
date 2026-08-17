/**
 * Action: extractRotatedPassword
 * Module:  com.broadcom.pso.vcf.identity.ad.accounts.passwordRotation
 *
 * vRO input-parameter order (positional call from the workflow):
 *   (scriptOutput, samAccountName, whatIf)
 *
 * Purpose:
 *   THE SINGLE EXPOSURE POINT FOR THE ROTATED PASSWORD.
 *
 *   Takes the raw PowerShell transcript from the rotation, lifts the generated
 *   password off its marked line, and returns the password separately from a
 *   SANITISED transcript with that line removed.
 *
 *   Everything downstream - logging, the run summary, parseScriptOutput's
 *   classification, anything an operator reads - consumes the sanitised transcript.
 *   The password itself goes to exactly one place: setServiceAccountPassword.
 *
 * ── Handling contract (read before changing anything in here) ─────────────────
 *
 *   The whole design funnels the secret through this one action so there is one
 *   place to get right instead of many. That only holds if these rules hold:
 *
 *     1. The RAW scriptOutput is NEVER logged, by this action or by the workflow.
 *        The workflow must bind the invoke step's output straight into this action
 *        and log only what comes back out.
 *     2. The raw output must NOT be bound to a workflow OUTPUT parameter, or it
 *        lands in run history in full.
 *     3. The returned password must be bound to a SecureString variable.
 *     4. Sanitising is fail-closed: if the marker is found but cannot be parsed,
 *        this action throws rather than passing a transcript through that might
 *        still contain the secret.
 *
 *   S-25 carries the matching obligation on the PowerShell side: the secret line is
 *   written to the SUCCESS STREAM ONLY. It is not passed through Write-Log, so it
 *   never reaches the Debug transcript file the script leaves on the PS host.
 *
 * ── Marker format ─────────────────────────────────────────────────────────────
 *
 *   The script emits, on a line of its own:
 *
 *     ##VRO-SECRET-BEGIN##<password>##VRO-SECRET-END##
 *
 *   Chosen so the delimiters cannot occur in a generated password (the alphabet
 *   excludes '#') and so a partially-written line still matches the BEGIN marker and
 *   trips the fail-closed path rather than slipping through.
 *
 * Inputs:
 *   scriptOutput   (string)  - Raw transcript from the invoke step. NEVER LOG THIS.
 *   samAccountName (string)  - Account being rotated, for error messages
 *   whatIf         (boolean) - True if the run was a dry run (no secret expected)
 *
 * Returns: Properties
 *   password           (string) - the generated password, '' on a whatIf run
 *   sanitizedOutput    (string) - transcript with the secret line removed; safe to log
 *   passwordFound      (boolean)
 */

// ── Input validation ──────────────────────────────────────────────────────────

var account = (samAccountName === null || samAccountName === undefined) ? "(unknown)" : String(samAccountName).trim();
var dryRun  = (whatIf === true);

if (scriptOutput === null || scriptOutput === undefined || String(scriptOutput) === "") {
    throw new Error(
        "extractRotatedPassword: the PowerShell step returned no output for '" + account + "'. The rotation " +
        "cannot be confirmed either way - Active Directory may or may not have been changed. Check the " +
        "PowerShell host's Debug transcript for this run before re-running. An empty return usually means " +
        "the invocation failed before the script started (bad scriptPath, or the PS host session died)."
    );
}

var raw = String(scriptOutput);

var BEGIN = "##VRO-SECRET-BEGIN##";
var END   = "##VRO-SECRET-END##";

// ── Locate the secret ─────────────────────────────────────────────────────────
//
// Split into lines first so the secret is removed as a WHOLE LINE. Cutting only the
// marked substring would leave the surrounding line in place, and any change to what
// the script prints around the markers could then leak fragments.

var lines = raw.split(/\r\n|\r|\n/);
var password = "";
var secretLines = 0;
var kept = [];

for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var beginAt = line.indexOf(BEGIN);

    if (beginAt === -1) {
        kept.push(line);
        continue;
    }

    // From here on this line is DISCARDED regardless of what happens - it matched the
    // BEGIN marker, so it is treated as carrying a secret even if it turns out to be
    // malformed. That is the fail-closed rule.
    secretLines++;

    var endAt = line.indexOf(END, beginAt + BEGIN.length);
    if (endAt === -1) {
        throw new Error(
            "extractRotatedPassword: found the secret BEGIN marker on line " + (i + 1) + " of the transcript " +
            "for '" + account + "' but no END marker on the same line. The password cannot be read, and the " +
            "transcript cannot be certified clean, so neither is passed on. THE AD PASSWORD MAY ALREADY HAVE " +
            "BEEN CHANGED - re-run the rotation to bring the store back into agreement with AD. If this " +
            "recurs, the line was probably wrapped: check that the invocation still ends with " +
            "'Out-String -Width 4096'."
        );
    }

    var candidate = line.substring(beginAt + BEGIN.length, endAt);

    if (candidate === "") {
        throw new Error(
            "extractRotatedPassword: the secret markers on line " + (i + 1) + " for '" + account + "' are " +
            "empty - the script reported a rotation but emitted no password. Do not treat this as success. " +
            "Check the Set-ServiceAccountPassword branch on the PS host."
        );
    }

    if (password !== "" && password !== candidate) {
        throw new Error(
            "extractRotatedPassword: the transcript for '" + account + "' contains TWO DIFFERENT passwords. " +
            "Refusing to guess which one Active Directory accepted - storing the wrong one would lock the " +
            "account out of every consumer. Re-run the rotation."
        );
    }

    password = candidate;
}

var sanitizedOutput = kept.join("\n");

// ── Cross-check against the run mode ──────────────────────────────────────────

if (dryRun) {
    if (secretLines > 0) {
        // A whatIf run that produced a password means the script ignored the gate and
        // very likely changed AD. Loud, because the operator asked for a dry run and
        // the store is about to be left behind.
        throw new Error(
            "extractRotatedPassword: whatIf=true but the script for '" + account + "' emitted a password. " +
            "The dry-run gate was not honoured and Active Directory has probably been changed WITHOUT the " +
            "credential store being updated. Verify the account immediately and run a real rotation to " +
            "resynchronise. This is a defect in the Set-ServiceAccountPassword branch, not a configuration issue."
        );
    }
    System.log("extractRotatedPassword | whatIf run for '" + account + "' - no password generated, nothing to store.");
    return {
        password: "",
        sanitizedOutput: sanitizedOutput,
        passwordFound: false
    };
}

if (secretLines === 0) {
    throw new Error(
        "extractRotatedPassword: no password found in the transcript for '" + account + "' on a live " +
        "rotation. Either the script failed before generating one - in which case AD is unchanged and the " +
        "stored credential is still valid - or it rotated and failed to report the value, in which case AD " +
        "has moved and the password is LOST. Read the sanitised transcript in the workflow log to tell " +
        "which. If the script reported success, treat the password as lost and re-run the rotation."
    );
}

// ── Sanity checks on the recovered value ──────────────────────────────────────
//
// By length and character class only. The value is never logged, never returned in a
// message, and never compared against anything derived from it.

if (password.indexOf(" ") !== -1 || password.indexOf("\t") !== -1) {
    throw new Error(
        "extractRotatedPassword: the recovered password for '" + account + "' contains whitespace, which the " +
        "generator's alphabet excludes. The value has been corrupted in transit - most likely the transcript " +
        "line wrapped. Do not store it. THE AD PASSWORD HAS ALREADY BEEN CHANGED; re-run the rotation."
    );
}

if (password.length < 20) {
    throw new Error(
        "extractRotatedPassword: the recovered password for '" + account + "' is only " + password.length +
        " characters, shorter than the enforced minimum. It has been truncated in transit and does not match " +
        "what AD was given. Do not store it - re-run the rotation."
    );
}

System.log(
    "extractRotatedPassword | recovered a " + password.length + "-character password for '" + account +
    "' | secret lines stripped from transcript=" + secretLines +
    " | transcript lines retained=" + kept.length
);

return {
    password: password,
    sanitizedOutput: sanitizedOutput,
    passwordFound: true
};
