<#
.SYNOPSIS
    Moves matching files off a list of Windows servers to a per-server folder on a file share.

.DESCRIPTION
    This is the Windows half of the "Move Archived Logs" automation.

    It lives in Orchestrator as a Resource Element. At run time Orchestrator writes
    this file to the PowerShell host, runs it with the parameters below, then deletes
    it. Nothing is pre-staged and nothing is left behind.

    The script does NOT talk to Active Directory. Orchestrator's AD plug-in works out
    which servers to process and hands the list in via -ComputerNames. That is the
    single biggest difference from the Ansible playbooks this replaces.

    HOW IT REACHES THE FILES
    Everything runs from one host and reaches each server over UNC:

        \\<server>\C$\Windows\System32\winevt\Logs   ->   \\<share>\Windows\<server>\

    So the PowerShell host needs admin-share access to each server and write access to
    the destination share. It does not run anything on the target servers themselves.

.PARAMETER ComputerNames
    Comma-separated server names (FQDNs), supplied by Orchestrator.

.PARAMETER SourcePath
    Path on each server, relative to \\<server>\. Example: C$\Windows\System32\winevt\Logs

.PARAMETER TargetPath
    Destination share root. A per-server subfolder is created beneath it.
    Example: \\fileserver.vcf.lab\mdcarchivelog$\Windows

.PARAMETER FileFilter
    Which files to move. Example: Archive-*.evtx

.PARAMETER OlderThanDays
    Only move files last written MORE than this many days ago. 0 means "all ages".
    A file exactly this old is kept. Negative values are rejected.

.PARAMETER ReportOnly
    'yes' (default) lists what would move and changes nothing. 'no' performs the move.

.PARAMETER OverwriteExisting
    'no' (default) refuses to overwrite a file that already exists at the destination
    and reports it as an error, leaving the source file alone. 'yes' overwrites.

.NOTES
    Requires PowerShell 5.1 or later.

    Four things behave differently from the Ansible playbooks. All four are
    deliberate corrections -- see Documentation/02_Design-Decisions.md.
      1. File counts are accurate (the playbooks double-counted every move).
      2. OlderThanDays counts backwards, as its name implies (the playbooks
         counted forwards, so a bigger number moved MORE files, not fewer).
      3. Subfolder structure is preserved, so two files with the same name in
         different folders no longer silently overwrite each other.
      4. Nothing is moved unless ReportOnly is 'no'.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ComputerNames,

    [Parameter(Mandatory = $true)]
    [string]$SourcePath,

    [Parameter(Mandatory = $true)]
    [string]$TargetPath,

    [string]$FileFilter = '*',

    [int]$OlderThanDays = 0,

    [ValidateSet('yes', 'no')]
    [string]$ReportOnly = 'yes',

    [ValidateSet('yes', 'no')]
    [string]$OverwriteExisting = 'no'
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Logging
#
# Every line written here ends up in the Orchestrator run log, so this is what
# an operator actually reads afterwards. Errors are also collected so the run
# can report how many there were without anyone having to count log lines.
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

# ---------------------------------------------------------------------------
# The one line Orchestrator parses
#
# Orchestrator reads the run's outcome from a single line of the form:
#
#     PSO_RESULT={"moved":12,"errorCount":0,...}
#
# Everything else in the output is for humans. Keeping the machine-readable part
# to one short line means the log wording can change freely without breaking
# Orchestrator, and it stays on one line so it cannot get split in transit.
# ---------------------------------------------------------------------------
function Write-Result {
    param([hashtable]$Data)

    # Only the first few errors go in the line, shortened. The full text of every
    # error is already in the log above.
    $shortErrors = @($script:ErrorMessages | Select-Object -First 10 | ForEach-Object {
        if ($_.Length -gt 120) { $_.Substring(0, 117) + '...' } else { $_ }
    })

    $Data['errorCount'] = $script:ErrorMessages.Count
    $Data['errors']     = $shortErrors

    Write-Host ('PSO_RESULT=' + ($Data | ConvertTo-Json -Compress -Depth 4))
}

# ---------------------------------------------------------------------------
# Check the inputs before touching anything
# ---------------------------------------------------------------------------
$reportOnlyMode = ($ReportOnly -eq 'yes')
$allowOverwrite = ($OverwriteExisting -eq 'yes')

$servers = @($ComputerNames -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })

if ($OlderThanDays -lt 0) {
    Write-Log "OlderThanDays must be 0 or greater, but was $OlderThanDays. Nothing was moved." 'ERROR'
    Write-Result @{ serversProcessed = 0; moved = 0; skipped = 0 }
    return
}

if ($servers.Count -eq 0) {
    Write-Log "No servers were supplied, so there is nothing to do." 'WARN'
    Write-Result @{ serversProcessed = 0; moved = 0; skipped = 0 }
    return
}

# "Older than N days" means the file was last written before this moment.
$cutoff = (Get-Date).AddDays(-$OlderThanDays)

$TargetPath = $TargetPath.TrimEnd('\')

Write-Log "Servers to process : $($servers.Count)"
Write-Log "Source on each     : \\<server>\$SourcePath"
Write-Log "Destination        : $TargetPath\<server>"
Write-Log "Selecting files matching '$FileFilter' last written before $($cutoff.ToString('yyyy-MM-dd HH:mm:ss'))"

if ($reportOnlyMode) {
    Write-Log "REPORT ONLY - listing what would move. No files will be touched." 'WARN'
}

# ---------------------------------------------------------------------------
# Do the work, one server at a time
#
# A server that fails is logged and the loop carries on. One unreachable machine
# must not stop the other twenty from being cleaned up.
# ---------------------------------------------------------------------------
$totalMoved   = 0
$totalSkipped = 0
$serversOk    = 0

foreach ($server in $servers) {

    $shortName  = $server.Split('.')[0]
    $sourceRoot = ("\\$server\$SourcePath").TrimEnd('\')
    $serverDest = Join-Path $TargetPath $shortName

    Write-Log "--- $server ---"

    try {
        if (-not (Test-Path -LiteralPath $sourceRoot)) {
            throw "Source path is not reachable: $sourceRoot"
        }

        $candidates = @(
            Get-ChildItem -LiteralPath $sourceRoot -Filter $FileFilter -File -Recurse |
                Where-Object { $_.LastWriteTime -lt $cutoff }
        )

        if ($candidates.Count -eq 0) {
            Write-Log "$server : nothing matched. Moved 0 files."
            $serversOk++
            continue
        }

        if (-not $reportOnlyMode -and -not (Test-Path -LiteralPath $serverDest)) {
            New-Item -ItemType Directory -Path $serverDest -Force | Out-Null
            Write-Log "$server : created destination folder $serverDest"
        }

        $movedHere   = 0
        $skippedHere = 0

        foreach ($file in $candidates) {

            # Keep whatever subfolder the file was in, so two files with the same
            # name in different folders do not collide at the destination.
            $relativePath = $file.FullName.Substring($sourceRoot.Length).TrimStart('\')
            $destFile     = Join-Path $serverDest $relativePath
            $destFolder   = Split-Path -Path $destFile -Parent

            if ($reportOnlyMode) {
                Write-Log "$server : would move $($file.FullName) -> $destFile"
                $movedHere++
                continue
            }

            try {
                if ((Test-Path -LiteralPath $destFile) -and -not $allowOverwrite) {
                    Write-Log "$server : destination file already exists, source left in place: $destFile" 'ERROR'
                    $skippedHere++
                    continue
                }

                if (-not (Test-Path -LiteralPath $destFolder)) {
                    New-Item -ItemType Directory -Path $destFolder -Force | Out-Null
                }

                Move-Item -LiteralPath $file.FullName -Destination $destFile -Force:$allowOverwrite
                $movedHere++
            }
            catch {
                Write-Log "$server : could not move $($file.FullName) - $($_.Exception.Message)" 'ERROR'
                $skippedHere++
            }
        }

        if ($reportOnlyMode) {
            Write-Log "$server : would move $movedHere file(s)."
        }
        else {
            Write-Log "$server : moved $movedHere file(s), skipped $skippedHere."
        }

        $totalMoved   += $movedHere
        $totalSkipped += $skippedHere
        $serversOk++
    }
    catch {
        # Whole-server failure: offline, no admin share, or permissions.
        Write-Log "$server : $($_.Exception.Message)" 'ERROR'
    }
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
Write-Log "==============================================="
Write-Log "Servers processed : $serversOk of $($servers.Count)"
if ($reportOnlyMode) {
    Write-Log "Files that would move : $totalMoved  (report only - nothing was moved)"
}
else {
    Write-Log "Files moved       : $totalMoved"
    Write-Log "Files skipped     : $totalSkipped"
}
Write-Log "Errors            : $($script:ErrorMessages.Count)"

Write-Result @{
    serversProcessed = $serversOk
    serversRequested = $servers.Count
    moved            = $totalMoved
    skipped          = $totalSkipped
    reportOnly       = $reportOnlyMode
}
