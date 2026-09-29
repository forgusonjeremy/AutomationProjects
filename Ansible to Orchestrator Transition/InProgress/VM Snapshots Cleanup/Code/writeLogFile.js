/**
 * ACTION: writeLogFile
 * vRO Action — writes the run log to a network share.
 * Share type (NFS/SMB), path, and credentials come from a vRO Configuration Element.
 *
 * Inputs:
 *   logEntriesJson : string  — JSON array of log entry objects
 *   runId          : string  — unique run identifier (timestamp-based)
 *   dryRun         : boolean
 *
 * Configuration element path: "SnapshotCleanup/FileLogging"
 * Attributes read:
 *   shareType        : string  — "nfs" or "smb"
 *   nfsPath          : string  — e.g. "/mnt/logs/snapshot-cleanup"  (NFS mount path on vRO appliance)
 *   smbUncPath       : string  — e.g. "\\fileserver\logs\snapshot-cleanup"
 *   smbUsername      : string
 *   smbPassword      : SecureString
 *   logFormat        : string  — "json" or "csv"
 *
 * For NFS: vRO appliance must have the NFS share mounted at nfsPath.
 *          We write via Java File I/O (vRO supports java.io in scriptable tasks).
 * For SMB: We use the vRO REST plugin to POST to a samba-capable REST bridge,
 *          OR write via net use / smbclient via vRO SSH action.
 *          In VCF 9 embedded vRO, the cleanest approach is to write via
 *          the vRO file system action on a mounted CIFS path.
 *
 * Returns: JSON { success: boolean, filePath: string, error: string|null }
 */

var result = { success: false, filePath: null, error: null };

try {
    // Read configuration element
    var configCat = Server.getConfigurationElementCategoryWithPath("SnapshotCleanup");
    var configEl  = null;
    var elements  = configCat.configurationElements;
    for each (var el in elements) {
        if (el.name === "FileLogging") { configEl = el; break; }
    }
    if (!configEl) throw new Error("Configuration element 'SnapshotCleanup/FileLogging' not found");

    var shareType   = configEl.getAttributeWithKey("shareType").value   || "nfs";
    var logFormat   = configEl.getAttributeWithKey("logFormat").value   || "json";
    var nfsPath     = configEl.getAttributeWithKey("nfsPath").value     || "";
    var smbUncPath  = configEl.getAttributeWithKey("smbUncPath").value  || "";
    var smbUsername = configEl.getAttributeWithKey("smbUsername").value || "";
    var smbPassword = configEl.getAttributeWithKey("smbPassword").value || "";

    var dryRunTag = dryRun ? "_DRYRUN" : "";
    var timestamp = runId || new Date().toISOString().replace(/[:.]/g, "-");
    var filename  = "snapshot-cleanup_" + timestamp + dryRunTag + "." + logFormat;

    var logEntries = JSON.parse(logEntriesJson || "[]");
    var fileContent = "";

    if (logFormat === "csv") {
        // CSV header
        var csvHeader = "runId,timestamp,vCenter,vmName,vmPowerState,snapshotName,snapshotAgeMinutes," +
                        "action,success,skipReason,datastores,durationMs,error\n";
        var csvRows = "";
        for each (var entry in logEntries) {
            csvRows += [
                csvEscape(runId),
                csvEscape(new Date(entry.timestampMs || 0).toISOString()),
                csvEscape(entry.vCenter        || ""),
                csvEscape(entry.vmName         || ""),
                csvEscape(entry.vmPowerState   || ""),
                csvEscape(entry.snapshotName   || ""),
                entry.snapshotAgeMinutes       || 0,
                csvEscape(entry.action         || ""),
                entry.success ? "true" : "false",
                csvEscape(entry.skipReason     || ""),
                csvEscape((entry.datastoreMoRefs || []).join("|")),
                entry.durationMs               || 0,
                csvEscape(entry.error          || "")
            ].join(",") + "\n";
        }
        fileContent = csvHeader + csvRows;
    } else {
        // JSON — structured, pretty printed
        var output = {
            runId:       runId,
            generatedAt: new Date().toISOString(),
            dryRun:      dryRun,
            entryCount:  logEntries.length,
            entries:     logEntries
        };
        fileContent = JSON.stringify(output, null, 2);
    }

    // Write to share
    if (shareType === "nfs") {
        // NFS: write via java.io.FileWriter (vRO scripting supports java.io)
        if (!nfsPath) throw new Error("nfsPath not configured");
        var fullPath = nfsPath.replace(/\/$/, "") + "/" + filename;
        var file = new java.io.File(fullPath);
        // Ensure parent directory exists
        file.getParentFile().mkdirs();
        var writer = new java.io.FileWriter(file);
        writer.write(fileContent);
        writer.flush();
        writer.close();
        result.filePath = fullPath;
        result.success  = true;
        System.log("Log written to NFS: " + fullPath);

    } else {
        // SMB/CIFS: write via mounted CIFS path using java.io.FileWriter
        // The SMB share must be mounted on the vRO appliance at a local path.
        // smbUncPath is treated as the local mount point path (e.g. /mnt/smb/logs)
        // Mounting is done at the OS level; vRO writes to it as a local filesystem.
        if (!smbUncPath) throw new Error("smbUncPath not configured");
        var smbFullPath = smbUncPath.replace(/[\/\\]+$/, "") + "/" + filename;
        // Normalise path separators for Linux vRO appliance
        smbFullPath = smbFullPath.replace(/\\/g, "/");
        var smbFile = new java.io.File(smbFullPath);
        smbFile.getParentFile().mkdirs();
        var smbWriter = new java.io.FileWriter(smbFile);
        smbWriter.write(fileContent);
        smbWriter.flush();
        smbWriter.close();
        result.filePath = smbFullPath;
        result.success  = true;
        System.log("Log written to SMB: " + smbFullPath);
    }

} catch(e) {
    result.error = e.message;
    System.error("writeLogFile failed: " + e.message);
}

return JSON.stringify(result);

function csvEscape(val) {
    var s = String(val || "");
    if (s.indexOf(",") !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1) {
        s = '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}
