<#
.SYNOPSIS
    Reports what the session can actually reach. Moves nothing, changes nothing.

.DESCRIPTION
    A diagnostic, not part of the automation. It exists to answer one question:

        does the session runPowerShellScript opens have the same reach as the one the
        plug-in's own 'Invoke a PowerShell script' workflow opens?

    Run the SAME commands down BOTH paths and compare. Anything else -- comparing
    Test-Path on one path against Get-ChildItem on the other, say -- proves nothing,
    because those two operations need different rights and can disagree on a session
    that is perfectly healthy.

    HOW TO USE IT
      1. Import this file as a Resource Element, e.g. Probe-ServerAccess.ps1
      2. Run it through runPowerShellScript with -ComputerNames set to one or more
         servers, exactly as the real workflow would
      3. Run the same commands through 'Invoke a PowerShell script' on the same host
      4. Compare

    WHAT THE ANSWER MEANS
      Both list files          -> the two paths are equivalent; the fault is elsewhere
      This one denied, other   -> runPowerShellScript's session does not carry the
        one lists files           credential. The invocation is at fault, not the script
      Both denied              -> the credential is not reaching the target at all

    It writes the same PSO_RESULT line the real scripts do, so runPowerShellScript
    accepts its output rather than throwing 'did not report a result'.

.PARAMETER ComputerNames
    Comma-separated server names (FQDNs), same convention as Move-ArchivedLogs.ps1.

.PARAMETER SourcePath
    Path on each server relative to \\<server>\, the same value the real run uses.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ComputerNames,

    [string]$SourcePath = 'C$\Windows\System32\winevt\Logs',

    [string]$FileFilter = '*'
)

# Deliberately NOT 'Stop'. This script is here to report failures, not to be halted
# by the first one -- every check below has to run even when the one before it failed.
$ErrorActionPreference = 'Continue'

$script:ErrorMessages = New-Object System.Collections.ArrayList

function Write-Log {
    param([string]$Message, [ValidateSet('INFO','WARN','ERROR')][string]$Level = 'INFO')
    if ($Level -eq 'ERROR') { [void]$script:ErrorMessages.Add($Message) }
    Write-Host ('{0}  {1,-5}  {2}' -f (Get-Date).ToString('HH:mm:ss'), $Level, $Message)
}

function Write-Result {
    param([hashtable]$Data)
    $short = @($script:ErrorMessages | Select-Object -First 10 | ForEach-Object {
        if ($_.Length -gt 120) { $_.Substring(0,117) + '...' } else { $_ }
    })
    $Data['errorCount'] = $script:ErrorMessages.Count
    $Data['errors']     = $short
    Write-Host ('PSO_RESULT=' + ($Data | ConvertTo-Json -Compress -Depth 4))
}

# ---------------------------------------------------------------------------
# Who is this session, and what can it prove about itself
# ---------------------------------------------------------------------------
Write-Log "=== identity ==="
try   { Write-Log ("whoami            : " + (whoami)) }
catch { Write-Log ("whoami            : FAILED - " + $_.Exception.Message) 'ERROR' }

# The ticket flags are the whole story for a second hop:
#   forwardable          the ticket COULD be delegated
#   forwardable forwarded    it WAS delegated -- this is what a working host shows
Write-Log "=== kerberos tickets ==="
try {
    $tickets = klist 2>&1 | Out-String
    foreach ($line in ($tickets -split "`r?`n")) {
        if ($line -match 'Server:|Ticket Flags|Client:') { Write-Log ("  " + $line.Trim()) }
    }
    if ($tickets -notmatch 'krbtgt') {
        Write-Log "No krbtgt ticket in this session -- nothing can be delegated onward." 'WARN'
    }
    elseif ($tickets -notmatch 'forwarded') {
        Write-Log "A krbtgt ticket is present but NOT marked 'forwarded'." 'WARN'
    }
}
catch { Write-Log ("klist             : FAILED - " + $_.Exception.Message) 'ERROR' }

# ---------------------------------------------------------------------------
# What it can reach
# ---------------------------------------------------------------------------
$servers = @($ComputerNames -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
$reachable = 0

foreach ($server in $servers) {

    $root = ("\\$server\$SourcePath").TrimEnd('\')
    Write-Log "=== $server ==="

    # Deliberately separate checks. Test-Path needs only traverse; listing needs
    # FILE_LIST_DIRECTORY. A session can pass the first and fail the second, and
    # knowing which is what tells source-share trouble from destination trouble.
    try   { Write-Log ("  Test-Path        : " + (Test-Path -LiteralPath $root -ErrorAction Stop)) }
    catch { Write-Log ("  Test-Path        : FAILED - " + $_.Exception.Message) 'ERROR' }

    $listed = $false
    try {
        $flat = @(Get-ChildItem -LiteralPath $root -Filter $FileFilter -File -ErrorAction Stop)
        Write-Log ("  list, no recurse : " + $flat.Count + " file(s)")
        $listed = $true
    }
    catch { Write-Log ("  list, no recurse : FAILED - " + $_.Exception.Message) 'ERROR' }

    try {
        $deep = @(Get-ChildItem -LiteralPath $root -Filter $FileFilter -File -Recurse -ErrorAction Stop)
        Write-Log ("  list, recursive  : " + $deep.Count + " file(s)")
    }
    catch { Write-Log ("  list, recursive  : FAILED - " + $_.Exception.Message) 'ERROR' }

    # A second folder on the same share. If this lists and the one above does not,
    # the fault is that folder's ACL rather than the session.
    try {
        $win = @(Get-ChildItem -LiteralPath ("\\$server\C`$\Windows") -Directory -ErrorAction Stop)
        Write-Log ("  C`$\Windows dirs  : " + $win.Count)
    }
    catch { Write-Log ("  C`$\Windows dirs  : FAILED - " + $_.Exception.Message) 'ERROR' }

    if ($listed) { $reachable++ }
}

Write-Log "==============================================="
Write-Log "Servers whose files could be listed : $reachable of $($servers.Count)"

Write-Result @{
    serversRequested = $servers.Count
    serversProcessed = $reachable
    moved            = 0
    skipped          = 0
    reportOnly       = $true
}
