/**
 * Action: getServiceAccountCredential
 * Module:  com.broadcom.pso.vcf.identity.ad.accounts.passwordRotation
 *
 * vRO input-parameter order (positional call from the workflow):
 *   (categoryPath, accountName)
 *
 * Purpose:
 *   THE READ HALF OF THE CREDENTIAL OBJECT STORE.
 *
 *   Reads one Configuration Element - one per AD service account - and returns its
 *   contents as a single composite object, so the rest of the workflow can pass
 *   'the credential' around as one value instead of eight loose strings.
 *
 *   Each Configuration Element replaces exactly one of the customer's AAP job
 *   templates (1A_PW-Change_svcacct1 / 2 / 3) and its extra_vars block. Adding a
 *   fourth service account is a new Configuration Element, not a new workflow.
 *
 * ── Why the password is a TOP-LEVEL SecureString, not a composite field ───────
 *
 *   The composite object this action RETURNS is assembled in memory and lives only
 *   for the duration of the run. The password is only ever PERSISTED as a
 *   dedicated, top-level SecureString attribute on the Configuration Element.
 *
 *   That distinction is load-bearing. vRO applies SecureString protection - at-rest
 *   encryption, masking in the Configuration Element editor, redaction in the
 *   workflow token's variable view - PER ATTRIBUTE. A password stored as a field
 *   inside a composite-typed or Properties-typed attribute is, to vRO, an ordinary
 *   string: shown in clear in the editor, present in clear in run history, and
 *   printed in clear by any System.log(JSON.stringify(...)) added while debugging.
 *
 *   So: composite for ergonomics at runtime, flat SecureString for storage.
 *
 *   The corollary applies to the object this action returns. Once read into
 *   JavaScript a SecureString IS a plain String and carries none of its protection
 *   forward. NEVER log the returned object as a whole. Use .toSafeString() below.
 *
 * ── Configuration Element schema ──────────────────────────────────────────────
 *
 *   Category:  <categoryPath>            e.g. 'PSO/Identity/ServiceAccounts'
 *   Element:   <accountName>             e.g. 'svcacct1'
 *
 *     samAccountName       string        REQUIRED  the account AD resets (identity)
 *     userPrincipalName    string        REQUIRED  UPN form, used by consumers
 *     domainServer         string        REQUIRED  DC to target
 *     ldapBaseDN           string        REQUIRED  OU the account must already be in
 *     password             SecureString  the current password (empty before first run)
 *     passwordLastRotated  Date          stamped by setServiceAccountPassword
 *
 *   ldapBaseDN is REQUIRED here even though the rotation only ever updates an
 *   existing account, because it is used as a SEARCH BASE to assert the account is
 *   where it is expected to be. The Ansible original passed it to microsoft.ad.user
 *   as 'path' alongside 'state: present', which meant a typo in sAMAccountName
 *   CREATED a new account in that OU and reported success (see Change-Register
 *   P-45). Here the OU constrains the lookup instead of receiving a new object.
 *
 * Inputs:
 *   categoryPath  (string) - Configuration Element category, '/'-separated
 *   accountName   (string) - Configuration Element name = the service account
 *
 * Returns: Properties - composite credential object with these keys:
 *   accountName, samAccountName, userPrincipalName, domainServer, ldapBaseDN,
 *   password, passwordLastRotated, hasPassword, toSafeString()
 */

// ── Input validation ──────────────────────────────────────────────────────────

if (!categoryPath || String(categoryPath).trim() === "") {
    throw new Error("getServiceAccountCredential: categoryPath is required, e.g. 'PSO/Identity/ServiceAccounts'.");
}
if (!accountName || String(accountName).trim() === "") {
    throw new Error("getServiceAccountCredential: accountName is required - it is the name of the Configuration Element holding the account, e.g. 'svcacct1'.");
}

var wantCategory = String(categoryPath).trim().replace(/^\/+|\/+$/g, "");
var wantElement  = String(accountName).trim();

// ── Locate the Configuration Element ──────────────────────────────────────────

var category = Server.getConfigurationElementCategoryWithPath(wantCategory);
if (category === null || category === undefined) {
    throw new Error(
        "getServiceAccountCredential: no Configuration Element category at '" + wantCategory + "'. " +
        "Create the category and one Configuration Element per service account before running this " +
        "workflow - see 03_Implementation_Guide. The path is case-sensitive and must NOT be prefixed " +
        "with the package name."
    );
}

var elements = category.configurationElements;
if (elements === null || elements === undefined || elements.length === 0) {
    throw new Error(
        "getServiceAccountCredential: category '" + wantCategory + "' exists but contains no Configuration " +
        "Elements. Expected one per service account (svcacct1, svcacct2, svcacct3)."
    );
}

// Matched case-insensitively: sAMAccountNames are case-insensitive in AD and an
// operator typing 'SVCACCT1' into the request form means the same account. The
// element's own spelling is what gets reported back.
var element = null;
var available = [];
for (var i = 0; i < elements.length; i++) {
    available.push(elements[i].name);
    if (String(elements[i].name).toLowerCase() === wantElement.toLowerCase()) {
        element = elements[i];
    }
}

if (element === null) {
    throw new Error(
        "getServiceAccountCredential: no Configuration Element named '" + wantElement + "' in category '" +
        wantCategory + "'. Available: " + (available.length > 0 ? available.join(", ") : "(none)") + "."
    );
}

// ── Read attributes ───────────────────────────────────────────────────────────

// getAttributeWithKey returns null for a key the element does not declare. It also
// returns an Attribute whose .value is null for a declared-but-empty key, which is
// the normal state of 'password' before the first rotation - the two cases are
// deliberately distinguished below.
function readAttribute(key) {
    var attr = element.getAttributeWithKey(key);
    if (attr === null || attr === undefined) { return null; }
    return attr;
}

function readString(key, required) {
    var attr = readAttribute(key);
    if (attr === null) {
        if (required) {
            throw new Error(
                "getServiceAccountCredential: Configuration Element '" + element.name + "' has no attribute '" +
                key + "'. Every service account element must declare samAccountName, userPrincipalName, " +
                "domainServer and ldapBaseDN as string attributes, plus password as a SecureString."
            );
        }
        return "";
    }
    var value = (attr.value === null || attr.value === undefined) ? "" : String(attr.value).trim();
    if (required && value === "") {
        throw new Error(
            "getServiceAccountCredential: attribute '" + key + "' on Configuration Element '" + element.name +
            "' is empty. It is required - the rotation cannot proceed without it."
        );
    }
    return value;
}

var samAccountName    = readString("samAccountName", true);
var userPrincipalName = readString("userPrincipalName", true);
var domainServer      = readString("domainServer", true);
var ldapBaseDN        = readString("ldapBaseDN", true);

// ── Consistency checks the Ansible original never made ────────────────────────
//
// In the playbook, AD was updated by sAMAccountName while AAP recorded the UPN, and
// nothing correlated the two. If they named different accounts, the rotation set a
// password on one account and stored it against another - and the failure only
// surfaced later, as lockouts on whatever consumed the credential.
//
// vRO is now the sole consumer, so that mismatch would poison the store itself.
// Checked here, cheaply, before anything is written.

if (userPrincipalName.indexOf("@") === -1) {
    throw new Error(
        "getServiceAccountCredential: userPrincipalName '" + userPrincipalName + "' on element '" +
        element.name + "' is not a UPN - it has no '@'. Expected the form " +
        "'" + samAccountName + "@domain.example'."
    );
}

var upnPrefix = userPrincipalName.substring(0, userPrincipalName.indexOf("@"));
if (upnPrefix.toLowerCase() !== samAccountName.toLowerCase()) {
    // Warn, not throw: a UPN prefix legitimately differs from sAMAccountName in some
    // directories. But it is far more often a copy-paste slip between two elements,
    // and the consequence - storing a password against the wrong account - is bad
    // enough to be worth saying out loud on every run.
    System.warn(
        "getServiceAccountCredential | element '" + element.name + "': userPrincipalName prefix ('" +
        upnPrefix + "') does not match samAccountName ('" + samAccountName + "'). AD will be updated by " +
        "samAccountName and consumers will authenticate as the UPN. Confirm both name the SAME account - " +
        "if they do not, this rotation will store a valid password against the wrong identity."
    );
}

if (ldapBaseDN.toUpperCase().indexOf("DC=") === -1) {
    throw new Error(
        "getServiceAccountCredential: ldapBaseDN '" + ldapBaseDN + "' on element '" + element.name +
        "' is not a distinguishedName - it has no 'DC=' component. Expected the full DN form, e.g. " +
        "'OU=Service Accounts,OU=test,DC=dom2,DC=dom1,DC=com'."
    );
}

// ── Password (SecureString) ───────────────────────────────────────────────────

var passwordAttr = readAttribute("password");
if (passwordAttr === null) {
    throw new Error(
        "getServiceAccountCredential: Configuration Element '" + element.name + "' has no 'password' " +
        "attribute. Create it as type SecureString (NOT string) before the first run. The attribute must " +
        "exist and be typed SecureString up front, because setServiceAccountPassword writes into the " +
        "existing attribute and relies on its declared type to keep the value encrypted and masked."
    );
}

// Type check. A 'password' attribute that was created as a plain string still works
// mechanically - it holds the value and the rotation succeeds - which is exactly why
// this is worth failing on. It would silently store every service account password
// in clear text, visible to anyone with read access to the Configuration Element.
var passwordType = String(passwordAttr.type);
if (passwordType !== "SecureString") {
    throw new Error(
        "getServiceAccountCredential: attribute 'password' on Configuration Element '" + element.name +
        "' is typed '" + passwordType + "', not 'SecureString'. Refusing to continue - rotating into a " +
        "plain-string attribute would store the service account password in clear text and expose it in " +
        "the Configuration Element editor and in run history. Recreate the attribute as SecureString."
    );
}

var password = (passwordAttr.value === null || passwordAttr.value === undefined) ? "" : String(passwordAttr.value);

// Empty is legitimate and expected before the first rotation, so it is not an error
// here. Consumers that need a usable credential check hasPassword.
var hasPassword = (password !== "");

var rotatedAttr = readAttribute("passwordLastRotated");
var passwordLastRotated = (rotatedAttr === null || rotatedAttr.value === null || rotatedAttr.value === undefined)
    ? null
    : rotatedAttr.value;

// ── Assemble the composite ────────────────────────────────────────────────────

var credential = {
    accountName:         element.name,
    samAccountName:      samAccountName,
    userPrincipalName:   userPrincipalName,
    domainServer:        domainServer,
    ldapBaseDN:          ldapBaseDN,
    password:            password,
    passwordLastRotated: passwordLastRotated,
    hasPassword:         hasPassword,

    // The ONLY safe way to render this object. Provided so that the obvious
    // troubleshooting reflex - print the credential - lands somewhere harmless
    // instead of writing the password into run history.
    toSafeString: function () {
        return "credential[" + this.accountName + "] sam=" + this.samAccountName +
               " upn=" + this.userPrincipalName +
               " dc=" + this.domainServer +
               " password=" + (this.hasPassword ? "(set, " + this.password.length + " chars)" : "(not set)") +
               " lastRotated=" + (this.passwordLastRotated === null ? "never" : this.passwordLastRotated);
    }
};

System.log("getServiceAccountCredential | " + credential.toSafeString());

if (!hasPassword) {
    System.warn(
        "getServiceAccountCredential | element '" + element.name + "' has no stored password yet. This is " +
        "expected before the FIRST rotation. Any consumer workflow reading this credential now will fail " +
        "to authenticate - run the rotation before pointing anything at it."
    );
}

return credential;
