# ==============================================================================
# GENERATED FILE -- DO NOT EDIT.
#
# Built from : Invoke-ServerReboot.ps1
# Built on   : 2026-09-23 10:51:50
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
    [string]$RebootMode = 'report-only',
    [int]$DelayBetweenServersSec = 10,
    [int]$VerifyTimeoutSec = 600,
    [int]$VerifyPollSec = 15,
    [ValidateSet('yes', 'no')]
    [string]$RunPreRebootScript = 'no',
    [ValidateSet('yes', 'no')]
    [string]$EmailReport = 'no',
    [string]$SMTPServer = '',
    [string]$MailToString = '',
    [string]$MailCcString = '',
    [string]$MailSubject = 'VCF Orchestrator: Server Reboot status',
    [string]$HeaderNote = ''
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
function Get-UserlogonSession {
    param([string]$Computer)
    try {
        $session = query user /server:$Computer 2>&1
        if ($session.Count -gt 1) {
            return (($session |
                ForEach-Object { $_ -replace '\s{2,}', ',' } |
                ConvertFrom-Csv |
                Select-Object -ExpandProperty username) -join ', ')
        }
    }
    catch { }
    return ''
}
function Get-RebootStatus {
    param([string[]]$Servers)
    foreach ($computer in $Servers) {
        $userSession   = Get-UserlogonSession -Computer $computer
        $lastBootUptime = $null
        try {
            $pendingReboot = $false
            $lastBootUptime = Get-CimInstance -ComputerName $computer -ClassName win32_operatingsystem |
                Select-Object -ExpandProperty lastbootuptime
            $HKLM    = [UInt32]'0x80000002'
            $wmiReg  = [WMIClass]"\\$computer\root\default:StdRegProv"
            $crashOnAuditFail = 'NO'
            $auditResult = $wmiReg.GetDWORDValue($HKLM, 'SYSTEM\CurrentControlSet\Control\Lsa', 'crashonauditfail')
            if ($auditResult.uValue -eq 2) { $crashOnAuditFail = 'YES' }
            if (($wmiReg.EnumKey($HKLM, 'SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\')).sNames -contains 'RebootPending') {
                $pendingReboot = $true
            }
            if (($wmiReg.EnumKey($HKLM, 'SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\')).sNames -contains 'RebootRequired') {
                $pendingReboot = $true
            }
            $sccmNamespace = Get-WmiObject -Namespace ROOT\CCM\ClientSDK -List -ComputerName $computer -ErrorAction Ignore
            if ($sccmNamespace) {
                if (([WmiClass]"\\$computer\ROOT\CCM\ClientSDK:CCM_ClientUtilities").DetermineIfRebootPending().RebootPending -eq $true) {
                    $pendingReboot = $true
                }
            }
            Write-Log "$computer : pending reboot = $pendingReboot, last boot $lastBootUptime, crashonauditfail $crashOnAuditFail"
            [PSCustomObject]@{
                ComputerName           = $computer.ToUpper()
                PendingReboot          = $pendingReboot
                ComputerlastBootUptime = $lastBootUptime
                UserSession            = $userSession
                CrashOnAuditFail       = $crashOnAuditFail
            }
        }
        catch {
            Write-Log "$computer : pending-reboot state could not be read - $($_.Exception.Message)" 'WARN'
            [PSCustomObject]@{
                ComputerName           = $computer.ToUpper()
                PendingReboot          = 'Error Accessing Server'
                ComputerlastBootUptime = $null
                UserSession            = $userSession
                CrashOnAuditFail       = ''
            }
        }
    }
}
$PreRebootStep = {
    function Invoke-Native {
        param([string]$Label, [scriptblock]$Command)
        $output = & $Command 2>&1
        if ($LASTEXITCODE -ne 0) {
            return "$Label exited $LASTEXITCODE : $($output -join ' ')"
        }
        return $null
    }
    $problems = @()
    $problems += Invoke-Native 'takeown usbstor.inf' { takeown.exe /A /F c:\windows\inf\usbstor.inf }
    $problems += Invoke-Native 'takeown termsrv.dll' { takeown.exe /A /F c:\windows\system32\termsrv.dll }
    $problems += Invoke-Native 'icacls usbstor.inf grant Users:RX'         { icacls.exe c:\windows\inf\usbstor.inf /grant 'Users:RX' }
    $problems += Invoke-Native 'icacls usbstor.inf grant Administrators:F' { icacls.exe c:\windows\inf\usbstor.inf /grant 'Administrators:F' }
    $problems += Invoke-Native 'icacls termsrv.dll grant administrator:F'  { icacls.exe c:\windows\system32\termsrv.dll /grant ':r' 'administrator:F' }
    return @($problems | Where-Object { $_ })
}
function Invoke-RebootCommand {
    param([string]$Server)
    try {
        Write-Log "$Server : issuing reboot"
        $output = & shutdown.exe /r /t 2 /c 'VCF Orchestrator rebooting server to address pending reboot status on patching' /f /m "\\$Server" 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Log "$Server : shutdown command failed (exit code $LASTEXITCODE) - $($output -join ' ')" 'ERROR'
            return $false
        }
        Write-Log "$Server : reboot command accepted"
        return $true
    }
    catch {
        Write-Log "$Server : $($_.Exception.Message)" 'ERROR'
        return $false
    }
}
function Wait-ServersBackOnline {
    param(
        [array]$Targets,
        [int]$TimeoutSec = 600,
        [int]$PollSec = 15
    )
    $pending = @($Targets | Where-Object { $_.RebootIssued -eq $true })
    if ($pending.Count -eq 0) {
        Write-Log 'No successfully-issued reboots to verify.'
        return
    }
    Write-Log "Verifying $($pending.Count) server(s) return online (timeout ${TimeoutSec}s per server, polling every ${PollSec}s)"
    while ($true) {
        $stillPending = @()
        foreach ($t in $pending) {
            $deadline = $t.RebootIssuedAt.AddSeconds($TimeoutSec)
            $newBoot  = $null
            try {
                $newBoot = Get-CimInstance -ComputerName $t.ComputerName -ClassName win32_operatingsystem -ErrorAction Stop |
                    Select-Object -ExpandProperty lastbootuptime
            }
            catch {
                $newBoot = $null
            }
            if ($null -ne $newBoot -and ($null -eq $t.PreRebootLastBoot -or $newBoot -gt $t.PreRebootLastBoot)) {
                $t.BackOnline  = $true
                $t.NewLastBoot = $newBoot
                $t.DurationSec = [Math]::Max(0, [int]($newBoot - $t.RebootIssuedAt).TotalSeconds)
                $t.Status      = 'Rebooted'
                $t.Detail      = "Back online; LastBootUpTime advanced to $newBoot"
                Write-Log "$($t.ComputerName) : back online, returned $($t.DurationSec)s after its reboot was issued"
            }
            elseif ((Get-Date) -ge $deadline) {
                $t.BackOnline  = $false
                $t.DurationSec = [int]((Get-Date) - $t.RebootIssuedAt).TotalSeconds
                $t.Status      = 'NotReturned'
                $t.Detail      = "Did not return within ${TimeoutSec}s of the reboot being issued"
                Write-Log "$($t.ComputerName) : did not return within ${TimeoutSec}s of its reboot being issued" 'ERROR'
            }
            else {
                $stillPending += $t
            }
        }
        $pending = $stillPending
        if ($pending.Count -eq 0) { break }
        Start-Sleep -Seconds $PollSec
    }
    Write-Log 'Verification pass complete.'
}
function New-RebootReportHtml {
    param(
        [array]$Data,
        [string]$GroupLabel,
        [int]$TimeoutSec
    )
    $tableStyle  = 'border-collapse:collapse;border:1px solid #B4B4B4;font-family:Segoe UI,Arial,sans-serif;font-size:12px;width:100%;'
    $headerStyle = 'border:1px solid #B4B4B4;padding:5px 7px;background-color:#44546A;color:#FFFFFF;text-align:left;font-weight:600;'
    $cellStyle   = 'border:1px solid #B4B4B4;padding:4px 7px;background-color:#FFFFFF;vertical-align:top;'
    $intro =
        "<p style=`"font-family:Segoe UI,Arial,sans-serif;font-size:12px;`">" +
        "The list of servers was the direct (non-recursive) enabled computer members of the security group " +
        "<b>$GroupLabel</b>, resolved by VCF Orchestrator. A remote WMI/registry call to each server determined " +
        "whether a reboot was pending; <b>only servers reporting a pending reboot were rebooted</b>. Servers whose " +
        "pending state could not be read were skipped and NOT rebooted. Each rebooted server was verified as " +
        "returning to service by confirming its LastBootUpTime advanced past its pre-reboot value (timeout " +
        "${TimeoutSec}s per server). The RPC/WMI service on the remote server must be available and accessible, " +
        "or the server is reported as an error.</p>"
    $fragment = $Data |
        Sort-Object -Property Status, ComputerName |
        ConvertTo-Html -Property ComputerName, PendingReboot, PreRebootLastBoot, RebootIssued, BackOnline, DurationSec, Status, Detail -Fragment
    $body = (@($fragment) -join "`n")
    $body = $body -replace '<table>', "<table style=`"$tableStyle`">"
    $body = $body -replace '<th>',    "<th style=`"$headerStyle`">"
    $body = $body -replace '<td>',    "<td style=`"$cellStyle`">"
    $body = $body -replace '<td([^>]*)>Rebooted</td>',                 '<td$1><font color="green">Rebooted</font></td>'
    $body = $body -replace '<td([^>]*)>NotReturned</td>',              '<td$1><font color="red">Did NOT return</font></td>'
    $body = $body -replace '<td([^>]*)>RebootFailed</td>',             '<td$1><font color="red">Reboot FAILED</font></td>'
    $body = $body -replace '<td([^>]*)>Skipped-StatusUnknown</td>',    '<td$1><font color="red">Skipped - status unknown</font></td>'
    $body = $body -replace '<td([^>]*)>Skipped-NoRebootRequired</td>', '<td$1><font color="green">Skipped - no reboot required</font></td>'
    $body = $body -replace '<td([^>]*)>Skipped-ReportOnly</td>',       '<td$1><font color="#B8860B">Skipped - report only</font></td>'
    $body = $body -replace '>PreRebootLastBoot<', '>LastBootUpTime (before)<'
    $body = $body -replace '>DurationSec<',       '>Return time (s)<'
    return $intro + $body
}
function Send-ReportMail {
    param(
        [string]$Body,
        [string]$Subject
    )
    try {
        $to = @($MailToString -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
        $cc = @($MailCcString -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
        if ($to.Count -eq 0) {
            Write-Log 'EmailReport is yes but no recipients were supplied; the report was not sent.' 'ERROR'
            return
        }
        $domain = $env:USERDNSDOMAIN
        if ([string]::IsNullOrWhiteSpace($domain)) { $domain = ($to[0] -split '@')[-1] }
        $from = "$($env:COMPUTERNAME)_Do_Not_Reply@$domain"
        $mailParams = @{
            SmtpServer = $SMTPServer
            From       = $from
            To         = $to
            Subject    = $Subject
            Body       = $Body
            BodyAsHtml = $true
        }
        if ($cc.Count -gt 0) { $mailParams['Cc'] = $cc }
        Write-Log "Sending report via $SMTPServer to $($to -join ', ')$(if ($cc.Count -gt 0) { ' (cc ' + ($cc -join ', ') + ')' })"
        Send-MailMessage @mailParams
        Write-Log 'Report sent.'
    }
    catch {
        Write-Log "The report could not be emailed: $($_.Exception.Message)" 'ERROR'
    }
}
$servers = @($ComputerNames -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
if ($servers.Count -eq 0) {
    Write-Log 'No server names were supplied. Nothing was done.' 'ERROR'
    Write-Result @{
        serversRequested = 0
        pendingReboot    = 0
        rebooted         = 0
        notReturned      = 0
        rebootFailed     = 0
        skipped          = 0
        reportOnly       = $true
    }
    return
}
$willReboot = ($RebootMode -eq 'reboot')
if ($DelayBetweenServersSec -lt 0) {
    Write-Log "DelayBetweenServersSec must be 0 or greater, but was $DelayBetweenServersSec. Nothing was done." 'ERROR'
    Write-Result @{ serversRequested = $servers.Count; pendingReboot = 0; rebooted = 0; notReturned = 0; rebootFailed = 0; skipped = 0; reportOnly = (-not $willReboot) }
    return
}
if ($VerifyPollSec -lt 1 -or $VerifyTimeoutSec -lt 1 -or $VerifyPollSec -gt $VerifyTimeoutSec) {
    Write-Log "VerifyPollSec ($VerifyPollSec) and VerifyTimeoutSec ($VerifyTimeoutSec) must both be at least 1, and the poll interval must not exceed the timeout -- otherwise a server would never be polled. Nothing was done." 'ERROR'
    Write-Result @{ serversRequested = $servers.Count; pendingReboot = 0; rebooted = 0; notReturned = 0; rebootFailed = 0; skipped = 0; reportOnly = (-not $willReboot) }
    return
}
if ($HeaderNote -eq '') { $HeaderNote = '(group not named)' }
if ($RunPreRebootScript -eq 'yes' -and $willReboot) {
    Write-Log "Pre-reboot step is ENABLED. It will run on every server that is rebooted, and it loosens ACLs on usbstor.inf and termsrv.dll. This has never run in production before (defect S-6)." 'WARN'
}
Write-Log "==============================================="
Write-Log "Servers to check  : $($servers.Count)"
Write-Log "Reboot mode       : $RebootMode$(if (-not $willReboot) { "  (REPORT ONLY - nothing will be rebooted)" })"
Write-Log "Delay between     : ${DelayBetweenServersSec}s"
Write-Log "Verify timeout    : ${VerifyTimeoutSec}s, polling every ${VerifyPollSec}s"
Write-Log "Pre-reboot step   : $RunPreRebootScript$(if ($RunPreRebootScript -eq 'yes') { '  (embedded; loosens ACLs on usbstor.inf and termsrv.dll)' })"
Write-Log "==============================================="
$status = @(Get-RebootStatus -Servers $servers)
$report = @()
foreach ($s in $servers) {
    $name = $s.ToUpper()
    $r    = $status | Where-Object { $_.ComputerName -eq $name } | Select-Object -First 1
    $pending = 'No status returned'
    $preBoot = $null
    $session = ''
    $audit   = ''
    if ($r) {
        $pending = [string]$r.PendingReboot
        $preBoot = $r.ComputerlastBootUptime
        $session = $r.UserSession
        $audit   = $r.CrashOnAuditFail
    }
    $rec = [PSCustomObject]@{
        ComputerName      = $name
        PendingReboot     = $pending
        PreRebootLastBoot = $preBoot
        UserSession       = $session
        CrashOnAuditFail  = $audit
        RebootIssued      = $false
        RebootIssuedAt    = $null
        BackOnline        = $false
        NewLastBoot       = $null
        DurationSec       = 0
        Status            = ''
        Detail            = ''
    }
    if ($pending -eq 'True') {
        $rec.Status = 'PendingReboot'
        $rec.Detail = 'Pending reboot detected; queued for reboot.'
    }
    elseif ($pending -eq 'False') {
        $rec.Status = 'Skipped-NoRebootRequired'
        $rec.Detail = 'No pending reboot; not rebooted.'
    }
    else {
        $rec.Status = 'Skipped-StatusUnknown'
        $rec.Detail = "Pending-reboot state could not be determined ('$pending'); server skipped and NOT rebooted."
        Write-Log "$name : pending-reboot state could not be determined ('$pending') - skipped and NOT rebooted" 'ERROR'
    }
    $report += $rec
}
$rebootTargets = @($report | Where-Object { $_.Status -eq 'PendingReboot' })
Write-Log "Servers requiring a reboot: $($rebootTargets.Count) of $($servers.Count)"
if ($willReboot -and $rebootTargets.Count -gt 0) {
    for ($i = 0; $i -lt $rebootTargets.Count; $i++) {
        $t = $rebootTargets[$i]
        if ($RunPreRebootScript -eq 'yes') {
            try {
                Write-Log "$($t.ComputerName) : running the embedded pre-reboot step"
                $problems = Invoke-Command -ComputerName $t.ComputerName -ScriptBlock $PreRebootStep -ErrorAction Stop
                foreach ($problem in @($problems)) {
                    Write-Log "$($t.ComputerName) : pre-reboot step - $problem. Rebooting anyway." 'ERROR'
                }
                if (@($problems).Count -eq 0) {
                    Write-Log "$($t.ComputerName) : pre-reboot step completed"
                }
            }
            catch {
                Write-Log "$($t.ComputerName) : pre-reboot step could not run - $($_.Exception.Message). Rebooting anyway." 'ERROR'
            }
        }
        if (Invoke-RebootCommand -Server $t.ComputerName) {
            $t.RebootIssued   = $true
            $t.RebootIssuedAt = Get-Date
            $t.Status         = 'RebootIssued'
            $t.Detail         = 'Reboot command accepted; awaiting verification.'
        }
        else {
            $t.RebootIssued = $false
            $t.Status       = 'RebootFailed'
            $t.Detail       = 'shutdown command was rejected; see the ERROR line in the transcript.'
        }
        if ($i -lt ($rebootTargets.Count - 1)) {
            Start-Sleep -Seconds $DelayBetweenServersSec
        }
    }
    Wait-ServersBackOnline -Targets $report -TimeoutSec $VerifyTimeoutSec -PollSec $VerifyPollSec
}
elseif ($rebootTargets.Count -gt 0) {
    Write-Log "RebootMode is '$RebootMode', not 'reboot' - report-only run. $($rebootTargets.Count) server(s) require a reboot but none were rebooted."
    foreach ($t in $rebootTargets) {
        $t.Status = 'Skipped-ReportOnly'
        $t.Detail = "Pending reboot detected but RebootMode was '$RebootMode', not 'reboot'."
    }
}
else {
    Write-Log 'No servers require a reboot.'
}
$rebootedOk   = @($report | Where-Object { $_.Status -eq 'Rebooted' }).Count
$notReturned  = @($report | Where-Object { $_.Status -eq 'NotReturned' }).Count
$rebootFailed = @($report | Where-Object { $_.Status -eq 'RebootFailed' }).Count
$skipped      = @($report | Where-Object { $_.Status -like 'Skipped-*' }).Count
$subject = "$MailSubject - $rebootedOk of $($rebootTargets.Count) pending server(s) rebooted and verified"
Write-Log '--- per-server outcome ---'
foreach ($r in ($report | Sort-Object -Property Status, ComputerName)) {
    Write-Log ('  {0,-40} {1,-26} {2}' -f $r.ComputerName, $r.Status, $r.Detail)
}
if ($EmailReport -eq 'yes') {
    $html = New-RebootReportHtml -Data $report -GroupLabel $HeaderNote -TimeoutSec $VerifyTimeoutSec
    Send-ReportMail -Body $html -Subject $subject
}
else {
    Write-Log 'EmailReport is no - the per-server outcome above is the only report for this run.'
}
Write-Log "==============================================="
Write-Log "Servers checked      : $($servers.Count)"
Write-Log "Pending a reboot     : $($rebootTargets.Count)"
if ($willReboot) {
    Write-Log "Rebooted and verified: $rebootedOk"
    Write-Log "Did not return       : $notReturned"
    Write-Log "Reboot rejected      : $rebootFailed"
}
else {
    Write-Log "Would have rebooted  : $($rebootTargets.Count)  (report only - nothing was rebooted)"
}
Write-Log "Skipped              : $skipped"
Write-Log "Errors               : $($script:ErrorMessages.Count)"
Write-Result @{
    serversRequested = $servers.Count
    pendingReboot    = $rebootTargets.Count
    rebooted         = $rebootedOk
    notReturned      = $notReturned
    rebootFailed     = $rebootFailed
    skipped          = $skipped
    reportOnly       = (-not $willReboot)
}