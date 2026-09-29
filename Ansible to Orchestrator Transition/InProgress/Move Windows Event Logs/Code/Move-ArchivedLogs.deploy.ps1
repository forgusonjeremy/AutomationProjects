# ==============================================================================
# GENERATED FILE -- DO NOT EDIT.
#
# Built from : Move-ArchivedLogs.ps1
# Built on   : 2026-09-23 10:52:09
# By         : Build-ResourceElement.ps1
#
# Comments are stripped to cut the WinRM payload -- runPowerShellScript embeds
# the whole script in the command it sends, so startup time is linear in size.
# Edit the SOURCE and re-run the build; changes made here are lost and, worse,
# will not match what the repository says is deployed.
# ==============================================================================
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
function Write-Result {
    param([hashtable]$Data)
    $shortErrors = @($script:ErrorMessages | Select-Object -First 10 | ForEach-Object {
        if ($_.Length -gt 120) { $_.Substring(0, 117) + '...' } else { $_ }
    })
    $Data['errorCount'] = $script:ErrorMessages.Count
    $Data['errors']     = $shortErrors
    Write-Host ('PSO_RESULT=' + ($Data | ConvertTo-Json -Compress -Depth 4))
}
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
$cutoff = (Get-Date).AddDays(-$OlderThanDays)
$TargetPath = $TargetPath.TrimEnd('\')
Write-Log "Servers to process : $($servers.Count)"
Write-Log "Source on each     : \\<server>\$SourcePath"
Write-Log "Destination        : $TargetPath\<server>"
Write-Log "Selecting files matching '$FileFilter' last written before $($cutoff.ToString('yyyy-MM-dd HH:mm:ss'))"
if ($reportOnlyMode) {
    Write-Log "REPORT ONLY - listing what would move. No files will be touched." 'WARN'
}
$totalMoved   = 0
$totalSkipped = 0
$serversOk    = 0
foreach ($server in $servers) {
    $shortName  = $server.Split('.')[0]
    $sourceRoot = ("\\$server\$SourcePath").TrimEnd('\')
    $serverDest = Join-Path $TargetPath $shortName
    Write-Log "--- $server ---"
    $stage = "reaching $sourceRoot"
    try {
        if (-not (Test-Path -LiteralPath $sourceRoot)) {
            throw "Source path is not reachable: $sourceRoot"
        }
        $stage = "listing files in $sourceRoot"
        $candidates = @(
            Get-ChildItem -LiteralPath $sourceRoot -Filter $FileFilter -File -Recurse |
                Where-Object { $_.LastWriteTime -lt $cutoff }
        )
        if ($candidates.Count -eq 0) {
            Write-Log "$server : nothing matched. Moved 0 files."
            $serversOk++
            continue
        }
        $stage = "reaching $serverDest"
        if (-not $reportOnlyMode -and -not (Test-Path -LiteralPath $serverDest)) {
            $stage = "creating $serverDest"
            New-Item -ItemType Directory -Path $serverDest -Force | Out-Null
            Write-Log "$server : created destination folder $serverDest"
        }
        $stage = "moving files to $serverDest"
        $movedHere   = 0
        $skippedHere = 0
        foreach ($file in $candidates) {
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
        Write-Log "$server : $($_.Exception.Message) - while $stage" 'ERROR'
    }
}
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