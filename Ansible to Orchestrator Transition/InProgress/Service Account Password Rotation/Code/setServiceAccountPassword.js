/**
 * Action: setServiceAccountPassword
 * Module:  com.broadcom.pso.vcf.identity.ad.accounts.passwordRotation
 *
 * vRO input-parameter order (positional call from the workflow):
 *   (categoryPath, accountName, newPassword)
 *
 * Purpose:
 *   THE WRITE HALF OF THE CREDENTIAL OBJECT STORE.
 *
 *   Commits a newly rotated password into the account's Configuration Element and
 *   stamps passwordLastRotated. Called ONLY after Active Directory has confirmed
 *   the change - see the ordering note below, which is the single most important
 *   design decision in this workflow.
 *
 * ── Ordering: AD first, store second ──────────────────────────────────────────
 *
 *   AD is the source of truth. The Configuration Element is a cache of it. There is
 *   no transaction spanning the two, so one of them is always updated first and a
 *   failure between the two leaves them disagreeing. The question is only which
 *   disagreement is cheaper.
 *
 *     Store first, then AD fails  -> the store holds a password AD never accepted.
 *                                    EVERY consumer workflow now fails to
 *                                    authenticate, and repeated attempts lock the
 *                                    account out. Worst case.
 *
 *     AD first, then store fails  -> the store holds the PREVIOUS password, which
 *                                    AD no longer accepts. Consumers fail, but the
 *                                    account is not being hammered with a password
 *                                    that was never valid.
 *
 *   Both are bad; the second is less bad and, crucially, both are repaired by the
 *   same action: RE-RUN THE ROTATION. A rotation is idempotent in effect - it
 *   generates a fresh password, sets it in AD, and stores it - so a half-completed
 *   run is corrected by running it again, not by manual recovery. That property is
 *   why no compensating rollback is implemented here, and it is worth preserving in
 *   any future change.
 *
 *   The window is kept as short as possible: this action does nothing but write.
 *   All validation that could fail happens in getServiceAccountCredential, BEFORE
 *   AD is touched.
 *
 * ── Why the attribute must already exist as SecureString ──────────────────────
 *
 *   setAttributeWithKey(key, value) writes into the attribute already declared on
 *   the element and leaves its declared type alone. That is the behaviour this
 *   action depends on: the element is provisioned with 'password' typed
 *   SecureString at deployment time, and every rotation thereafter writes through
 *   that declaration, so the value is encrypted at rest and masked in the editor
 *   without this code having to assert a type on each write.
 *
 *   A 'password' attribute that does not already exist, or exists as a plain
 *   string, is rejected - by getServiceAccountCredential on read, and again here on
 *   write. Creating it on the fly is deliberately NOT done: an attribute created
 *   implicitly would take its type from the value, i.e. plain string, and would
 *   store every service account password in clear text while appearing to work.
 *
 * Inputs:
 *   categoryPath (string)       - Configuration Element category, '/'-separated
 *   accountName  (string)       - Configuration Element name = the service account
 *   newPassword  (SecureString) - the password AD has ALREADY accepted
 *
 * Returns: string - a redacted confirmation line, safe to log and to surface in the
 *                   workflow's output. Never contains the password.
 *
 * SECURITY: newPassword must be bound to a SecureString workflow variable. Binding
 * it to a plain string input makes it visible in the workflow token variable view
 * and in run history for the retention period of the vRO database.
 */

// ── Input validation ──────────────────────────────────────────────────────────

if (!categoryPath || String(categoryPath).trim() === "") {
    throw new Error("setServiceAccountPassword: categoryPath is required.");
}
if (!accountName || String(accountName).trim() === "") {
    throw new Error("setServiceAccountPassword: accountName is required.");
}

// Checked by length and emptiness only - never by content, and never echoed.
if (newPassword === null || newPassword === undefined || String(newPassword) === "") {
    throw new Error(
        "setServiceAccountPassword: newPassword is empty. Refusing to write an empty password into the " +
        "credential store - that would silently blank the stored credential while AD kept the password " +
        "it was just given, leaving every consumer unable to authenticate."
    );
}

var secret = String(newPassword);

// A password that reached AD but arrived here truncated would be stored wrong and
// every consumer would fail. The generator produces a known minimum length, so
// anything materially shorter means the value was mangled in transit - most often
// by being routed through a plain-string variable that something trimmed or split.
if (secret.length < 20) {
    throw new Error(
        "setServiceAccountPassword: newPassword is only " + secret.length + " characters. The rotation " +
        "generates a much longer password, so this value has been truncated somewhere between generation " +
        "and here. Refusing to store it - AD already holds the full password, so storing a truncated copy " +
        "would guarantee authentication failures. Re-run the rotation."
    );
}

var wantCategory = String(categoryPath).trim().replace(/^\/+|\/+$/g, "");
var wantElement  = String(accountName).trim();

// ── Locate the Configuration Element ──────────────────────────────────────────
//
// Re-resolved rather than passed in from the read step. A ConfigurationElement
// reference held across the AD call could be stale if the element was edited
// mid-run, and re-resolving costs nothing next to the risk of writing to a
// reference that no longer reflects the stored element.

var category = Server.getConfigurationElementCategoryWithPath(wantCategory);
if (category === null || category === undefined) {
    throw new Error(
        "setServiceAccountPassword: no Configuration Element category at '" + wantCategory + "'. " +
        "THE AD PASSWORD HAS ALREADY BEEN CHANGED - the account's new password is not recorded anywhere. " +
        "Re-run the rotation once the category exists."
    );
}

var element = null;
var elements = category.configurationElements || [];
for (var i = 0; i < elements.length; i++) {
    if (String(elements[i].name).toLowerCase() === wantElement.toLowerCase()) {
        element = elements[i];
        break;
    }
}

if (element === null) {
    throw new Error(
        "setServiceAccountPassword: no Configuration Element named '" + wantElement + "' in category '" +
        wantCategory + "'. THE AD PASSWORD HAS ALREADY BEEN CHANGED and cannot be recorded. Re-run the " +
        "rotation - it will generate and set a fresh password and store it correctly."
    );
}

// ── Verify the target attribute before writing ────────────────────────────────

var passwordAttr = element.getAttributeWithKey("password");
if (passwordAttr === null || passwordAttr === undefined) {
    throw new Error(
        "setServiceAccountPassword: Configuration Element '" + element.name + "' has no 'password' " +
        "attribute. Create it as type SecureString. THE AD PASSWORD HAS ALREADY BEEN CHANGED - re-run the " +
        "rotation after fixing the element."
    );
}

var declaredType = String(passwordAttr.type);
if (declaredType !== "SecureString") {
    throw new Error(
        "setServiceAccountPassword: attribute 'password' on '" + element.name + "' is typed '" +
        declaredType + "', not 'SecureString'. Refusing to write - the password would be stored in clear " +
        "text. THE AD PASSWORD HAS ALREADY BEEN CHANGED; recreate the attribute as SecureString and re-run."
    );
}

// ── Commit ────────────────────────────────────────────────────────────────────

var previouslySet = !(passwordAttr.value === null || passwordAttr.value === undefined || String(passwordAttr.value) === "");

try {
    element.setAttributeWithKey("password", secret);
} catch (e) {
    throw new Error(
        "setServiceAccountPassword: failed to write the password to Configuration Element '" + element.name +
        "': " + e + ". THE AD PASSWORD HAS ALREADY BEEN CHANGED and is now unrecorded - every consumer of " +
        "this credential will fail to authenticate until the rotation is re-run. Re-run it."
    );
}

// Stamped only after the password write succeeds, so the timestamp can never claim a
// rotation that was not stored. Optional attribute: absence is a warning, not a
// failure, because the credential itself is already safely committed by this point
// and failing here would misrepresent a successful rotation as a broken one.
var stampedAt = null;
var rotatedAttr = element.getAttributeWithKey("passwordLastRotated");
if (rotatedAttr === null || rotatedAttr === undefined) {
    System.warn(
        "setServiceAccountPassword | element '" + element.name + "' has no 'passwordLastRotated' attribute - " +
        "the password was stored, but the rotation date was not. Add a Date attribute named " +
        "'passwordLastRotated' so age can be reported on."
    );
} else {
    try {
        stampedAt = new Date();
        element.setAttributeWithKey("passwordLastRotated", stampedAt);
    } catch (e2) {
        stampedAt = null;
        System.warn(
            "setServiceAccountPassword | password stored successfully, but the passwordLastRotated stamp " +
            "could not be written to '" + element.name + "': " + e2 + ". The credential is valid; only the " +
            "date is missing."
        );
    }
}

// ── Read-back verification ────────────────────────────────────────────────────
//
// Compared by LENGTH, never by value, and the value itself is never logged. A
// length mismatch means the write did not land as issued - which matters more here
// than almost anywhere else, because AD has already moved and a silently failed
// store is indistinguishable from success until consumers start failing.

element.reload();
var readBack = element.getAttributeWithKey("password");
var readBackValue = (readBack === null || readBack.value === null || readBack.value === undefined)
    ? "" : String(readBack.value);

if (readBackValue.length !== secret.length) {
    throw new Error(
        "setServiceAccountPassword: read-back check failed on '" + element.name + "' - stored a " +
        secret.length + "-character password but read back " + readBackValue.length + " characters. " +
        "THE AD PASSWORD HAS ALREADY BEEN CHANGED and the store does not match it. Re-run the rotation."
    );
}

var summary = "setServiceAccountPassword | stored " + secret.length + "-character password for '" +
    element.name + "' in " + wantCategory + " (SecureString, verified) | previous password " +
    (previouslySet ? "replaced" : "was unset - first rotation") +
    " | passwordLastRotated=" + (stampedAt === null ? "not stamped" : stampedAt);

System.log(summary);

return summary;
