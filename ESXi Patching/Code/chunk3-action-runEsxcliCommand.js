// ===================================================================
// ACTION:    runEsxcliCommand
// MODULE:    com.broadcom.pso.vc.esxi.remediation.host
// PURPOSE:   Generic SSH-based wrapper for running an arbitrary
//            esxcli command on the target host and capturing its
//            output, exit code, and stderr. Used by PATCH_LIST,
//            PATCH_INSTALL, and any other phase that needs to
//            execute esxcli commands.
//
//            The action opens a fresh SSH session per call (per
//            architect's chosen pattern), runs the command, and
//            tears down. Each call independently verifies the
//            ephemeral account still works.
//
// PHASE:     PATCH_LIST / PATCH_INSTALL / VERIFY_BUILD / etc.
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-HOST]
//
// INPUTS:
//   targetHost     (VC:HostSystem)
//   sshUsername    (string)
//   sshPassword    (SecureString)
//   commandLine    (string)        — Full command (e.g. from
//                                     prepareEsxcliInvocation).
//   timeoutSeconds (number)        — SSH command timeout. Default
//                                     300.
//   logCommand     (boolean)       — When true, the command line
//                                     is logged in audit. Default
//                                     true. Set false if the
//                                     command line contains
//                                     credentials (rare for
//                                     esxcli).
//
// RETURNS: Properties — {
//            exitCode       (number)
//            stdout         (string)
//            stderr         (string)
//            durationSec    (number)
//            success        (boolean)  — exit code 0
//          }
//
// REQUIREMENT TRACE:
//   Implements: support for FR-19 steps 6 / 7 (PATCH_LIST,
//               PATCH_INSTALL).
//
// NOTES:
//   - The action throws on connect failure (treats it as fatal —
//     same reasoning as verifyEsxiSshAuth: bad creds means
//     something upstream broke).
//   - For non-zero exit codes, the action returns success=false
//     with the captured stdout/stderr so the caller can surface
//     the underlying esxcli error message in the audit log.
//   - executeCommand(cmd, true) — second arg is "verbose" /
//     "captureOutput" — the SSHCommand plugin populates .output
//     and .error properties when this is true.
//   - Per the architect-confirmed per-phase SSH pattern: the
//     session is constructed in this Action, used once, and
//     disconnected. We do NOT cache or reuse SSH sessions across
//     calls.
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-HOST]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

if (arguments.length < 4) {
    throw new Error(
        "runEsxcliCommand requires 4-6 inputs: " +
        "(targetHost, sshUsername, sshPassword, commandLine, [timeoutSeconds], [logCommand])."
    );
}
var targetHost     = arguments[0];
var sshUsername    = arguments[1];
var sshPassword    = arguments[2];
var commandLine    = arguments[3];
var timeoutSeconds = arguments.length >= 5 ? arguments[4] : 300;
var logCommand     = arguments.length >= 6 ? arguments[5] : true;

if (targetHost == null) throw new Error("runEsxcliCommand: 'targetHost' must not be null.");
if (typeof sshUsername !== "string" || sshUsername.length === 0)
    throw new Error("runEsxcliCommand: 'sshUsername' must be non-empty.");
if (sshPassword == null) throw new Error("runEsxcliCommand: 'sshPassword' must not be null.");
if (typeof commandLine !== "string" || commandLine.length === 0)
    throw new Error("runEsxcliCommand: 'commandLine' must be non-empty.");
if (typeof timeoutSeconds !== "number" || timeoutSeconds < 1) timeoutSeconds = 300;
if (typeof logCommand !== "boolean") logCommand = true;

var hostFqdn = String(targetHost.name);

var result = new Properties();
result.put("exitCode", -1);
result.put("stdout", "");
result.put("stderr", "");
result.put("durationSec", 0);
result.put("success", false);

if (logCommand) {
    auditLogger.auditLog(
        LOG_PREFIX, "EXECUTE", "OK",
        "Running esxcli command | host=" + hostFqdn +
        " | timeoutSec=" + timeoutSeconds + " | cmd=" + commandLine
    );
}

var startMs = (new Date()).getTime();

var sshSession = null;
try {
    sshSession = new SSHSession(hostFqdn, 22);
    sshSession.connectWithPassword(sshUsername, String(sshPassword));
} catch (e) {
    if (sshSession != null) {
        try { sshSession.disconnect(); } catch (ignored) { /* swallow */ }
    }
    throw new Error(
        "runEsxcliCommand: SSH connect failed | host=" + hostFqdn +
        " | user=" + sshUsername + " | error=" + e.message
    );
}

try {
    sshSession.executeCommand(commandLine, true);
    var endMs = (new Date()).getTime();

    var exitCode = sshSession.exitCode;
    var stdout   = sshSession.output != null ? String(sshSession.output) : "";
    var stderr   = sshSession.error != null  ? String(sshSession.error)  : "";

    result.put("exitCode", exitCode);
    result.put("stdout", stdout);
    result.put("stderr", stderr);
    result.put("durationSec", Math.round((endMs - startMs) / 1000));
    result.put("success", exitCode === 0);

    auditLogger.auditLog(
        LOG_PREFIX, "EXECUTE",
        exitCode === 0 ? "DONE" : "FAIL",
        "esxcli command finished | host=" + hostFqdn +
        " | exit=" + exitCode +
        " | durationSec=" + result.get("durationSec") +
        " | stdoutLen=" + stdout.length +
        " | stderrLen=" + stderr.length
    );

    return result;
} finally {
    try { sshSession.disconnect(); } catch (ignored) { /* swallow */ }
}
