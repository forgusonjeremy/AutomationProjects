<#
.SYNOPSIS
    Seeds dummy "Archive-*.evtx" test files into the Windows event-log archive
    directory on one or more servers, for exercising the Move-ArchivedLogs-ByADGroup
    workflow in a lab.

.DESCRIPTION
    The move automation (cvs_functions.ps1 -> Move-files) selects files purely by
    NAME ("Archive*.evtx") and LastWriteTime; it never parses the .evtx binary
    format. This script therefore creates lightweight TEXT placeholder files with
    matching names and a back-dated LastWriteTime so they qualify for the move.

    Target directory on each server: C:\Windows\System32\winevt\Logs

    Server targeting (choose one parameter set):
      -ComputerName <list>            explicit server names/FQDNs, OR
      -ADGroup <name> [-DomainName]   resolve ENABLED computer members recursively
                                      (same logic as the workflow's
                                      Get-ListOfServers-ByCN)

    Delivery method:
      (default)      writes over the UNC admin share:
                     \\<server>\C$\Windows\System32\winevt\Logs
      -UseRemoting   writes locally on each server via Invoke-Command (WinRM)

    Requires administrative write access to the target directory on each server
    (winevt\Logs is system-protected; local Administrator rights are sufficient).

.PARAMETER ComputerName
    One or more target servers (name or FQDN).

.PARAMETER ADGroup
    AD security group whose enabled computer members are seeded. Mirrors the
    workflow's recursive + Enabled-only resolution.

.PARAMETER DomainName
    Domain/DC to query for -ADGroup (passed to Get-ADGroupMember/Get-ADComputer -Server).

.PARAMETER FilesPerServer
    Number of files to create per server, per log type. Default 5.

.PARAMETER AgeDays
    Days in the past to back-date each file's timestamps. Default 30. Must exceed
    the move's age threshold (default: files older than ~1 day).

.PARAMETER LogTypes
    Event-log names embedded in the file names. Default Application, System, Security.

.PARAMETER NamePrefix
    File-name prefix. Default 'Archive-' (must start with 'Archive' to match the filter).

.PARAMETER UseRemoting
    Write files via PowerShell remoting (Invoke-Command) instead of the UNC admin share.

.PARAMETER Credential
    Optional credential for AD queries, remoting, and/or UNC access.

.EXAMPLE
    .\New-ArchiveLogTestData.ps1 -ComputerName srv01,srv02 -FilesPerServer 5 -AgeDays 30

.EXAMPLE
    .\New-ArchiveLogTestData.ps1 -ADGroup 'Monitoring-Servers' -DomainName corp.local

.EXAMPLE
    .\New-ArchiveLogTestData.ps1 -ComputerName srv01 -UseRemoting -Credential (Get-Credential)

.NOTES
    Lab utility only - not part of the deployed vRO package.
    Files are plain text; safe to delete. Re-running creates additional files.
    For the Remove-OldFiles-UNCShare (retention) test, seed the ARCHIVE SHARE with
    files older than the retention threshold instead - not the servers.
#>
[CmdletBinding(SupportsShouldProcess, DefaultParameterSetName = 'ByComputer')]
param(
    [Parameter(Mandatory, ParameterSetName = 'ByComputer', Position = 0)]
    [string[]]$ComputerName,

    [Parameter(Mandatory, ParameterSetName = 'ByADGroup')]
    [string]$ADGroup,

    [Parameter(ParameterSetName = 'ByADGroup')]
    [string]$DomainName,

    [ValidateRange(1, 1000)]
    [int]$FilesPerServer = 5,

    [ValidateRange(1, 36500)]
    [int]$AgeDays = 30,

    [string[]]$LogTypes = @('Application', 'System', 'Security'),

    [ValidatePattern('^Archive')]
    [string]$NamePrefix = 'Archive-',

    [switch]$UseRemoting,

    [System.Management.Automation.PSCredential]$Credential
)

# --- Resolve the target server list ------------------------------------------
if ($PSCmdlet.ParameterSetName -eq 'ByADGroup') {
    Import-Module ActiveDirectory -ErrorAction Stop

    $memberParams = @{ Identity = $ADGroup; Recursive = $true }
    if ($DomainName) { $memberParams['Server'] = $DomainName }
    if ($Credential) { $memberParams['Credential'] = $Credential }

    $computerParams = @{ Properties = @('DNSHostName', 'Enabled') }
    if ($DomainName) { $computerParams['Server'] = $DomainName }
    if ($Credential) { $computerParams['Credential'] = $Credential }

    $ComputerName =
        Get-ADGroupMember @memberParams |
            Where-Object { $_.objectClass -eq 'computer' } |
            ForEach-Object { Get-ADComputer -Identity $_.distinguishedName @computerParams } |
            Where-Object { $_.Enabled } |
            ForEach-Object { if ($_.DNSHostName) { $_.DNSHostName } else { $_.Name } }
}

if (-not $ComputerName) {
    Write-Warning 'No target servers resolved. Nothing to do.'
    return
}

Write-Host ("Target servers ({0}): {1}" -f $ComputerName.Count, ($ComputerName -join ', '))
Write-Host ("Plan: {0} file(s) x {1} log type(s) = {2} file(s) per server, back-dated {3} day(s)." -f `
        $FilesPerServer, $LogTypes.Count, ($FilesPerServer * $LogTypes.Count), $AgeDays)

# --- File-creation logic (runs locally or inside a remoting session) ----------
$makeFiles = {
    param($BaseDir, $FilesPerServer, $AgeDays, $LogTypes, $NamePrefix)

    if (-not $BaseDir) { $BaseDir = Join-Path $env:SystemRoot 'System32\winevt\Logs' }

    # Create the target Logs directory if it does not already exist.
    $dirCreated = $false
    if (-not (Test-Path -LiteralPath $BaseDir)) {
        New-Item -ItemType Directory -Path $BaseDir -Force -ErrorAction Stop | Out-Null
        $dirCreated = $true
    }

    $created = New-Object System.Collections.Generic.List[string]
    $stamp = (Get-Date).AddDays(-1 * $AgeDays)

    foreach ($log in $LogTypes) {
        for ($i = 1; $i -le $FilesPerServer; $i++) {
            # Realistic, unique name e.g. Archive-Application-2026-05-31-08-15-42-001.evtx
            $fileStamp = $stamp.AddMinutes(-1 * $i).ToString('yyyy-MM-dd-HH-mm-ss')
            $name = '{0}{1}-{2}-{3:000}.evtx' -f $NamePrefix, $log, $fileStamp, $i
            $path = Join-Path $BaseDir $name

            "Lab placeholder for $name (NOT a real EVTX). Created for Move-ArchivedLogs testing." |
                Set-Content -LiteralPath $path -Encoding Ascii -Force

            $item = Get-Item -LiteralPath $path
            $item.CreationTime = $stamp
            $item.LastWriteTime = $stamp
            $item.LastAccessTime = $stamp

            $created.Add($name)
        }
    }

    [pscustomobject]@{ Directory = $BaseDir; Count = $created.Count; DirCreated = $dirCreated }
}

# --- Seed each server ---------------------------------------------------------
$totalFiles = 0
$okCount = 0
$failCount = 0

foreach ($server in $ComputerName) {
    $plannedCount = $FilesPerServer * $LogTypes.Count
    if (-not $PSCmdlet.ShouldProcess($server, "Create $plannedCount Archive-*.evtx test files")) {
        continue
    }

    try {
        if ($UseRemoting) {
            $icmParams = @{
                ComputerName = $server
                ScriptBlock  = $makeFiles
                ArgumentList = @($null, $FilesPerServer, $AgeDays, $LogTypes, $NamePrefix)
                ErrorAction  = 'Stop'
            }
            if ($Credential) { $icmParams['Credential'] = $Credential }
            $result = Invoke-Command @icmParams
            $where = "$server (local: $($result.Directory))"
        }
        else {
            $unc = "\\$server\C`$\Windows\System32\winevt\Logs"
            $result = & $makeFiles $unc $FilesPerServer $AgeDays $LogTypes $NamePrefix
            $where = $unc
        }

        $dirNote = if ($result.DirCreated) { ' (created missing Logs directory)' } else { '' }
        Write-Host ("[OK]   {0}: created {1} file(s) in {2}{3}" -f $server, $result.Count, $where, $dirNote) -ForegroundColor Green
        $totalFiles += $result.Count
        $okCount++
    }
    catch {
        Write-Warning ("[FAIL] {0}: {1}" -f $server, $_.Exception.Message)
        $failCount++
    }
}

# --- Summary ------------------------------------------------------------------
Write-Host ''
Write-Host '=================== Seeding Summary ==================='
Write-Host ("  Servers seeded : {0}" -f $okCount)
Write-Host ("  Servers failed : {0}" -f $failCount) -ForegroundColor $(if ($failCount) { 'Red' } else { 'Gray' })
Write-Host ("  Total files    : {0}" -f $totalFiles)
Write-Host ("  Back-dated      : {0} day(s) (LastWriteTime)" -f $AgeDays)
Write-Host '======================================================'
