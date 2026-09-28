<#
.SYNOPSIS
    LAB helper: set / clear / check the pending-reboot sentinel registry keys that
    cvs_functions.ps1 (Invoke-ServerReboot -> Get-RebootStatus) looks for, so a
    reboot requirement can be SIMULATED on a test server without installing updates.

.DESCRIPTION
    Get-RebootStatus sets PendingReboot = True when EITHER of these registry
    SUBKEYS exists. They are KEYS, not values - the script enumerates the subkeys
    of the parent path and checks whether the sentinel name is among them:

      HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired
      HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending

    This helper creates or removes those keys. Default acts on the Windows Update
    key (the cleanest to fake and to remove).

    IMPORTANT
      * LAB / TEST USE ONLY.
      * The key must exist on the TARGET server (e.g. monsrv01), NOT on the PS host -
        Get-RebootStatus reads the target's registry remotely.
      * Requires administrative rights on each target (HKLM write). For remote
        targets the connecting account must be admin on that box and WinRM enabled.
      * Run in 64-bit PowerShell. Get-RebootStatus reads the native (64-bit) registry
        view via StdRegProv; a 32-bit host would be redirected to WOW6432Node.
      * A FAKE key does NOT clear itself on reboot (a real Windows-Update flag is
        removed when the pending update completes). So after a simulated reboot the
        server will STILL report pending until you run -Action Clear. Always clean up,
        and be aware a repeat simpleMode run would reboot the box again.

.PARAMETER ComputerName
    One or more explicit targets. Omit (or 'localhost') to act locally; remote
    targets use Invoke-Command. Can be combined with -AdGroup; the two lists are
    merged and de-duplicated.

.PARAMETER AdGroup
    Name or DN of an AD group. Its DIRECT computer members are resolved and added
    to the target list - non-recursive, computer objects only, which mirrors
    Get-ListOfServers-Direct (the resolver the reboot workflow itself uses), so you
    simulate a pending reboot on exactly the machines the workflow would act on.
    Requires the ActiveDirectory module (RSAT) on the machine running this helper.

.PARAMETER DomainName
    Optional AD -Server target (a specific DC / domain) for -AdGroup resolution.

.PARAMETER Action
    Set   - create the sentinel key(s)  (simulate a pending reboot)
    Clear - remove the sentinel key(s)  (undo)
    Check - report presence only; change nothing   (default)

.PARAMETER Flag
    WindowsUpdate (default), CBS, or Both - which sentinel(s) to act on.

.EXAMPLE
    # Simulate a pending reboot on one lab server
    .\Set-PendingRebootFlag.ps1 -ComputerName monsrv01 -Action Set

.EXAMPLE
    # Arm every direct computer member of the reboot group (same set the workflow targets)
    .\Set-PendingRebootFlag.ps1 -AdGroup 'Server-Reboots' -DomainName vcf.lab -Action Set

.EXAMPLE
    # AD group members PLUS an extra ad-hoc box, de-duplicated
    .\Set-PendingRebootFlag.ps1 -AdGroup 'Server-Reboots' -ComputerName extrahost01 -Action Set

.EXAMPLE
    # See exactly what Get-RebootStatus will find, across the whole group
    .\Set-PendingRebootFlag.ps1 -AdGroup 'Server-Reboots' -Action Check

.EXAMPLE
    # Clean up afterwards (do this when testing is done)
    .\Set-PendingRebootFlag.ps1 -AdGroup 'Server-Reboots' -Action Clear
#>
[CmdletBinding()]
param(
    [string[]]$ComputerName = @(),

    [string]$AdGroup,

    [string]$DomainName,

    [ValidateSet('Set','Clear','Check')]
    [string]$Action = 'Check',

    [ValidateSet('WindowsUpdate','CBS','Both')]
    [string]$Flag = 'WindowsUpdate'
)

# Runs on each target (locally or via Invoke-Command). Returns one object per key.
$work = {
    param($Action, $Flag)

    $keys = @{
        WindowsUpdate = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired'
        CBS           = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending'
    }
    $selected = switch ($Flag) {
        'WindowsUpdate' { @('WindowsUpdate') }
        'CBS'           { @('CBS') }
        'Both'          { @('WindowsUpdate','CBS') }
    }

    foreach ($name in $selected) {
        $path   = $keys[$name]
        $result = ''
        try {
            switch ($Action) {
                'Set' {
                    if (Test-Path $path) {
                        $result = 'AlreadyPresent'
                    } else {
                        New-Item -Path $path -Force -ErrorAction Stop | Out-Null
                        $result = 'Created'
                    }
                }
                'Clear' {
                    if (Test-Path $path) {
                        Remove-Item -Path $path -Recurse -Force -ErrorAction Stop
                        $result = 'Removed'
                    } else {
                        $result = 'NotPresent'
                    }
                }
                'Check' {
                    $result = if (Test-Path $path) { 'Present' } else { 'Absent' }
                }
            }
        } catch {
            $result = "ERROR: $($_.Exception.Message)"
        }

        [PSCustomObject]@{
            Computer = $env:COMPUTERNAME
            Flag     = $name
            Action   = $Action
            Result   = $result
            Key      = $path
        }
    }
}

# ── Assemble the target list: explicit -ComputerName plus -AdGroup members ────
function Resolve-AdGroupComputers {
    param([string]$Group, [string]$Domain)
    if (-not (Get-Module -ListAvailable -Name ActiveDirectory)) {
        throw "ActiveDirectory module not available on this machine; cannot resolve -AdGroup '$Group'. " +
              "Run this helper from a host with RSAT AD PowerShell, or pass -ComputerName instead."
    }
    Import-Module ActiveDirectory -ErrorAction Stop
    $p = @{ Identity = $Group; ErrorAction = 'Stop' }
    if (-not [string]::IsNullOrWhiteSpace($Domain)) { $p['Server'] = $Domain }
    # Non-recursive, computer objects only - mirrors Get-ListOfServers-Direct so the
    # simulated pending state lands on the same machines the reboot workflow targets.
    Get-ADGroupMember @p | Where-Object { $_.objectClass -eq 'computer' } |
        Select-Object -ExpandProperty Name
}

$targets = @()
$targets += $ComputerName
if (-not [string]::IsNullOrWhiteSpace($AdGroup)) {
    $members = Resolve-AdGroupComputers -Group $AdGroup -Domain $DomainName
    Write-Verbose "AD group '$AdGroup' resolved to $(@($members).Count) direct computer member(s)."
    $targets += $members
}
$targets = $targets | Where-Object { $_ -and $_.ToString().Trim() -ne '' } | Select-Object -Unique
if (-not $targets) { $targets = @($env:COMPUTERNAME) }  # bare run acts locally

# Warn early if a LOCAL write is attempted without elevation.
if ($Action -ne 'Check') {
    $isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
              ).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
    $touchesLocal = $targets | Where-Object { $_ -in @($env:COMPUTERNAME,'localhost','.','127.0.0.1') }
    if ($touchesLocal -and -not $isAdmin) {
        Write-Warning "Not elevated: a local '$Action' on HKLM will fail. Re-run PowerShell as Administrator."
    }
}

$results = foreach ($c in $targets) {
    $isLocal = $c -in @($env:COMPUTERNAME,'localhost','.','127.0.0.1')
    try {
        if ($isLocal) {
            & $work $Action $Flag
        } else {
            Invoke-Command -ComputerName $c -ScriptBlock $work -ArgumentList $Action, $Flag -ErrorAction Stop
        }
    } catch {
        [PSCustomObject]@{
            Computer = $c; Flag = $Flag; Action = $Action
            Result   = "ERROR: $($_.Exception.Message)"; Key = ''
        }
    }
}

$results | Format-Table Computer, Flag, Action, Result, Key -AutoSize
