<#
.SYNOPSIS
    Deletes files older than a retention period from a file share.

.DESCRIPTION
    This is the Windows half of the "Remove Old Archived Logs" automation -- the
    housekeeping partner to Move-ArchivedLogs.ps1. The move workflow fills the archive
    share up; this one keeps it from filling up forever.

    It lives in Orchestrator as a Resource Element. At run time Orchestrator writes this
    file to the PowerShell host, runs it with the parameters below, then deletes it.

    SAFETY
    ReportOnly defaults to 'yes'. A run that is not explicitly told to delete will only
    ever list what it would have deleted. This replaces an interactive "are you sure?"
    prompt in the original script, which could not work unattended -- there is nobody
    at a console to answer it, so it either hung the job or silently cancelled it.

.PARAMETER Path
    UNC path to clean up. Example: \\fileserver.vcf.lab\mdcarchivelog$\Windows

.PARAMETER FileFilter
    Which files to consider. Example: Archive-*.evtx. Default is every file.

.PARAMETER OlderThanDays
    Delete files last written MORE than this many days ago. Must be at least 1, so a
    mistyped 0 cannot wipe the share. A file exactly this old is kept.

.PARAMETER ReportOnly
    'yes' (default) lists what would be deleted and deletes nothing. 'no' deletes.

.NOTES
    Requires PowerShell 5.1 or later.
    Files only -- empty folders are left in place.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [string]$FileFilter = '*',

    [int]$OlderThanDays = 370,

    [ValidateSet('yes', 'no')]
    [string]$ReportOnly = 'yes'
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Logging -- identical contract to Move-ArchivedLogs.ps1 on purpose, so both
# scripts are read by the same Orchestrator action and look the same in the log.
# ---------------------------------------------------------------------------
$script:ErrorMessages = New-Object System.Collections.ArrayList

function Write-Log {
    param(
        [string]$Message,
        [ValidateSet('INFO', 'WARN', 'ERROR')]
        [string]$Level = 'INFO'
    )
    if ($Level -eq 'ERROR') { [void]$script:ErrorMessages.Add($Message) }
    Write-Host ('{0}  {1,-5}  {2}' -f (Get-Date).ToString('HH:mm:ss'), $Level, $Message)
}

# The single line Orchestrator parses. See Move-ArchivedLogs.ps1 for why.
function Write-Result {
    param([hashtable]$Data)

    $shortErrors = @($script:ErrorMessages | Select-Object -First 10 | ForEach-Object {
        if ($_.Length -gt 120) { $_.Substring(0, 117) + '...' } else { $_ }
    })

    $Data['errorCount'] = $script:ErrorMessages.Count
    $Data['errors']     = $shortErrors

    Write-Host ('PSO_RESULT=' + ($Data | ConvertTo-Json -Compress -Depth 4))
}

# ---------------------------------------------------------------------------
# Check the inputs before deleting anything
# ---------------------------------------------------------------------------
$reportOnlyMode = ($ReportOnly -eq 'yes')

if ($OlderThanDays -lt 1) {
    Write-Log "OlderThanDays must be at least 1, but was $OlderThanDays. Nothing was deleted." 'ERROR'
    Write-Result @{ deleted = 0; matched = 0 }
    return
}

# A UNC path written with an IP address cannot authenticate with Kerberos: a service
# principal name is built from a host name, and none exists for an IP literal, so the
# connection silently drops to NTLM and is refused. It presents as a share-permissions
# problem, and no amount of delegation work fixes it. This is a warning rather than a
# stop -- a local path or a mapped drive is legitimate -- but it names the cause up
# front, because the symptom points somewhere else entirely.
if ($Path -match '^\\\\(\d{1,3}\.){3}\d{1,3}\\') {
    Write-Log ("Path is addressed by IP address. Run through WinRM this cannot use Kerberos " +
               "and will most likely be refused as 'Access is denied'. Use the file server's " +
               "FQDN instead.") 'WARN'
}

# What a failure reports alongside the error. Windows says 'Access is denied' and nothing
# else, which leaves a reader unable to tell being unable to list the share from being
# unable to delete from it -- and those are different permissions with different fixes.
# Updated as the work moves on, so whatever fails names the operation it failed on.
$stage = "reaching $Path"

if (-not (Test-Path -LiteralPath $Path)) {
    Write-Log "Path is not reachable: $Path. Nothing was deleted." 'ERROR'
    Write-Result @{ deleted = 0; matched = 0 }
    return
}

$cutoff = (Get-Date).AddDays(-$OlderThanDays)

Write-Log "Path            : $Path"
Write-Log "Deleting files matching '$FileFilter' last written before $($cutoff.ToString('yyyy-MM-dd HH:mm:ss'))"
Write-Log "Retention       : $OlderThanDays days"

if ($reportOnlyMode) {
    Write-Log "REPORT ONLY - listing what would be deleted. No files will be removed." 'WARN'
    # Listing needs read; deleting needs delete. A report-only run exercises the first
    # and never the second, so a clean report says nothing about whether the live run
    # will be allowed to remove anything.
    Write-Log "A clean report proves these files can be listed, not that they can be deleted." 'WARN'
}

# ---------------------------------------------------------------------------
# Find the files, then delete them one at a time
#
# Deleting individually (rather than piping the whole set into Remove-Item) means
# one locked or permission-denied file is reported and skipped instead of stopping
# the whole cleanup.
#
# The enumeration is guarded twice, because Test-Path above proves less than it looks:
# reaching a path needs only traverse rights, so it passes on a share that cannot
# actually be listed.
#
#   -ErrorAction SilentlyContinue with -ErrorVariable  keeps the walk going past a
#   subfolder that cannot be read, and records each one so it can be logged below.
#   Without it $ErrorActionPreference = 'Stop' turns the first unreadable subfolder
#   into a terminating error and abandons the rest of the share.
#
#   The try/catch is the backstop for a failure that terminates anyway. It matters
#   because an unguarded throw here kills the script BEFORE it writes its PSO_RESULT
#   line, and Orchestrator then reports 'did not report a result' -- which reads as
#   "the script never ran", when in fact it ran and was denied.
# ---------------------------------------------------------------------------
$stage       = "listing files in $Path"
$listErrors  = @()

try {
    $candidates = @(
        Get-ChildItem -LiteralPath $Path -Filter $FileFilter -File -Recurse `
                      -ErrorAction SilentlyContinue -ErrorVariable listErrors |
            Where-Object { $_.LastWriteTime -lt $cutoff }
    )
}
catch {
    Write-Log "$($_.Exception.Message) - while $stage. Nothing was deleted." 'ERROR'
    Write-Result @{ deleted = 0; matched = 0 }
    return
}

# Each folder that could not be read is an error in its own right. The cleanup still ran
# everywhere else, but a run that quietly skipped half the share must not look clean.
foreach ($listError in $listErrors) {
    $target = if ($listError.TargetObject) { $listError.TargetObject } else { $Path }
    Write-Log "could not list $target - $($listError.Exception.Message)" 'ERROR'
}

Write-Log "Files matched   : $($candidates.Count)"

$deleted   = 0
$freedBytes = 0

foreach ($file in $candidates) {

    if ($reportOnlyMode) {
        Write-Log "would delete $($file.FullName)  (last written $($file.LastWriteTime.ToString('yyyy-MM-dd')))"
        $deleted++
        $freedBytes += $file.Length
        continue
    }

    try {
        $size = $file.Length
        Remove-Item -LiteralPath $file.FullName -Force
        $deleted++
        $freedBytes += $size
    }
    catch {
        Write-Log "could not delete $($file.FullName) - $($_.Exception.Message)" 'ERROR'
    }
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
$freedMb = [math]::Round($freedBytes / 1MB, 2)

Write-Log "==============================================="
if ($reportOnlyMode) {
    Write-Log "Files that would be deleted : $deleted  ($freedMb MB)  (report only - nothing was deleted)"
}
else {
    Write-Log "Files deleted   : $deleted  ($freedMb MB freed)"
}
Write-Log "Errors          : $($script:ErrorMessages.Count)"

Write-Result @{
    matched    = $candidates.Count
    deleted    = $deleted
    freedMB    = $freedMb
    reportOnly = $reportOnlyMode
}
