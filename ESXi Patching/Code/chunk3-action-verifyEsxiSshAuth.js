// ===================================================================
// ACTION:    verifyEsxiSshAuth
// MODULE:    com.broadcom.pso.vc.esxi.remediation.host
// PURPOSE:   Confirm that the ephemeral account just provisioned
//            can actually log in via SSH AND can run a privileged
//            command. This is the AUTH_VERIFY phase per FR-19 step
//            4 — defense-in-depth check before we commit to MM
//            entry.
//
//            If this action fails, the host's procedure is aborted
//            BEFORE MM_ENTER, which means the host stays online
//            and serving workload. The cleanup cascade will remove
//            the just-provisioned account and the workflow moves
//            to the next host.
//
// PHASE:     AUTH_VERIFY
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-HOST]
//
// INPUTS:
//   targetHost  (VC:HostSystem)
//   sshUsername (string)
//   sshPassword (SecureString)
//
// RETURNS: Properties — {
//            authenticated   (boolean) — could SSH in
//            canRunPrivCmd   (boolean) — `esxcli system version get`
//                                         returned exit 0
//            esxiVersion     (string)  — captured from system
//                                         version output (e.g. "8.0.2")
//            esxiBuild       (string)  — captured build number
//            reason          (string)
//          }
//
// REQUIREMENT TRACE:
//   Implements: AD-08 (verify auth before MM), FR-19 step 4.
//
// NOTES:
//   - The action does TWO things in one SSH session:
//       1. Connects (auth check).
//       2. Runs `esxcli system version get` (privilege check;
//          requires admin role for full output).
//     If the connection succeeds but the command fails, we
//     interpret as "authenticated but lacks privilege" and the
//     action returns authenticated=true, canRunPrivCmd=false,
//     and the host is skipped.
//   - Output parsing for `esxcli system version get` (sample):
//       Product: VMware ESXi
//       Version: 8.0.2
//       Build: Releasebuild-22380479
//       Update: 2
//       Patch: 0
//     We grep "Version:" and "Build:" lines.
//   - SSH timeout for this command is short (30s) — we expect
//     near-instant response on a healthy host. A 30s timeout
//     means a hung host fails fast.
//   - This action is throw-on-connect-failure, return-on-soft-
//     failures (e.g. command runs but exits non-zero). Connect
//     failure means the credentials are bad, which means
//     provisionEphemeralAccount silently failed in some way
//     (rare); throwing surfaces the problem.
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-HOST]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

if (arguments.length < 3) {
    throw new Error(
        "verifyEsxiSshAuth requires 3 inputs: " +
        "(targetHost, sshUsername, sshPassword)."
    );
}
var targetHost  = arguments[0];
var sshUsername = arguments[1];
var sshPassword = arguments[2];

if (targetHost == null) {
    throw new Error("verifyEsxiSshAuth: 'targetHost' must not be null.");
}
if (typeof sshUsername !== "string" || sshUsername.length === 0) {
    throw new Error("verifyEsxiSshAuth: 'sshUsername' must be non-empty.");
}
if (sshPassword == null) {
    throw new Error("verifyEsxiSshAuth: 'sshPassword' must not be null.");
}

var hostFqdn = String(targetHost.name);

var result = new Properties();
result.put("authenticated", false);
result.put("canRunPrivCmd", false);
result.put("esxiVersion", "");
result.put("esxiBuild", "");
result.put("reason", "Initial state");

// -------------------------------------------------------------------
// Open SSH session.
// -------------------------------------------------------------------

var sshSession = null;
try {
    sshSession = new SSHSession(hostFqdn, 22);
    sshSession.connectWithPassword(sshUsername, String(sshPassword));
} catch (e) {
    if (sshSession != null) {
        try { sshSession.disconnect(); } catch (ignored) { /* swallow */ }
    }
    throw new Error(
        "verifyEsxiSshAuth: SSH connect failed | host=" + hostFqdn +
        " | user=" + sshUsername + " | error=" + e.message
    );
}

// Got past connect, so we're authenticated.
result.put("authenticated", true);

try {
    sshSession.executeCommand("esxcli system version get", true);
    var exitCode = sshSession.exitCode;
    var output   = sshSession.output;

    if (exitCode !== 0) {
        result.put("reason",
            "Authenticated but esxcli failed | exit=" + exitCode
        );
        auditLogger.auditLog(
            LOG_PREFIX, "AUTH_VERIFY", "FAIL",
            "Privileged command failed | host=" + hostFqdn +
            " | exit=" + exitCode
        );
        return result;
    }

    result.put("canRunPrivCmd", true);

    // Parse Version: and Build: lines.
    var lines = String(output).split("\n");
    for (var li = 0; li < lines.length; li++) {
        var line = String(lines[li]).replace(/^\s+/, "").replace(/\s+$/, "");
        if (line.indexOf("Version:") === 0) {
            result.put("esxiVersion",
                line.substring("Version:".length).replace(/^\s+/, ""));
        } else if (line.indexOf("Build:") === 0) {
            result.put("esxiBuild",
                line.substring("Build:".length).replace(/^\s+/, ""));
        }
    }

    result.put("reason",
        "Verified | version=" + result.get("esxiVersion") +
        " | build=" + result.get("esxiBuild")
    );

    auditLogger.auditLog(
        LOG_PREFIX, "AUTH_VERIFY", "OK",
        "SSH auth verified | host=" + hostFqdn +
        " | user=" + sshUsername +
        " | version=" + result.get("esxiVersion") +
        " | build=" + result.get("esxiBuild")
    );

    return result;
} finally {
    try { sshSession.disconnect(); } catch (ignored) { /* swallow */ }
}
