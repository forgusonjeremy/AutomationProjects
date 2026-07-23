/**
 * Action: buildCleanDisksInvocation
 * Module:  broadcom.pso.vcf.vm.guestOps.files.windows.diskcleanup
 *
 * Purpose:
 *   Builds the PowerShell invocation string for the clean-ServerDisk action in
 *   cvs_functions.ps1.  AD resolution, per-server iteration, folder-list parsing,
 *   the age/filter selection and the report-only/live decision are ALL handled
 *   inside the script - Orchestrator only passes values through and classifies the
 *   resulting transcript.
 *
 *   What the script does with these values (see Change-Register S-14 / S-15):
 *     - Resolves the DIRECT (non-recursive) ENABLED COMPUTER members of the group
 *       via Get-ListOfServers-Direct.  Nested sub-groups are never expanded and
 *       disabled/decommissioned computer accounts are skipped and logged.  Disk
 *       cleaning deletes files, so membership is deliberately explicit - only what
 *       the operator placed directly in the group is a target.
 *     - Splits FolderTarget into one or more admin-share paths per server
 *       (c:\path -> \\server\c$\path) and cleans each via Remove-files.
 *     - Removes items whose LastWriteTime is older than (today + NumberOfDays),
 *       matching FilterOn, honouring FolderIncluded (delete folders too) and
 *       ForceEnable (remove read-only/hidden items).  Always excludes
 *       vmware-vmsvc-SYSTEM.log.
 *     - Per-server failures are isolated and logged; one unreachable server does
 *       not stop the rest.
 *
 * Safety gate:
 *   whatIf maps to the script's -WhatIf parameter.  'yes' = REPORT ONLY (list the
 *   files that WOULD be deleted, delete nothing).  'no' = LIVE DELETE.  The script
 *   fails safe: any value that is not exactly 'no' is treated as report-only.  The
 *   recommended workflow-input default is 'yes'.
 *
 * Group identity:
 *   Passed to the script as -ADGroupMember, which hands it to Get-ADGroupMember
 *   -Identity.  A distinguishedName (DN) is the preferred, unambiguous form - e.g.
 *   CN=CVS-DPT-AllServers,OU=Groups,DC=vcf,DC=lab.  CN / sAMAccountName / GUID /
 *   SID also resolve.
 *
 * Inputs:
 *   scriptPath     (string)  - Full path to cvs_functions.ps1 on the PS host
 *   groupDN        (string)  - AD group DN (preferred) or CN/sAMAccountName/GUID/SID  -> -ADGroupMember
 *   domainName     (string)  - AD domain, used as -Server target                      -> -DomainName
 *   folderTarget   (string)  - One or more local paths to clean, comma-separated,
 *                              e.g. 'c:\Windows\ccmcache' or 'c:\Windows\ccmcache,c:\Temp'.
 *                              Each c:\path is rewritten to \\server\c$\path.          -> -FolderTarget
 *   fileFilter     (string)  - File-name filter, e.g. '*.*'                            -> -FilterOn
 *   fileAgeDays    (number)  - Delete items older than N days.  Uses the script's
 *                              AddDays() convention: 0 (all) or negative (e.g. -1 =
 *                              items last written before yesterday).                    -> -NumberOfDays
 *   folderIncluded (boolean) - true = also delete folders; false = files only          -> -FolderIncluded ('yes'/'no')
 *   forceEnable    (boolean) - true = remove read-only/hidden items (-Force)           -> -ForceEnable ('yes'/'no')
 *   whatIf         (string)  - 'yes' = report only (default, safe); 'no' = live delete -> -WhatIf
 *
 * Return type: string
 */

// ── Input validation ──────────────────────────────────────────────────────────

if (!scriptPath || scriptPath.trim() === "") {
    throw new Error("buildCleanDisksInvocation: scriptPath is required and must not be empty.");
}
if (!groupDN || groupDN.trim() === "") {
    throw new Error("buildCleanDisksInvocation: groupDN is required and must not be empty.");
}
if (!domainName || domainName.trim() === "") {
    throw new Error("buildCleanDisksInvocation: domainName is required and must not be empty.");
}
if (!folderTarget || folderTarget.trim() === "") {
    throw new Error("buildCleanDisksInvocation: folderTarget is required and must not be empty (e.g. 'c:\\Windows\\ccmcache').");
}
if (!fileFilter || fileFilter.trim() === "") {
    throw new Error("buildCleanDisksInvocation: fileFilter is required and must not be empty (e.g. '*.*').");
}

// fileAgeDays must be a whole number. The clean uses (Get-Date).AddDays(N), so a
// value of 0 (all items) or a negative value (older than |N| days) is expected;
// positive values are unusual but permitted (they select future-dated items only).
if (fileAgeDays === null || fileAgeDays === undefined || String(fileAgeDays).trim() === "") {
    throw new Error("buildCleanDisksInvocation: fileAgeDays is required.");
}
var ageDays = parseInt(fileAgeDays, 10);
if (isNaN(ageDays) || String(ageDays) !== String(fileAgeDays).trim()) {
    throw new Error(
        "buildCleanDisksInvocation: fileAgeDays must be a whole number (e.g. -1, 0). Received: " + fileAgeDays
    );
}

// whatIf is the sole safety control for a DESTRUCTIVE action. Require an explicit
// 'yes' or 'no'; the script fails safe on anything else, but a typo should not
// silently become "report only" without the operator noticing.
var wi = (whatIf === null || whatIf === undefined) ? "" : String(whatIf).trim().toLowerCase();
if (wi !== "yes" && wi !== "no") {
    throw new Error(
        "buildCleanDisksInvocation: whatIf must be 'yes' (report only) or 'no' (live delete). Received: " + whatIf
    );
}

// ── Safety nudges (warn, do not fail) ─────────────────────────────────────────

// Make a LIVE delete run unmistakable in the log (mirrors the reboot 'simpleMode'
// warn). whatIf='yes' is the safe report-only default.
if (wi === "no") {
    System.warn(
        "buildCleanDisksInvocation | whatIf='no' - this run WILL DELETE matching items from '" +
        folderTarget.trim() + "' on every direct, enabled member of '" + groupDN.trim() +
        "'. Set whatIf='yes' for a report-only preview."
    );
} else {
    System.log("buildCleanDisksInvocation | whatIf='yes' - report-only run; nothing will be deleted.");
}

// Dangerous-root nudge: warn if any folder target resolves to a drive root or a
// critical system directory. cvs_functions.ps1 excludes vmware-vmsvc-SYSTEM.log and
// honours fileAgeDays, but a bare 'c:\' or 'c:\Windows' target is almost never
// intended. This is a warning only - the operator remains in control.
var targets = folderTarget.split(",");
for (var t = 0; t < targets.length; t++) {
    var tgt = targets[t].trim();
    if (tgt === "") { continue; }
    var norm = tgt.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
    if (/^[a-z]:$/.test(norm) || /^[a-z]:\\?$/.test(norm) ||
        norm === "c:\\windows" || norm === "c:\\windows\\system32" || norm === "c:\\users") {
        System.warn(
            "buildCleanDisksInvocation | folderTarget entry '" + tgt + "' resolves to a drive root or " +
            "critical system directory. Confirm this is intended before running with whatIf='no'."
        );
    }
}

// DN nudge: warn (do not fail) when the identifier does not look like a DN, so
// CN / sAMAccountName still work but operators are steered toward the DN form.
if (groupDN.trim().toUpperCase().indexOf("DC=") === -1) {
    System.warn(
        "buildCleanDisksInvocation | groupDN='" + groupDN.trim() +
        "' does not look like a distinguishedName (no 'DC=' component). It will be " +
        "passed to Get-ADGroupMember -Identity as-is, but a full DN is recommended " +
        "for unambiguous group resolution."
    );
}

// ── Build invocation string ───────────────────────────────────────────────────
//
// Script parameters confirmed from the cvs_functions.ps1 param block:
//   -Action          'clean-ServerDisk'  (member of the ValidateSet)
//   -ADGroupMember   ← groupDN           (Get-ListOfServers-Direct -SecurityGroup)
//   -DomainName      ← domainName
//   -FolderTarget    ← folderTarget      (Convert-YAMLList + split ',' inside the script)
//   -FilterOn        ← fileFilter
//   -NumberOfDays    ← fileAgeDays        (Remove-files (Get-Date).AddDays(N))
//   -FolderIncluded  ← 'yes'/'no'
//   -ForceEnable     ← 'yes'/'no'
//   -WhatIf          ← 'yes'/'no'         (safety gate: only 'no' deletes)
//
// Single-quote escaping: PowerShell escapes a single quote inside a single-quoted
// string by doubling it. A DN or path containing an apostrophe (e.g. OU=O'Brien)
// would otherwise terminate the string early and corrupt the command.
function psQuote(value) {
    return "'" + String(value === null || value === undefined ? "" : value).replace(/'/g, "''") + "'";
}

// Stream capture ( *>&1 | Out-String -Width 4096 ):
//   cvs_functions.ps1 emits everything through Write-Log -> Write-Host and
//   Write-Warning. The vRO PowerShell plugin only returns the SUCCESS (pipeline)
//   stream via getRootObject(); Write-Host output is logged but NOT returned, so
//   without this redirect the OOTB "Invoke a PowerShell script" workflow hands back
//   a null output object and parseScriptOutput has nothing to parse. '*>&1' merges
//   all streams into the success stream and 'Out-String' collapses them to a single
//   multi-line string. '-Width 4096' prevents wrapping at the default ~80 cols,
//   which would split a long "Error:" line and truncate parseScriptOutput's scan.

var invocationString =
    "& \"" + scriptPath.trim() + "\"" +
    " -Action 'clean-ServerDisk'" +
    " -ADGroupMember " + psQuote(groupDN.trim()) +
    " -DomainName " + psQuote(domainName.trim()) +
    " -FolderTarget " + psQuote(folderTarget.trim()) +
    " -FilterOn " + psQuote(fileFilter.trim()) +
    " -NumberOfDays '" + ageDays + "'" +
    " -FolderIncluded '" + (folderIncluded === true ? "yes" : "no") + "'" +
    " -ForceEnable '" + (forceEnable === true ? "yes" : "no") + "'" +
    " -WhatIf '" + wi + "'" +
    " *>&1 | Out-String -Width 4096";

System.log(
    "buildCleanDisksInvocation | scriptPath=" + scriptPath +
    " | groupDN=" + groupDN +
    " | domainName=" + domainName +
    " | folderTarget=" + folderTarget +
    " | fileFilter=" + fileFilter +
    " | fileAgeDays=" + ageDays +
    " | folderIncluded=" + (folderIncluded === true) +
    " | forceEnable=" + (forceEnable === true) +
    " | whatIf=" + wi
);
System.log("buildCleanDisksInvocation | invocationString=" + invocationString);

return invocationString;
