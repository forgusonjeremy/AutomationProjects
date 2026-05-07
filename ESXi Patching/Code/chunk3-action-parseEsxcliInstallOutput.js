// ===================================================================
// ACTION:    parseEsxcliInstallOutput
// MODULE:    com.broadcom.pso.vc.esxi.remediation.host
// PURPOSE:   Parse the human-readable output of `esxcli software vib
//            install` into structured data. Used by PATCH_LIST
//            (dry-run output) and PATCH_INSTALL (real-run output)
//            to get accurate counts of installed/removed/skipped
//            VIBs and the post-install reboot-required flag.
//
// PHASE:     PATCH_LIST / PATCH_INSTALL post-processing
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-HOST]
//
// INPUTS:
//   stdout (string) — Captured stdout from runEsxcliCommand on a
//                     `esxcli software vib install` invocation
//                     (with or without --dry-run).
//
// RETURNS: Properties — {
//            installAction      (string)        — "succeeded" |
//                                                  "would succeed" |
//                                                  "failed" |
//                                                  "(unknown)"
//            rebootRequired     (boolean)
//            vibsInstalled      (Array/string)
//            vibsRemoved        (Array/string)
//            vibsSkipped        (Array/string)
//            messageLines       (Array/string)  — raw "Message:" lines
//          }
//
// REQUIREMENT TRACE:
//   Implements: FR-19 step 6 result handling.
//
// NOTES:
//   - `esxcli software vib install` output format (sample for
//     successful install with --no-live-install):
//       Installation Result
//          Message: The update completed successfully, but the
//                   system needs to be rebooted for the changes
//                   to be effective.
//          VIBs Installed: VMware_bootbank_xyz_1.2.3-456,
//                          VMware_bootbank_abc_2.0.0-789
//          VIBs Removed: VMware_bootbank_xyz_1.2.0-100
//          VIBs Skipped:
//          Reboot Required: true
//
//   - Dry-run output uses "Would" prefix:
//       Dry-run Result
//          Message: The update would have completed successfully,
//                   but the system would need to be rebooted...
//          VIBs Would Be Installed: ...
//          VIBs Would Be Removed: ...
//          VIBs Would Be Skipped: ...
//          Reboot Would Be Required: true
//
//   - The action accommodates both formats by matching on
//     case-insensitive substring patterns.
//   - VIB lists are comma-separated and may span multiple lines.
//     We continue collecting tokens until we hit a non-indented
//     line (i.e. a new label).
//   - If the output cannot be parsed (unexpected format), the
//     action returns installAction="(unknown)" with empty arrays.
//     Caller should treat this as "esxcli succeeded but parsing
//     failed" — usually means esxcli was called incorrectly.
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-HOST]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

if (arguments.length < 1) {
    throw new Error("parseEsxcliInstallOutput requires 1 input: stdout (string).");
}
var stdout = arguments[0];

if (typeof stdout !== "string") stdout = String(stdout != null ? stdout : "");

var result = new Properties();
result.put("installAction", "(unknown)");
result.put("rebootRequired", false);
result.put("vibsInstalled", []);
result.put("vibsRemoved", []);
result.put("vibsSkipped", []);
result.put("messageLines", []);

if (stdout.length === 0) {
    auditLogger.auditLog(
        LOG_PREFIX, "EXECUTE", "WARN",
        "parseEsxcliInstallOutput: empty stdout"
    );
    return result;
}

// -------------------------------------------------------------------
// Tokenize lines.
// -------------------------------------------------------------------
var lines = stdout.split("\n");
for (var i = 0; i < lines.length; i++) {
    lines[i] = String(lines[i]).replace(/\s+$/, ""); // rtrim
}

// -------------------------------------------------------------------
// Walk lines and pull out structured fields.
// -------------------------------------------------------------------

var vibsInstalled = [];
var vibsRemoved   = [];
var vibsSkipped   = [];
var messageLines  = [];

// State: which list (if any) are we currently appending tokens to?
var currentList = null;
// "installed"|"removed"|"skipped"|"message"|null

var rebootRequired = false;
var installAction = "(unknown)";

function appendCommaTokens(target, value) {
    var parts = String(value).split(",");
    for (var p = 0; p < parts.length; p++) {
        var trim = parts[p].replace(/^\s+/, "").replace(/\s+$/, "");
        if (trim.length > 0) {
            target.push(trim);
        }
    }
}

for (var li = 0; li < lines.length; li++) {
    var line = lines[li];
    if (line.length === 0) continue;

    // Detect indentation. Tokens that continue a list start with
    // whitespace; new labels start unindented (but the whole "Result"
    // section is indented one level — so labels are at indent 3
    // spaces; continuation lines are at indent 6+ spaces).
    var indent = 0;
    while (indent < line.length && line.charAt(indent) === " ") {
        indent++;
    }
    var stripped = line.substring(indent);

    // Check for known label prefixes.
    var labelMatch = /^(Message|VIBs Installed|VIBs Removed|VIBs Skipped|VIBs Would Be Installed|VIBs Would Be Removed|VIBs Would Be Skipped|Reboot Required|Reboot Would Be Required):\s*(.*)$/i.exec(stripped);

    if (labelMatch != null) {
        var label = labelMatch[1].toLowerCase();
        var value = labelMatch[2] != null ? String(labelMatch[2]) : "";

        // Reset currentList default.
        currentList = null;

        if (label === "message") {
            currentList = "message";
            if (value.length > 0) messageLines.push(value);
        } else if (label === "vibs installed" || label === "vibs would be installed") {
            currentList = "installed";
            if (value.length > 0) appendCommaTokens(vibsInstalled, value);
        } else if (label === "vibs removed" || label === "vibs would be removed") {
            currentList = "removed";
            if (value.length > 0) appendCommaTokens(vibsRemoved, value);
        } else if (label === "vibs skipped" || label === "vibs would be skipped") {
            currentList = "skipped";
            if (value.length > 0) appendCommaTokens(vibsSkipped, value);
        } else if (label === "reboot required" || label === "reboot would be required") {
            currentList = null;
            rebootRequired = (value.toLowerCase() === "true");
        }
        continue;
    }

    // Result-section header lines.
    var headerMatch = /^(Installation Result|Dry-run Result)\s*$/i.exec(stripped);
    if (headerMatch != null) {
        if (headerMatch[1].toLowerCase() === "dry-run result") {
            installAction = "would succeed";
        } else {
            installAction = "succeeded";
        }
        currentList = null;
        continue;
    }

    // Continuation lines: indented and we have a current list.
    if (indent > 0 && currentList != null) {
        var contValue = stripped;
        if (currentList === "installed") {
            appendCommaTokens(vibsInstalled, contValue);
        } else if (currentList === "removed") {
            appendCommaTokens(vibsRemoved, contValue);
        } else if (currentList === "skipped") {
            appendCommaTokens(vibsSkipped, contValue);
        } else if (currentList === "message") {
            messageLines.push(contValue);
        }
    }
}

// If the result block looked like a failure (e.g. an exception was
// printed), set installAction to "failed".
var lowerOut = stdout.toLowerCase();
if (installAction === "(unknown)") {
    if (lowerOut.indexOf("vibsignaturetexception") !== -1
        || lowerOut.indexOf("error:") !== -1
        || lowerOut.indexOf("exception") !== -1) {
        installAction = "failed";
    }
}

result.put("installAction", installAction);
result.put("rebootRequired", rebootRequired);
result.put("vibsInstalled", vibsInstalled);
result.put("vibsRemoved", vibsRemoved);
result.put("vibsSkipped", vibsSkipped);
result.put("messageLines", messageLines);

auditLogger.auditLog(
    LOG_PREFIX, "EXECUTE", "OK",
    "Parsed esxcli output | action=" + installAction +
    " | rebootRequired=" + rebootRequired +
    " | installed=" + vibsInstalled.length +
    " | removed=" + vibsRemoved.length +
    " | skipped=" + vibsSkipped.length
);

return result;
