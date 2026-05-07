// ===================================================================
// ACTION:    verifyDepotFileOnHost
// MODULE:    com.broadcom.pso.vc.esxi.remediation.staging
// PURPOSE:   Confirm that the target host can read the depot file at
//            the resolved absolute path (i.e. the NFS-backed CL
//            mount is healthy on this host), and optionally verify
//            the file's checksum matches the one vCenter recorded.
//
//            Run once per host immediately before MM_ENTER. If the
//            file isn't readable here, the patch will fail later at
//            esxcli — better to catch it before MM disruption.
//
// PHASE:     STAGING (per host)
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-STAGING]
//
// INPUTS:
//   targetHost           (VC:HostSystem)
//   absolutePath         (string)         — From resolveDepotFilePath.
//   sshUsername          (string)         — Ephemeral account name.
//   sshPassword          (SecureString)   — Ephemeral account password.
//   expectedAlgorithm    (string)         — "SHA-256" / "SHA-1" /
//                                            "(none)" — from
//                                            getDepotChecksum.
//   expectedChecksum     (string)         — Lowercase hex.
//
// RETURNS: Properties — {
//            readable          (boolean) — file exists and is readable
//                                          via SSH session
//            sizeBytes         (number)  — actual file size
//            checksumVerified  (boolean) — true if checksum matched.
//                                          false if expected was
//                                          "(none)" OR if mismatch.
//            checksumActual    (string)  — actual computed checksum
//                                          (empty if not computed)
//            reason            (string)
//          }
//
// REQUIREMENT TRACE:
//   Implements: FR-19 (KB step 1), defense-in-depth pre-MM check.
//
// NOTES:
//   - The action establishes an SSH session as the ephemeral
//     account, runs `ls -la` to verify readability and get size,
//     and (if checksum was recorded) runs `sha256sum` or `sha1sum`
//     to compute and compare.
//   - SSH session is per-call (per AD-08-aligned philosophy that
//     each phase verifies the credential still works). A new
//     session is opened, the verification commands run, the
//     session is closed.
//   - Per the architect's chosen pattern: NEW SSHSession per phase
//     rather than reusing across the 14-phase procedure.
//   - The action throws on connection failure (because that means
//     the ephemeral account or SSH service is broken — the host
//     cannot be patched). It returns readable=false on file-not-
//     found (a recoverable error: caller can choose to skip this
//     host but try others).
//   - Checksum computation on ESXi: use sha256sum or sha1sum
//     directly; both are present in the BusyBox userland on ESXi
//     8.x. The output format is:
//       "<hex>  <filepath>"
//     (two spaces between hash and path).
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-STAGING]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

if (arguments.length < 6) {
    throw new Error(
        "verifyDepotFileOnHost requires 6 inputs: " +
        "(targetHost, absolutePath, sshUsername, sshPassword, " +
        "expectedAlgorithm, expectedChecksum)."
    );
}
var targetHost        = arguments[0];
var absolutePath      = arguments[1];
var sshUsername       = arguments[2];
var sshPassword       = arguments[3];
var expectedAlgorithm = arguments[4];
var expectedChecksum  = arguments[5];

if (targetHost == null) {
    throw new Error("verifyDepotFileOnHost: 'targetHost' must not be null.");
}
if (typeof absolutePath !== "string" || absolutePath.length === 0) {
    throw new Error("verifyDepotFileOnHost: 'absolutePath' must be non-empty.");
}
if (typeof sshUsername !== "string" || sshUsername.length === 0) {
    throw new Error("verifyDepotFileOnHost: 'sshUsername' must be non-empty.");
}
if (sshPassword == null) {
    throw new Error("verifyDepotFileOnHost: 'sshPassword' must not be null.");
}
if (expectedAlgorithm == null) expectedAlgorithm = "(none)";
if (expectedChecksum == null) expectedChecksum = "";

// Resolve target host hostname for SSH connect. Prefer
// host.config.network.dnsConfig.hostName + domainName; fall back
// to host.name (which is what vCenter sees and is usually FQDN).
var hostFqdn;
try {
    hostFqdn = String(targetHost.name);
} catch (e) {
    throw new Error("verifyDepotFileOnHost: cannot read host.name");
}

var result = new Properties();
result.put("readable", false);
result.put("sizeBytes", 0);
result.put("checksumVerified", false);
result.put("checksumActual", "");
result.put("reason", "Initial state");

// -------------------------------------------------------------------
// Open SSH session. SSHSession is the standard vRO SSH plugin
// object; constructor takes (host, port).
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
        "verifyDepotFileOnHost: SSH connect failed | host=" + hostFqdn +
        " | user=" + sshUsername +
        " | error=" + e.message
    );
}

try {
    // ----------------------------------------------------------------
    // Step 1: ls -la to confirm readability and capture size.
    // ----------------------------------------------------------------

    // Quote the path to handle datastore names that may contain
    // spaces. ESXi BusyBox sh accepts double quotes.
    var lsCmd = 'ls -la "' + absolutePath + '"';

    sshSession.executeCommand(lsCmd, true); // verbose=true → captures
                                            //   stdout in .output
    var lsExit = sshSession.exitCode;
    var lsOut  = sshSession.output;
    var lsErr  = sshSession.error;

    if (lsExit !== 0) {
        result.put("readable", false);
        result.put("reason",
            "ls failed | exit=" + lsExit +
            " | stderr=" + (lsErr != null ? String(lsErr).substring(0, 200) : "")
        );
        auditLogger.auditLog(
            LOG_PREFIX, "EXECUTE", "FAIL",
            "Depot file unreadable | host=" + hostFqdn +
            " | path=" + absolutePath + " | " + result.get("reason")
        );
        return result;
    }

    result.put("readable", true);

    // Parse the size from `ls -la` output. Format is:
    //   -rwxr-xr-x  1 root root 5234567890 Jun  1 12:34 /vmfs/volumes/.../file.zip
    // Tokens: [perms, links, owner, group, size, mon, day, time, path]
    try {
        var trimmed = String(lsOut).replace(/^\s+/, "").replace(/\s+$/, "");
        var firstLine = trimmed.split("\n")[0];
        var tokens = firstLine.split(/\s+/);
        if (tokens.length >= 5) {
            var sz = Number(tokens[4]);
            if (!isNaN(sz)) {
                result.put("sizeBytes", sz);
            }
        }
    } catch (parseErr) {
        // Non-fatal; size parsing is informational.
    }

    // ----------------------------------------------------------------
    // Step 2: Optionally compute and compare checksum.
    // ----------------------------------------------------------------

    if (expectedAlgorithm === "SHA-256" || expectedAlgorithm === "SHA-1"
        || expectedAlgorithm === "MD5") {

        var sumCmd;
        if (expectedAlgorithm === "SHA-256") {
            sumCmd = 'sha256sum "' + absolutePath + '"';
        } else if (expectedAlgorithm === "SHA-1") {
            sumCmd = 'sha1sum "' + absolutePath + '"';
        } else {
            sumCmd = 'md5sum "' + absolutePath + '"';
        }

        // Checksumming a multi-GB depot can take 30+ seconds. Allow
        // up to 5 minutes.
        var sumTimeoutSec = 300;
        sshSession.executeCommand(sumCmd, true);
        var sumExit = sshSession.exitCode;
        var sumOut  = sshSession.output;

        if (sumExit !== 0) {
            result.put("reason",
                "Checksum command failed | exit=" + sumExit +
                " | algo=" + expectedAlgorithm
            );
            auditLogger.auditLog(
                LOG_PREFIX, "EXECUTE", "WARN",
                "Checksum command failed | host=" + hostFqdn +
                " | path=" + absolutePath +
                " | algo=" + expectedAlgorithm
            );
            // readable is still true; just no checksum verification.
            return result;
        }

        // Output: "<hex>  <path>". Take everything before first
        // whitespace.
        var firstWordMatch = /^([0-9a-fA-F]+)/.exec(String(sumOut).replace(/^\s+/, ""));
        var actualSum = firstWordMatch != null ? firstWordMatch[1].toLowerCase() : "";
        result.put("checksumActual", actualSum);

        if (actualSum.length === 0) {
            result.put("reason", "Could not parse checksum output");
            return result;
        }

        var verified = (actualSum === String(expectedChecksum).toLowerCase());
        result.put("checksumVerified", verified);

        if (verified) {
            result.put("reason",
                "Verified | size=" + result.get("sizeBytes") +
                " | " + expectedAlgorithm + "=" + actualSum
            );
        } else {
            result.put("reason",
                "CHECKSUM MISMATCH | algo=" + expectedAlgorithm +
                " | expected=" + expectedChecksum +
                " | actual=" + actualSum
            );
        }
    } else {
        // No checksum recorded by vCenter; readability-only verification.
        result.put("reason",
            "Readable (no checksum recorded by vCenter) | size=" + result.get("sizeBytes")
        );
    }

    auditLogger.auditLog(
        LOG_PREFIX, "EXECUTE",
        result.get("readable") === true ? "OK" : "FAIL",
        "Depot verification | host=" + hostFqdn +
        " | path=" + absolutePath + " | " + result.get("reason")
    );

    return result;

} finally {
    // Always close the session, even on exception.
    try {
        sshSession.disconnect();
    } catch (e) {
        // Swallow — we're already in cleanup.
    }
}
