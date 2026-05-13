// ===================================================================
// ACTION:    cleanupEphemeralAccount
// MODULE:    com.broadcom.pso.vc.esxi.remediation.account
// PURPOSE:   Reverse the work done by provisionEphemeralAccount +
//            grantHostAdminRole. Order matters: REMOVE PERMISSION
//            FIRST, then DELETE USER. Reversing the order would
//            briefly leave a permission entry pointing at a non-
//            existent principal (which vCenter handles gracefully
//            but produces ugly cluster events).
//
//            Idempotent: missing permission and missing user both
//            result in success (since the goal is "this account
//            shouldn't exist" — done either way).
//
//            Permissive on failure: AD-08 / AD-11 cleanup cascade
//            requires that cleanup actions never raise — they log
//            partial outcomes via return value so cluster-level
//            cleanup classification (states A/B/C) can decide
//            whether to halt or continue.
//
// PHASE:     AUTH_CLEANUP
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-ACCOUNT]
//
// INPUTS:
//   targetHost (VC:HostSystem)
//   username   (string)
//
// RETURNS: Properties — {
//            permissionRemoved (boolean) — true on success or no-op
//            accountDeleted    (boolean) — true on success or no-op
//            allClean          (boolean) — both above true
//            errors            (Array/string) — non-fatal errors
//                                                encountered.
//          }
//
// REQUIREMENT TRACE:
//   Implements: AD-08 cleanup ordering, AD-11 cleanup cascade rule
//               1 (own-resources idempotent), FR-19 step 14.
//
// NOTES:
//   - Step 1: removeEntityPermission (host, principal, isGroup=false)
//   - Step 2: removeUser (username)
//   - On NotFound (vSphere fault for "principal not found" or
//     "user not found") we treat as success — that is exactly the
//     state we want to leave the host in.
//   - If permission removal fails for non-NotFound reasons, we
//     STILL attempt the user deletion. Worst case we leave a
//     dangling permission entry for a non-existent principal,
//     which vCenter ignores at next reconciliation.
//   - The action does NOT touch the host's vCenter SDK connection,
//     other accounts, or other permissions — only the named
//     principal on the named host.
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-ACCOUNT]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

if (arguments.length < 2) {
    throw new Error(
        "cleanupEphemeralAccount requires 2 inputs: (targetHost, username)."
    );
}
var targetHost = arguments[0];
var username   = arguments[1];

if (targetHost == null) {
    throw new Error("cleanupEphemeralAccount: 'targetHost' must not be null.");
}
if (typeof username !== "string" || username.length === 0) {
    throw new Error("cleanupEphemeralAccount: 'username' must be non-empty.");
}

var result = new Properties();
result.put("permissionRemoved", false);
result.put("accountDeleted", false);
result.put("allClean", false);
var errors = [];

// -------------------------------------------------------------------
// Step 1: remove the permission.
// -------------------------------------------------------------------

var authMgr = null;
try {
    if (targetHost.configManager != null) {
        authMgr = targetHost.configManager.authorizationManager;
    }
} catch (e) {
    errors.push("Cannot read authorizationManager: " + e.message);
}

if (authMgr != null) {
    try {
        authMgr.removeEntityPermission(targetHost.reference, username, false);
        result.put("permissionRemoved", true);
        auditLogger.auditLog(
            LOG_PREFIX, "AUTH_CLEANUP", "OK",
            "Removed host permission | host=" + targetHost.name +
            " | principal=" + username
        );
    } catch (e) {
        var pmsg = String(e.message != null ? e.message : e);
        if (pmsg.indexOf("NotFound") !== -1
            || pmsg.indexOf("not found") !== -1
            || pmsg.indexOf("UserNotFound") !== -1) {
            // Already absent; success.
            result.put("permissionRemoved", true);
            auditLogger.auditLog(
                LOG_PREFIX, "AUTH_CLEANUP", "OK",
                "Permission already absent | host=" + targetHost.name +
                " | principal=" + username
            );
        } else {
            errors.push("removeEntityPermission failed: " + pmsg);
            auditLogger.auditLog(
                LOG_PREFIX, "AUTH_CLEANUP", "WARN",
                "Permission removal failed (continuing) | host=" + targetHost.name +
                " | principal=" + username + " | error=" + pmsg
            );
        }
    }
} else {
    errors.push("authorizationManager unavailable");
}

// -------------------------------------------------------------------
// Step 2: delete the user.
// -------------------------------------------------------------------

var accountManager = null;
try {
    if (targetHost.configManager != null) {
        accountManager = targetHost.configManager.accountManager;
    }
} catch (e) {
    errors.push("Cannot read accountManager: " + e.message);
}

if (accountManager != null) {
    try {
        accountManager.removeUser(username);
        result.put("accountDeleted", true);
        auditLogger.auditLog(
            LOG_PREFIX, "AUTH_CLEANUP", "OK",
            "Deleted ephemeral account | host=" + targetHost.name +
            " | username=" + username
        );
    } catch (e) {
        var amsg = String(e.message != null ? e.message : e);
        if (amsg.indexOf("UserNotFound") !== -1
            || amsg.indexOf("NotFound") !== -1
            || amsg.indexOf("not found") !== -1) {
            result.put("accountDeleted", true);
            auditLogger.auditLog(
                LOG_PREFIX, "AUTH_CLEANUP", "OK",
                "Account already absent | host=" + targetHost.name +
                " | username=" + username
            );
        } else {
            errors.push("removeUser failed: " + amsg);
            auditLogger.auditLog(
                LOG_PREFIX, "AUTH_CLEANUP", "WARN",
                "Account deletion failed (continuing) | host=" + targetHost.name +
                " | username=" + username + " | error=" + amsg
            );
        }
    }
} else {
    errors.push("accountManager unavailable");
}

// -------------------------------------------------------------------
// Final state.
// -------------------------------------------------------------------

result.put("errors", errors);
result.put("allClean", result.get("permissionRemoved") === true
                       && result.get("accountDeleted") === true);

auditLogger.auditLog(
    LOG_PREFIX, "AUTH_CLEANUP",
    result.get("allClean") === true ? "DONE" : "WARN",
    "Cleanup summary | host=" + targetHost.name +
    " | username=" + username +
    " | permissionRemoved=" + result.get("permissionRemoved") +
    " | accountDeleted=" + result.get("accountDeleted") +
    " | errorCount=" + errors.length
);

return result;
