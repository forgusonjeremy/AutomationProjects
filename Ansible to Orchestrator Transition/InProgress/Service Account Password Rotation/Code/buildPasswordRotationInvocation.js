/**
 * Action: buildPasswordRotationInvocation
 * Module:  com.broadcom.pso.vcf.identity.ad.accounts.passwordRotation
 *
 * vRO input-parameter order (positional call from the workflow):
 *   (scriptPath, samAccountName, domainServer, ldapBaseDN, passwordLength, whatIf)
 *
 * Purpose:
 *   Builds the PowerShell invocation for the SERVICE ACCOUNT PASSWORD ROTATION
 *   (Set-ServiceAccountPassword in cvs_functions.ps1, added by Change-Register S-25).
 *
 *   THIS ACTION WRITES. It is the first write-path transition in this family - every
 *   prior one (admin report, expiry report, reboot report, datastore report) was
 *   read-only. Two consequences run through the whole design:
 *
 *     1. It carries a whatIf gate, in the same shape as clean-ServerDisk.
 *     2. The invocation string is logged, but ONLY because it deliberately carries
 *        no secret. See below - that is a design decision, not an accident.
 *
 * ── The password is generated on the PowerShell host, not here ────────────────
 *
 *   The obvious port of the Ansible original generates the password in Orchestrator
 *   and passes it down to PowerShell. That is rejected for two reasons.
 *
 *   FIRST - ENTROPY. The playbook used ansible.builtin.password, which draws on the
 *   controller's CSPRNG. vRO's JavaScript engine offers Math.random(), which is a
 *   plain PRNG with a small internal state seeded from the clock. Length does not
 *   rescue it: a 34-character password drawn from Math.random() has the entropy of
 *   the generator's seed, not of its alphabet, and the rotation time is recorded in
 *   run history. Generating on the host lets the script use
 *   System.Security.Cryptography.RandomNumberGenerator, which is a real CSPRNG.
 *
 *   SECOND - EXPOSURE. A password passed DOWN appears in the invocation string, and
 *   the invocation string is the single most-logged value in this whole family of
 *   actions - buildServiceAccountExpirationInvocation logs it verbatim, and the OOTB
 *   'Invoke a PowerShell script' workflow surfaces it as a token variable. Every one
 *   of those exposures has to be individually suppressed and stay suppressed. A
 *   password that travels UPWARD instead has exactly one exposure point to control:
 *   the script output, handled in extractRotatedPassword.
 *
 *   So: nothing secret goes down. The invocation below is safe to log in full, and
 *   is logged in full, which keeps this action consistent with its siblings.
 *
 * ── whatIf ────────────────────────────────────────────────────────────────────
 *
 *   whatIf=true resolves the account, checks it is exactly where ldapBaseDN says it
 *   is, and reports what WOULD be rotated - without generating a password or
 *   touching AD. It returns no secret, so the workflow's store step is skipped.
 *
 *   Note this differs from the Ansible original, which had no dry-run mode at all:
 *   running the job template WAS the rotation. Operators verifying scope on the old
 *   system had no option but to rotate for real.
 *
 * Inputs:
 *   scriptPath     (string)        - Full path to cvs_functions.ps1 on the PS host
 *   samAccountName (string)        - Account to rotate            -> -SamAccountName
 *   domainServer   (string)        - DC to target                 -> -DomainServer
 *   ldapBaseDN     (string)        - Expected OU, used as search base -> -OUPath
 *   passwordLength (number/string) - Generated length             -> -PasswordLength
 *   whatIf         (boolean)       - Report only, do not rotate   -> -WhatIfMode ('yes'/'no')
 *
 * Return type: string
 */

// ── Input validation ──────────────────────────────────────────────────────────

if (!scriptPath || String(scriptPath).trim() === "") {
    throw new Error("buildPasswordRotationInvocation: scriptPath is required and must not be empty.");
}
if (!samAccountName || String(samAccountName).trim() === "") {
    throw new Error("buildPasswordRotationInvocation: samAccountName is required - it identifies the account whose password is reset.");
}
if (!domainServer || String(domainServer).trim() === "") {
    throw new Error("buildPasswordRotationInvocation: domainServer is required - the rotation must target a specific DC so the change is not left to discovery.");
}
if (!ldapBaseDN || String(ldapBaseDN).trim() === "") {
    throw new Error("buildPasswordRotationInvocation: ldapBaseDN is required - it constrains the account lookup to the OU the account is supposed to live in.");
}

var sam = String(samAccountName).trim();
var dc  = String(domainServer).trim();
var ou  = String(ldapBaseDN).trim();

// A sAMAccountName is a single token. Anything with a space, a DN separator or an
// '@' means a UPN or a DN was supplied instead - both of which AD would fail to
// resolve as an identity, but only after the run had already started.
if (/[\s,=]/.test(sam) || sam.indexOf("@") !== -1) {
    throw new Error(
        "buildPasswordRotationInvocation: samAccountName '" + sam + "' does not look like a sAMAccountName - " +
        "it contains a space, ',', '=' or '@'. Supply the short logon name (e.g. 'svcacct1'), not the UPN " +
        "or the distinguishedName. The UPN is stored separately on the Configuration Element and is used by " +
        "consumers, not by the reset."
    );
}

if (ou.toUpperCase().indexOf("DC=") === -1) {
    throw new Error(
        "buildPasswordRotationInvocation: ldapBaseDN '" + ou + "' is not a distinguishedName - it has no " +
        "'DC=' component and cannot be used as a search base."
    );
}

// ── Password length ───────────────────────────────────────────────────────────
//
// The Ansible original produced 'J1M!_' + 34 random alphanumerics: 39 characters, of
// which the first five were a FIXED literal present on every account in the estate.
// The fixed prefix existed to guarantee complexity - the random tail was
// alphanumeric only, so without it a generated password could fail a policy
// requiring a symbol.
//
// The replacement (S-25) guarantees complexity by CONSTRUCTION - the script draws at
// least one character from each required class and shuffles - so no fixed literal is
// needed and none is used. Length here is therefore all-random, and 34 is kept as
// the default so the stored password is no shorter than what it replaces.

var length = 34;
if (passwordLength !== null && passwordLength !== undefined && String(passwordLength).trim() !== "") {
    var rawLength = String(passwordLength).trim();
    if (!/^\d+$/.test(rawLength)) {
        throw new Error(
            "buildPasswordRotationInvocation: passwordLength must be a whole number - got '" + rawLength + "'."
        );
    }
    length = parseInt(rawLength, 10);

    if (length < 20) {
        throw new Error(
            "buildPasswordRotationInvocation: passwordLength " + length + " is too short for an unattended " +
            "service account that no human ever types. Minimum 20. The default of 34 matches the length the " +
            "Ansible job templates produced."
        );
    }
    // 256 is the AD limit for a password set through the directory. Values above it
    // are rejected by AD itself, after the script has already generated one.
    if (length > 256) {
        throw new Error(
            "buildPasswordRotationInvocation: passwordLength " + length + " exceeds the 256-character " +
            "Active Directory limit."
        );
    }
}

var dryRun = (whatIf === true);

// ── Build invocation string ───────────────────────────────────────────────────
//
// Script parameters per the cvs_functions.ps1 param block as extended by S-25:
//   -Action          'Set-ServiceAccountPassword'  (added to the ValidateSet by S-25)
//   -SamAccountName  <- sam
//   -DomainServer    <- dc
//   -OUPath          <- ou      (existing parameter, reused as the search base)
//   -PasswordLength  <- length
//   -WhatIfMode      <- 'yes' / 'no'
//
// S-25 NOTE: adding a WRITE action to the -Action ValidateSet is exactly the class of
// change the script's own header warns about, in the note explaining why
// Set-L3-Admin-Accounts is deliberately absent from that list. Adding
// Set-ServiceAccountPassword is that separate, reviewed change - it is scoped to ONE
// account per invocation, named explicitly, with no filter-based mass path.

function psQuote(value) {
    return "'" + String(value === null || value === undefined ? "" : value).replace(/'/g, "''") + "'";
}

// Stream capture ( *>&1 | Out-String -Width 4096 ) as per the rest of the family:
// the script reports through Write-Log -> Write-Host, which the vRO PowerShell plugin
// logs but does not return. '*>&1' merges all streams into the success stream so
// getRootObject() has something to hand back. -Width 4096 stops long lines wrapping.
//
// The generated password is emitted by the script on its own single marked line
// within this same stream, and is stripped by extractRotatedPassword BEFORE the
// transcript is logged anywhere. See that action for the handling contract.

var invocationString =
    "& \"" + String(scriptPath).trim() + "\"" +
    " -Action 'Set-ServiceAccountPassword'" +
    " -SamAccountName " + psQuote(sam) +
    " -DomainServer " + psQuote(dc) +
    " -OUPath " + psQuote(ou) +
    " -PasswordLength '" + length + "'" +
    " -WhatIfMode '" + (dryRun ? "yes" : "no") + "'" +
    " *>&1 | Out-String -Width 4096";

System.log(
    "buildPasswordRotationInvocation | scriptPath=" + scriptPath +
    " | samAccountName=" + sam +
    " | domainServer=" + dc +
    " | ouPath=" + ou +
    " | passwordLength=" + length +
    " | whatIf=" + dryRun
);

// Logged in full, deliberately: this string carries no secret (see the header). If a
// future change ever puts a password into it, this line must be removed in the same
// commit - and extractRotatedPassword's contract revisited, because the reason the
// secret travels upward only is to keep this line safe.
System.log("buildPasswordRotationInvocation | invocationString=" + invocationString);

if (dryRun) {
    System.warn(
        "buildPasswordRotationInvocation | whatIf=true - NO password will be generated and NO password will " +
        "be changed. The run reports what would be rotated and leaves both Active Directory and the " +
        "credential store untouched."
    );
}

return invocationString;
