// ===================================================================
// ACTION:    provisionEphemeralAccount
// MODULE:    com.broadcom.pso.vc.esxi.remediation.account
// PURPOSE:   Create a local ESXi user account on the target host
//            using the host's accountManager.createUser API. Per
//            AD-08 the account is created via the vCenter SDK (not
//            via direct esxcli/SSH) because at this point in the
//            workflow we don't yet have SSH credentials. The
//            account uses VcHostPosixAccountSpec with shellAccess=
//            true so SSH login is permitted.
//
//            Idempotent: if the account already exists (rare; only
//            on workflow restart edge cases), the action logs and
//            returns success.
//
// PHASE:     AUTH_PROVISION
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-ACCOUNT]
//
// INPUTS:
//   targetHost (VC:HostSystem)
//   username   (string)        — From generateShortRunId
//   password   (SecureString)  — From generateEphemeralPassword
//
// RETURNS: Properties — {
//            created     (boolean) — true if newly created, false
//                                     if pre-existing
//            description (string)  — what was set on the account
//          }
//
// REQUIREMENT TRACE:
//   Implements: AD-08 (provision via accountManager), FR-19 step 2.
//
// NOTES:
//   - The accountManager is reached via host.configManager.accountManager.
//   - VcHostPosixAccountSpec fields:
//       id              (string, required) — username
//       password        (string, required) — plaintext passed via
//                                              SecureString
//       description     (string, optional) — tag for audit / search
//       shellAccess     (boolean, required) — true for SSH usability
//   - Description format: "vRO ESXi Patch Workflow run <fullRunId>
//                          created <ISO-timestamp>"
//     This is what WF-07 reconcile uses to identify candidate
//     accounts for cleanup.
//   - Idempotency: createUser throws AlreadyExists if username is
//     taken. We catch and treat as success — the only legitimate
//     case where the account exists at this point is if a previous
//     run for this same workflow was interrupted between creation
//     and cleanup, AND the same workflow run ID is being reused
//     (which doesn't happen in practice). For safety we log a
//     WARN and proceed; the next phase (AUTH_VERIFY) will confirm
//     the password actually works.
//   - Account creation does NOT grant any vCenter or host
//     permissions. The follow-up Action grantHostAdminRole takes
//     care of that.
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-ACCOUNT]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

if (arguments.length < 3) {
    throw new Error(
        "provisionEphemeralAccount requires 3 inputs: " +
        "(targetHost, username, password)."
    );
}
var targetHost = arguments[0];
var username   = arguments[1];
var password   = arguments[2];

if (targetHost == null) {
    throw new Error("provisionEphemeralAccount: 'targetHost' must not be null.");
}
if (typeof username !== "string" || username.length === 0) {
    throw new Error("provisionEphemeralAccount: 'username' must be non-empty.");
}
if (password == null) {
    throw new Error("provisionEphemeralAccount: 'password' must not be null.");
}

// Resolve accountManager.
var accountManager = null;
try {
    if (targetHost.configManager != null) {
        accountManager = targetHost.configManager.accountManager;
    }
} catch (e) {
    throw new Error(
        "provisionEphemeralAccount: cannot read host.configManager.accountManager: " + e.message
    );
}
if (accountManager == null) {
    throw new Error(
        "provisionEphemeralAccount: host has no accountManager | host=" + targetHost.name
    );
}

// Description: identifies the run that created the account. WF-07
// reconcile reads this to match accounts to runs.
var nowIso = (new Date()).toISOString();
var description = "vRO ESXi Patch Workflow run " + workflow.id +
                  " created " + nowIso;

// Build the spec.
var spec = new VcHostPosixAccountSpec();
spec.id = username;
spec.password = String(password);
spec.description = description;
spec.shellAccess = true;
// Note: VcHostPosixAccountSpec also accepts posixId (UID number).
// Leaving it unset lets ESXi auto-assign — recommended.

// -------------------------------------------------------------------
// Invoke createUser. Catch AlreadyExists as idempotent.
// -------------------------------------------------------------------

var created = true;
try {
    accountManager.createUser(spec);
} catch (e) {
    var msg = String(e.message != null ? e.message : e);
    // Check if the error indicates the account already exists.
    // ESXi returns "AlreadyExists" in the SOAP fault; vRO surfaces
    // that as the Java exception class name in the message.
    if (msg.indexOf("AlreadyExists") !== -1
        || msg.indexOf("already exists") !== -1) {
        created = false;
        auditLogger.auditLog(
            LOG_PREFIX, "AUTH_PROVISION", "WARN",
            "Account already exists; idempotent path | " +
            "host=" + targetHost.name + " | username=" + username
        );
    } else {
        // Any other failure is fatal.
        throw new Error(
            "provisionEphemeralAccount: createUser failed | host=" + targetHost.name +
            " | username=" + username + " | error=" + msg
        );
    }
}

var result = new Properties();
result.put("created", created);
result.put("description", description);

auditLogger.auditLog(
    LOG_PREFIX, "AUTH_PROVISION",
    created ? "OK" : "WARN",
    (created ? "Created" : "Verified pre-existing") + " ephemeral account | " +
    "host=" + targetHost.name + " | username=" + username
);

return result;
