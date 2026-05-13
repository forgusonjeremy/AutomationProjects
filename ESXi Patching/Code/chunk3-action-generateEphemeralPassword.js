// ===================================================================
// ACTION:    generateEphemeralPassword
// MODULE:    com.broadcom.pso.vc.esxi.remediation.account
// PURPOSE:   Generate a cryptographically-suitable random password
//            for an ephemeral ESXi local account. The password
//            lives only in workflow memory for the duration of one
//            host's 14-phase procedure; it is never persisted and
//            it is destroyed with the account at AUTH_CLEANUP.
//
// PHASE:     AUTH_PROVISION (called once per host)
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-ACCOUNT]
//
// INPUTS:
//   length (number) — Desired password length. Must be in [16, 64].
//                     Default 24 if omitted or out of range.
//
// RETURNS: SecureString — Random password meeting ESXi 8.x default
//                          policy: at least 1 lowercase, 1 uppercase,
//                          1 digit, 1 special character; minimum 14
//                          characters. (We default to 24 for margin.)
//
// REQUIREMENT TRACE:
//   Implements: AD-08 (ephemeral credentials), NFR-11 (passwords in
//               SecureString form).
//
// NOTES:
//   - Java SecureRandom is the source of randomness — accessed via
//     vRO's java.security.SecureRandom Rhino bridge. SecureRandom
//     is the right choice for credential generation; Math.random()
//     is NOT.
//   - Character classes used:
//       lowercase: a-z (excluding ambiguous l)
//       uppercase: A-Z (excluding ambiguous I, O)
//       digits:    0-9 (excluding ambiguous 0, 1)
//       specials:  !@#$%^&*()-_=+[]{};:,.<>?
//     Ambiguous characters are excluded to make the password less
//     painful when manually typed (rare but possible for
//     diagnostic recovery).
//   - The function GUARANTEES at least one character from each
//     class by reserving one slot per class up front, then filling
//     the rest from the union. Final shuffle ensures the reserved
//     positions are not predictable.
//   - The return type is SecureString — vRO will tag this on
//     output and log redaction will mask it as ******** in audit
//     logs by default. Callers passing it onward (e.g. into an
//     SSHSession.connectWithPassword) will work transparently.
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-ACCOUNT]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

var length = arguments.length >= 1 ? arguments[0] : 24;
if (typeof length !== "number" || length < 16 || length > 64) {
    length = 24;
}

// -------------------------------------------------------------------
// Character classes. Ambiguous characters (l, 0, 1, I, O) excluded.
// -------------------------------------------------------------------

var LOWERS  = "abcdefghijkmnopqrstuvwxyz";
var UPPERS  = "ABCDEFGHJKLMNPQRSTUVWXYZ";
var DIGITS  = "23456789";
var SPECIAL = "!@#$%^&*()-_=+[]{};:,.<>?";

// -------------------------------------------------------------------
// Get Java SecureRandom via Rhino's Packages bridge.
// -------------------------------------------------------------------

var SecureRandom = Packages.java.security.SecureRandom;
var rng = new SecureRandom();

// Helper: pick a random char from a string using SecureRandom.
function pickChar(charset) {
    var idx = rng.nextInt(charset.length);
    return charset.charAt(idx);
}

// -------------------------------------------------------------------
// Reserve one character per class, then fill remainder from union,
// then shuffle.
// -------------------------------------------------------------------

var chars = [];
chars.push(pickChar(LOWERS));
chars.push(pickChar(UPPERS));
chars.push(pickChar(DIGITS));
chars.push(pickChar(SPECIAL));

var ALL = LOWERS + UPPERS + DIGITS + SPECIAL;
while (chars.length < length) {
    chars.push(pickChar(ALL));
}

// Fisher-Yates shuffle so the reserved class characters are not
// always at positions 0..3.
for (var i = chars.length - 1; i > 0; i--) {
    var j = rng.nextInt(i + 1);
    var tmp = chars[i];
    chars[i] = chars[j];
    chars[j] = tmp;
}

var password = chars.join("");

// Do NOT log the password value or any portion. Length is fine.
auditLogger.auditLog(
    LOG_PREFIX, "AUTH_PROVISION", "OK",
    "Generated ephemeral password | length=" + length
);

return password;
