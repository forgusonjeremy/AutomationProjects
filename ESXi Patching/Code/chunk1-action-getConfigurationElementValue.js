// ===================================================================
// ACTION:    getConfigurationElementValue
// MODULE:    com.broadcom.pso.common.config
// PURPOSE:   Read a non-encrypted attribute value from a vRO
//            Configuration Element. Looks up the CE by full path,
//            then by name as a fallback. Throws if the CE or
//            attribute cannot be found — this is intentional: a
//            misconfigured environment should fail fast at workflow
//            startup, not silently use a stale or missing value.
//
// PHASE:     STARTUP / DISCOVER (configuration retrieval)
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [PSO-COMMON-CONFIG]
//
// INPUTS:
//   pathOrName    (string) — Either the full Configuration Element
//                            path (e.g. "PSO/ESXi Remediation/Settings")
//                            or just its name (e.g. "Settings"). The
//                            action tries path-based lookup first
//                            because it is more specific, then falls
//                            back to name-based lookup if the path
//                            yields no result.
//   attributeName (string) — The attribute key to read from the CE.
//
// RETURNS: any — The attribute's value. Type matches whatever the CE
//                attribute is configured for (string, number,
//                boolean, Properties, Array, etc.).
//
// REQUIREMENT TRACE:
//   Implements: AD-10 / FR-37 indirectly (CE-05 access uses a
//   different action with locking; this one is the simple reader
//   for non-locked CEs like CE-01 Settings, CE-03 SmtpReference).
//
// NOTES:
//   - For ENCRYPTED attributes (e.g. SecureString), use the
//     companion action getEncryptedConfigurationElementValue. This
//     action will return the encrypted ciphertext as a string,
//     which is almost never what you want.
//   - Path-based lookup uses the vRO API
//     Server.getConfigurationElementCategoryWithPath() then walks
//     the Configuration Elements within. Name-based lookup uses
//     Server.findAllForType("ConfigurationElement") and filters.
//     Path-based is preferred because names can collide across
//     categories.
//   - Thrown errors include both the input pathOrName and the
//     attributeName so log forensics can trace which lookup failed.
//   - Action does NOT cache: every call hits the vRO database.
//     This is fine for typical workflow usage (CE values read
//     once at startup, used many times in memory) but caller
//     should not call this action in tight loops.
// ===================================================================

var LOG_PREFIX = "[PSO-COMMON-CONFIG]";

// -------------------------------------------------------------------
// Input validation.
// -------------------------------------------------------------------

if (arguments.length < 2) {
    throw new Error(
        "getConfigurationElementValue requires 2 inputs: " +
        "(pathOrName:string, attributeName:string)."
    );
}

var pathOrName    = arguments[0];
var attributeName = arguments[1];

if (typeof pathOrName !== "string" || pathOrName.length === 0) {
    throw new Error(
        "getConfigurationElementValue: 'pathOrName' must be a non-empty string."
    );
}
if (typeof attributeName !== "string" || attributeName.length === 0) {
    throw new Error(
        "getConfigurationElementValue: 'attributeName' must be a non-empty string."
    );
}

// -------------------------------------------------------------------
// Resolve the Configuration Element. Try path-based first.
// -------------------------------------------------------------------

var ce = null;

// Path-based lookup. The path is everything except the final
// segment, which is the CE name. Example:
//   pathOrName = "PSO/ESXi Remediation/Settings"
//     → categoryPath = "PSO/ESXi Remediation"
//     → ceName       = "Settings"
var lastSlashIdx = pathOrName.lastIndexOf("/");
if (lastSlashIdx > 0 && lastSlashIdx < pathOrName.length - 1) {
    var categoryPath = pathOrName.substring(0, lastSlashIdx);
    var ceName       = pathOrName.substring(lastSlashIdx + 1);

    try {
        var category = Server.getConfigurationElementCategoryWithPath(categoryPath);
        if (category != null) {
            // category.configurationElements is an Array.
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
        // Path-based lookup failed (e.g. category does not exist).
        // Fall through to name-based lookup. Do not throw yet.
        ce = null;
    }
}

// Name-based fallback. We use the supplied pathOrName as a name in
// case the caller passed only the bare name (no path).
if (ce == null) {
    var nameToFind = pathOrName;
    // If pathOrName contained a path, strip to just the last segment.
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
        "getConfigurationElementValue: Configuration Element not found | " +
        "pathOrName=" + pathOrName
    );
}

// -------------------------------------------------------------------
// Read the attribute.
// -------------------------------------------------------------------

var attribute = ce.getAttributeWithKey(attributeName);

if (attribute == null) {
    throw new Error(
        "getConfigurationElementValue: attribute not found | " +
        "ce=" + ce.name + " | attributeName=" + attributeName
    );
}

// attribute.value is the typed value (string, number, boolean,
// Properties, Array, etc.) per the CE attribute's declared type.
var value = attribute.value;

System.log(
    LOG_PREFIX + " [DISCOVER] [OK] CE attribute read | " +
    "ce=" + ce.name + " | attribute=" + attributeName +
    " | type=" + (typeof value)
);

return value;
