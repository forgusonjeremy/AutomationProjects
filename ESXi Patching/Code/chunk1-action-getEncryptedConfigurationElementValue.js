// ===================================================================
// ACTION:    getEncryptedConfigurationElementValue
// MODULE:    com.broadcom.pso.common.config
// PURPOSE:   Read an ENCRYPTED attribute value from a vRO
//            Configuration Element. Returns the value as a
//            SecureString-typed string so it does not leak in audit
//            logs (vRO renders SecureString as ******** in logs by
//            default). Use this for any CE attribute that stores
//            credentials, tokens, or other sensitive material.
//
// PHASE:     STARTUP / AUTH (credential retrieval)
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [PSO-COMMON-CONFIG]
//
// INPUTS:
//   pathOrName    (string) — Same semantics as the non-encrypted
//                            companion action: full path preferred,
//                            bare name accepted as fallback.
//   attributeName (string) — The encrypted attribute key.
//
// RETURNS: SecureString — The decrypted value, typed as
//                          SecureString so vRO continues to redact
//                          it in subsequent log/property dumps.
//
// REQUIREMENT TRACE:
//   Implements: NFR-11 (encrypted credentials at rest — though for
//   this project AD-08 ephemeral accounts mean we have no
//   persistent ESXi credentials. This action remains in the
//   reusable library because OTHER projects building on this
//   foundation will need it).
//
// NOTES:
//   - The action is otherwise identical to
//     getConfigurationElementValue. The two are kept separate so
//     callers must explicitly opt in to reading encrypted values
//     — this prevents accidentally treating ciphertext as
//     plaintext in non-encrypted reads.
//   - vRO Configuration Element attributes have an 'encrypted'
//     boolean field. The action will throw if the attribute
//     exists but is NOT marked encrypted — failing safe is the
//     correct behavior because an unencrypted attribute named
//     like a credential is itself a misconfiguration.
//   - On vRO 9.x, attribute.value on an encrypted attribute
//     returns the decrypted value when read from JavaScript.
//     The SecureString wrapping is handled by the vRO platform
//     when the value is consumed (e.g. passed as a workflow
//     input that is typed SecureString, or used in a SSHSession
//     password parameter).
// ===================================================================

var LOG_PREFIX = "[PSO-COMMON-CONFIG]";

// -------------------------------------------------------------------
// Input validation.
// -------------------------------------------------------------------

if (arguments.length < 2) {
    throw new Error(
        "getEncryptedConfigurationElementValue requires 2 inputs: " +
        "(pathOrName:string, attributeName:string)."
    );
}

var pathOrName    = arguments[0];
var attributeName = arguments[1];

if (typeof pathOrName !== "string" || pathOrName.length === 0) {
    throw new Error(
        "getEncryptedConfigurationElementValue: 'pathOrName' must be a non-empty string."
    );
}
if (typeof attributeName !== "string" || attributeName.length === 0) {
    throw new Error(
        "getEncryptedConfigurationElementValue: 'attributeName' must be a non-empty string."
    );
}

// -------------------------------------------------------------------
// Resolve the Configuration Element. Same path-then-name pattern as
// the non-encrypted accessor.
// -------------------------------------------------------------------

var ce = null;

var lastSlashIdx = pathOrName.lastIndexOf("/");
if (lastSlashIdx > 0 && lastSlashIdx < pathOrName.length - 1) {
    var categoryPath = pathOrName.substring(0, lastSlashIdx);
    var ceName       = pathOrName.substring(lastSlashIdx + 1);

    try {
        var category = Server.getConfigurationElementCategoryWithPath(categoryPath);
        if (category != null) {
            var ceList = category.configurationElements;
            if (ceList != null) {
                for (var i = 0; i < ceList.length; i++) {
                    if (ceList[i] != null && ceList[i].name === ceName) {
                        ce = ceList[i];
                        break;
                    }
                }
            }
        }
    } catch (e) {
        ce = null;
    }
}

if (ce == null) {
    var nameToFind = pathOrName;
    if (lastSlashIdx > 0 && lastSlashIdx < pathOrName.length - 1) {
        nameToFind = pathOrName.substring(lastSlashIdx + 1);
    }

    var allCes = Server.findAllForType("ConfigurationElement");
    if (allCes != null) {
        for (var j = 0; j < allCes.length; j++) {
            if (allCes[j] != null && allCes[j].name === nameToFind) {
                ce = allCes[j];
                break;
            }
        }
    }
}

if (ce == null) {
    throw new Error(
        "getEncryptedConfigurationElementValue: Configuration Element not found | " +
        "pathOrName=" + pathOrName
    );
}

// -------------------------------------------------------------------
// Read and validate the attribute. Critical safety check: the
// attribute MUST be marked encrypted.
// -------------------------------------------------------------------

var attribute = ce.getAttributeWithKey(attributeName);

if (attribute == null) {
    throw new Error(
        "getEncryptedConfigurationElementValue: attribute not found | " +
        "ce=" + ce.name + " | attributeName=" + attributeName
    );
}

// Verify encryption flag. If the attribute exists but is unencrypted,
// refuse to return the value — this would silently treat plaintext
// as a credential, which is a misconfiguration we should surface.
// The .encrypted boolean is part of the attribute metadata in vRO.
if (attribute.encrypted !== true) {
    throw new Error(
        "getEncryptedConfigurationElementValue: attribute is NOT marked encrypted | " +
        "ce=" + ce.name + " | attributeName=" + attributeName +
        " | use getConfigurationElementValue for non-encrypted attributes, " +
        "or update the CE attribute to be encrypted."
    );
}

var value = attribute.value;

// Do NOT log the value or its type — even type info can leak
// SecureString details. Log only that a read happened.
System.log(
    LOG_PREFIX + " [AUTH] [OK] Encrypted CE attribute read | " +
    "ce=" + ce.name + " | attribute=" + attributeName
);

return value;
