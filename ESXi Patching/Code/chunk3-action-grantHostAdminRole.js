// ===================================================================
// ACTION:    grantHostAdminRole
// MODULE:    com.broadcom.pso.vc.esxi.remediation.account
// PURPOSE:   Grant the Administrator role to the ephemeral local
//            user account on the target host so it has the
//            permissions required to run esxcli software vib
//            install. Per AD-08 / C-16 we use the built-in
//            Administrator role at the host level — limited to
//            this single ESXi host (NOT inherited from vCenter).
//
//            Uses host.configManager.authorizationManager
//            .setEntityPermissions() — the SDK call that assigns a
//            role to a principal on a specific managed entity.
//
// PHASE:     AUTH_PROVISION
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-ACCOUNT]
//
// INPUTS:
//   targetHost (VC:HostSystem)
//   username   (string)
//
// RETURNS: void (throws on failure)
//
// REQUIREMENT TRACE:
//   Implements: AD-08, C-16 (Administrator role at vCenter level —
//               which on the host's managed entity translates to
//               the host's built-in Administrator role).
//
// NOTES:
//   - The Administrator role's role ID on every ESXi host is -1
//     (negative one is the well-known constant for the built-in
//     Administrator role). This is stable across all vSphere
//     versions.
//   - VcPermission spec fields:
//       entity    (ManagedObjectReference) — the host itself
//       principal (string)                  — username
//       group     (boolean)                  — false (user, not group)
//       roleId    (number)                   — -1 (Administrator)
//       propagate (boolean)                  — true (inherit to
//                                              child entities of the
//                                              host, e.g. VMs)
//   - We pass the permission as a single-element array to
//     setEntityPermissions per the SDK signature.
//   - The action does NOT verify the permission was granted (that
//     is verifyEsxiSshAuth's job — it logs in as the new user and
//     runs a privileged command).
//   - Idempotent: setEntityPermissions overwrites existing
//     permissions for the same principal on the same entity, so
//     calling it twice is harmless.
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-ACCOUNT]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

if (arguments.length < 2) {
    throw new Error("grantHostAdminRole requires 2 inputs: (targetHost, username).");
}
var targetHost = arguments[0];
var username   = arguments[1];

if (targetHost == null) {
    throw new Error("grantHostAdminRole: 'targetHost' must not be null.");
}
if (typeof username !== "string" || username.length === 0) {
    throw new Error("grantHostAdminRole: 'username' must be non-empty.");
}

// Resolve authorizationManager.
var authMgr = null;
try {
    if (targetHost.configManager != null) {
        authMgr = targetHost.configManager.authorizationManager;
    }
} catch (e) {
    throw new Error(
        "grantHostAdminRole: cannot read host.configManager.authorizationManager: " + e.message
    );
}
if (authMgr == null) {
    throw new Error(
        "grantHostAdminRole: host has no authorizationManager | host=" + targetHost.name
    );
}

// Build the permission spec.
var permission = new VcPermission();
permission.entity = targetHost.reference; // ManagedObjectReference
permission.principal = username;
permission.group = false;
permission.roleId = -1;     // Administrator
permission.propagate = true;

// setEntityPermissions takes (entity, permissions[]).
try {
    authMgr.setEntityPermissions(targetHost.reference, [permission]);
} catch (e) {
    throw new Error(
        "grantHostAdminRole: setEntityPermissions failed | host=" + targetHost.name +
        " | username=" + username + " | error=" + e.message
    );
}

auditLogger.auditLog(
    LOG_PREFIX, "AUTH_PROVISION", "OK",
    "Granted Administrator role to ephemeral account | " +
    "host=" + targetHost.name + " | username=" + username + " | roleId=-1"
);
