[CmdletBinding()]
param (
    [string]$eMailReport      = 'yes',
    [string]$SMTPServer       = 'dom1.dom2.dom3.example',
    [string]$MailToString     = 'user1@dom3.example, user16@dom3.example, user17@dom3.example, user18@dom3.example',
    [string]$MailCcString     = 'user19@dom3.example, user20@dom3.example, user21@dom3.example, user22@dom3.example, user23@dom3.example',
    [string]$MailSubjectstring = 'VI Health Check',
    [string]$vCenterList      = '',
    [string]$TeamsAlert       = 'no',
    [string]$TeamsWebhookUrl  = 'https://default66cf50745afe48d1a691a12b2121f44.b.environment.api.gov.powerplatform.microsoft.us:443/powerautomate/automations/direct/workflows/d03b45425235467d9d40bf5b4a560221/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=y__plXik8KhfZwJfLttFPVUhLlEBc-cxU5hKkhi6ZIA',
    [string]$TeamsAlertOnlyOnError = 'yes',
    [int]$TeamsMaxRows        = 10
)

Set-Variable BYTES_IN_GB -option Constant -value ([int64]1073741824) -Visibility Private

$Global:MailFrom = 'user24@dom3.example'
$Global:DebugDir = "$($PSScriptRoot)\Debug"
if (-not (Test-Path $Global:DebugDir)) { New-Item -ItemType Directory -Path $Global:DebugDir -Force | Out-Null }
$Global:SystemLog = Join-Path $Global:DebugDir 'vi_healthcheck.log'

$SnapshotAgeDays       = 7
$DatastorePercentFree  = 5
$HaLookbackHours       = 24
$EventTimeOffsetHours  = 0
$ExcludeVms            = @('hstvdixiomgs')

$EventTypeIds = @(
    'com.vmware.vc.HA.CannotResetVmWithInaccessibleDatastore',
    'com.vmware.vc.ha.VmRestartedByHAEvent',
    'VmMaxRestartCountReached',
    'VmMessageEvent',
    'VmDasBeingResetWithScreenshotEvent'
)

[string[]]$MailTo = if ([string]::IsNullOrWhiteSpace($MailToString)) { @() } else { $MailToString.Split(',').Trim() }
[string[]]$MailCc = if ([string]::IsNullOrWhiteSpace($MailCcString)) { @() } else { $MailCcString.Split(',').Trim() }

function Write-Log {
    param([string]$Message)
    $line = ('{0}  {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $Message)
    try { $line | Out-File -FilePath $Global:SystemLog -Append -Encoding utf8 } catch {}
    Write-Host $line
}

function Test-Port {
    param([string]$ComputerName,[int]$Port=443,[int]$TimeoutMs=5000)
    $tcp = New-Object System.Net.Sockets.TcpClient
    $sw  = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $iar = $tcp.BeginConnect($ComputerName,$Port,$null,$null)
        if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $null }
        $tcp.EndConnect($iar); $sw.Stop(); return [int]$sw.ElapsedMilliseconds
    } catch { return $null } finally { $tcp.Close() }
}

function Test-Url {
    param([string]$Url,[switch]$IgnoreSsl,[int]$Retries=3,[int]$TimeoutMs=60000)
    $attempt = 0
    while ($attempt -le $Retries) {
        $attempt++
        try {
            [System.Net.ServicePointManager]::DefaultConnectionLimit = 1024
            if ($IgnoreSsl) { [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true } }
            else            { [System.Net.ServicePointManager]::ServerCertificateValidationCallback = $null }
            $req = [System.Net.WebRequest]::Create($Url)
            $req.Timeout = $TimeoutMs
            $req.Headers.Add('Keep-Alive','300')
            $req.AllowAutoRedirect = $true
            $resp = $req.GetResponse()
            $code = [int]$resp.StatusCode
            $resp.Close()
            return $code
        } catch [System.Net.WebException] {
            if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
            if ($attempt -gt $Retries) { return 0 }
        } catch {
            if ($attempt -gt $Retries) { return 0 }
        }
    }
    return 0
}

function Format-CvsTableHtml {
    param([string]$Fragment,[string]$Accent = '#1f2937',[switch]$CenterCells)
    if ([string]::IsNullOrWhiteSpace($Fragment) -or ($Fragment -notmatch '<td')) {
        return '<p style="margin:2px 0 6px;padding:6px 9px;background:#f9fafb;border:1px dashed #d1d5db;border-radius:4px;color:#6b7280;font-size:12px;font-family:Segoe UI,Arial,sans-serif;">None found.</p>'
    }
    $t = $Fragment
    $t = $t -replace '<table>',
        '<table cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;width:100%;margin:2px 0 6px;font-family:Segoe UI,Arial,sans-serif;font-size:12px;">'
    $t = $t -replace '<th>',
        ('<th align="left" bgcolor="' + $Accent + '" style="background:' + $Accent + ';color:#ffffff;text-align:left;padding:6px 8px;font-weight:600;font-size:11px;white-space:nowrap;border:1px solid ' + $Accent + ';">')
    if ($CenterCells) {
        $tdStyle = '<td style="padding:5px 8px;border:1px solid #e5e7eb;color:#111827;background:#ffffff;text-align:center;">'
    } else {
        $tdStyle = '<td style="padding:5px 8px;border:1px solid #e5e7eb;color:#111827;background:#ffffff;">'
    }
    $t = $t -replace '<td>', $tdStyle
    if (-not $CenterCells) {
        $t = $t -replace '(<td style="[^"]+?)(">)(\s*[\d.,\-]+\s*)(</td>)','$1;text-align:right$2$3$4'
    }
    $script:__cvsZebraRow = 0
    $t = [regex]::Replace($t, '<tr>(?=\s*<td)', {
        param($m)
        $script:__cvsZebraRow++
        if ($script:__cvsZebraRow % 2 -eq 0) { '<tr style="background:#f9fafb">' } else { '<tr>' }
    })
    return $t
}

function Set-StatusColors {
    param([string]$Html)
    $green = 'padding:5px 8px;border:1px solid #e5e7eb;background:#16a34a;color:#ffffff;font-weight:700;text-align:center;'
    $red   = 'padding:5px 8px;border:1px solid #e5e7eb;background:#dc2626;color:#ffffff;font-weight:700;text-align:center;'
    $Html = $Html -replace '<td style="[^"]*">\s*UP\s*</td>',              ('<td bgcolor="#16a34a" style="' + $green + '">UP</td>')
    $Html = $Html -replace '<td style="[^"]*">\s*DOWN\s*</td>',            ('<td bgcolor="#dc2626" style="' + $red   + '">DOWN</td>')
    $Html = $Html -replace '<td style="[^"]*">\s*(Up \([^)]*\))\s*</td>',  ('<td bgcolor="#16a34a" style="' + $green + '">$1</td>')
    $Html = $Html -replace '<td style="[^"]*">\s*(Down \([^)]*\))\s*</td>',('<td bgcolor="#dc2626" style="' + $red   + '">$1</td>')
    return $Html
}

function New-CvsReportSectionHtml {
    param([string]$Title,[string]$TableHtml,[string]$Accent = '#1f2937')
    return @"
            <div style="font-family:Segoe UI,Arial,sans-serif;font-size:12px;font-weight:700;color:$Accent;margin:9px 0 2px;padding-bottom:3px;border-bottom:2px solid $Accent;">
              &#9679; $Title
            </div>
            $TableHtml
"@
}

function New-CvsSummaryStrip {
    param([array]$Cards)
    $cells = ''
    foreach ($c in $Cards) {
        $val = [int]$c.Value
        if ($val -gt 0) { $bg = '#dc2626' } else { $bg = '#16a34a' }
        $fg = '#ffffff'
        $cells += @"
                <td valign="top" bgcolor="$bg" style="background:$bg;border-radius:8px;padding:10px 12px;font-family:Segoe UI,Arial,sans-serif;">
                  <div style="font-size:22px;font-weight:700;color:$fg;">$($c.Value)</div>
                  <div style="font-size:11px;color:$fg;white-space:nowrap;">$($c.Label)</div>
                </td>
"@
    }
    return @"
            <table role="presentation" cellpadding="0" cellspacing="6" style="border-collapse:separate;width:100%;table-layout:fixed;margin:2px 0 2px;">
              <tr>
$cells
              </tr>
            </table>
"@
}

function New-CvsReportHtml {
    param([string]$Title,[string]$Summary,[string]$Sections,[string]$FooterScriptName = 'vi_healthcheck.ps1')
    $reportTime = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $summaryBlock = ''
    if (-not [string]::IsNullOrWhiteSpace($Summary)) {
$summaryBlock = @"
        <tr>
          <td style="padding:8px 16px 0;">
            $Summary
          </td>
        </tr>
"@
    }
    return @"
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;-webkit-text-size-adjust:100%;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;">
  <tr>
    <td align="center" style="padding:10px 8px;">
      <table role="presentation" width="1100" cellpadding="0" cellspacing="0" style="max-width:1100px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;">
        <tr>
          <td style="background:#1f2937;padding:14px 18px;font-family:Segoe UI,Arial,sans-serif;color:#ffffff;font-size:17px;font-weight:700;">
            $Title
          </td>
        </tr>
$summaryBlock
        <tr>
          <td style="padding:2px 16px 8px;">
$Sections
          </td>
        </tr>
        <tr>
          <td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:9px 18px;font-family:Segoe UI,Arial,sans-serif;color:#6b7280;font-size:10px;line-height:1.3;">
            Automated report generated by $FooterScriptName &bull; $reportTime
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>
"@
}

function Send-TeamsAlert {
    param(
        [string]$WebhookUrl,
        [string]$Title,
        [string]$Summary,
        [array]$Cards,
        [array]$Details,
        [string]$Severity
    )
    if ([string]::IsNullOrWhiteSpace($WebhookUrl)) { Write-Log 'Teams: no webhook URL supplied, skipping'; return }

    $countLines = @()
    foreach ($c in $Cards) {
        $val  = [int]$c.Value
        $mark = if ($val -gt 0) { 'X' } else { 'OK' }
        $countLines += ("{0}: {1} ({2})" -f $c.Label, $val, $mark)
    }

    $detailLines = @()
    foreach ($d in $Details) {
        if (-not $d.Lines -or $d.Lines.Count -eq 0) { continue }
        $detailLines += ''
        $detailLines += ("**" + $d.Heading + "**")
        foreach ($line in $d.Lines) { $detailLines += ("- " + $line) }
    }
    if ($detailLines.Count -eq 0) { $detailLines += 'No outstanding findings.' }

    $payload = @{
        title    = $Title
        summary  = (($countLines -join '  |  ') + "`n`n" + $Summary)
        details  = ($detailLines -join "`n")
        severity = $Severity
    }

    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $json = $payload | ConvertTo-Json -Depth 6
        Invoke-RestMethod -Uri $WebhookUrl -Method Post -ContentType 'application/json; charset=utf-8' -Body $json -TimeoutSec 30 | Out-Null
        Write-Log "Teams: alert posted (severity=$Severity)"
    } catch {
        Write-Log "Teams: post failed: $($_.Exception.Message)"
    }
}

function SendMail {
    param([string]$Body,[string]$Subject)
    try {
        if ($MailCc -and $MailCc.Count -gt 0) {
            Send-MailMessage -SmtpServer $SMTPServer -From $Global:MailFrom -To $MailTo -Cc $MailCc -Subject $Subject -Body $Body -BodyAsHtml
        } else {
            Send-MailMessage -SmtpServer $SMTPServer -From $Global:MailFrom -To $MailTo -Subject $Subject -Body $Body -BodyAsHtml
        }
        Write-Log "Email sent to $($MailTo -join ', ')"
    } catch { Write-Log "Error sending mail: $($_.Exception.Message)" }
}

# vCenterList accepts:  label|fqdn|ip , fqdn|ip , or fqdn
$vCenters = [ordered]@{}
if (-not [string]::IsNullOrWhiteSpace($vCenterList)) {
    foreach ($entry in $vCenterList.Split(',')) {
        $entry = $entry.Trim()
        if (-not $entry) { continue }

        $parts = @($entry.Split('|') | ForEach-Object { $_.Trim() })

        if ($parts.Count -ge 3) {
            $label = $parts[0]
            $fqdn  = $parts[1]
            $ip    = $parts[2]
        }
        elseif ($parts.Count -eq 2) {
            $fqdn  = $parts[0]
            $ip    = $parts[1]
            $label = $fqdn.Split('.')[0]
        }
        else {
            $fqdn  = $parts[0]
            $ip    = ''
            $label = $fqdn.Split('.')[0]
        }

        if ($fqdn) {
            $vCenters[$label] = [pscustomobject][ordered]@{
                Fqdn = $fqdn
                IP   = $ip
            }
        }
    }
} else {
    # Add each vCenter management IP below to enable the IP failover path.
    # Leaving IP blank preserves the original FQDN-only behavior for that vCenter.
    $vCenters = [ordered]@{
        'ESOC West' = [pscustomobject][ordered]@{
            Fqdn = 'esocoewvcs.washdc.state.sbu'
            IP   = '100.64.0.87'
        }
        'MDC vXRail' = [pscustomobject][ordered]@{
            Fqdn = 'esoco26vcs01.washdc.state.sbu'
            IP   = '100.64.1.70'
        }
        'EW VxRail' = [pscustomobject][ordered]@{
            Fqdn = 'esocoewvcs01.washdc.state.sbu'
            IP   = '100.64.2.100'
        }
        'EW VxRail Staging' = [pscustomobject][ordered]@{
            Fqdn = 'esocoewvcs02.washdc.state.sbu'
            IP   = '100.64.0.20'
        }
        'OW VxRail' = [pscustomobject][ordered]@{
            Fqdn = 'esoco26vcs02.washdc.state.sbu'
            IP   = '100.64.3.100'
        }
    }
}

$availability     = @()
$disconnectedHost = @()
$haEvents         = @()
$clientHaEvents   = @()
$oldSnaps         = @()
$overcommitDs     = @()
$urlResults       = @()

$haVMs = @(); $haHosts = @(); $haVMsLastHour = @(); $haHostsLastHour = @()
$clientVMs = @(); $clientVMsLastHour = @()

$intVcenterDown = 0
$intUrlDown = 0

$now           = Get-Date
$haStart       = $now.AddHours(-$HaLookbackHours)
$lastHourStart = $now.AddHours(-1)

Write-Log "=== VI Health Check start ==="

$Global:VICredential = $null
if (-not [string]::IsNullOrWhiteSpace($env:VC_USER) -and -not [string]::IsNullOrWhiteSpace($env:VC_PASS)) {
    $Global:VICredential = New-Object System.Management.Automation.PSCredential(
        $env:VC_USER,
        (ConvertTo-SecureString $env:VC_PASS -AsPlainText -Force)
    )
    Write-Log "Auth: using VC_USER ($($env:VC_USER))"
} else {
    Write-Log 'Auth: VC_USER/VC_PASS not set, falling back to pass-through (SSPI)'
}

if (!(Get-Module VMware.VimAutomation.Core)) { Import-Module VMware.VimAutomation.Core -ErrorAction SilentlyContinue }
try { Set-PowerCLIConfiguration -InvalidCertificateAction Ignore -Scope Session -Confirm:$false | Out-Null } catch {}
if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$false }

foreach ($label in $vCenters.Keys) {
    $fqdn = [string]$vCenters[$label].Fqdn
    $ip   = [string]$vCenters[$label].IP

    $displayAddress = if ([string]::IsNullOrWhiteSpace($ip)) { $fqdn } else { "$fqdn / $ip" }
    Write-Log "vCenter: $label ($displayAddress)"

    $connectionAddress = $fqdn
    $connectionMethod  = 'FQDN'
    $ms                = Test-Port -ComputerName $fqdn -Port 443

    if ($null -eq $ms -and -not [string]::IsNullOrWhiteSpace($ip)) {
        Write-Log "Warn: $fqdn is unreachable on port 443. Trying fallback IP $ip"
        $ipMs = Test-Port -ComputerName $ip -Port 443

        if ($null -ne $ipMs) {
            $connectionAddress = $ip
            $connectionMethod  = 'IP fallback'
            $ms                = $ipMs
            Write-Log "IP fallback port test succeeded for $label using $ip"
        }
    }

    if ($null -eq $ms) {
        $intVcenterDown++
        $detail = if ([string]::IsNullOrWhiteSpace($ip)) {
            'Port 443 unreachable by FQDN; no fallback IP configured'
        } else {
            'Port 443 unreachable by both FQDN and IP'
        }

        $availability += [pscustomobject][ordered]@{
            vCenter     = $label
            FQDN        = $fqdn
            IP          = $ip
            ConnectedBy = ''
            Result      = 'DOWN'
            ResponseMs  = ''
            Detail      = $detail
        }
        Write-Log "Warn: $label is unreachable on port 443 ($displayAddress)"
        continue
    }

    $connected = $false
    try {
        if ($Global:VICredential) {
            Connect-VIServer -Server $connectionAddress -Credential $Global:VICredential -WarningAction SilentlyContinue -ErrorAction Stop | Out-Null
        } else {
            Connect-VIServer -Server $connectionAddress -WarningAction SilentlyContinue -ErrorAction Stop | Out-Null
        }
        $connected = $true
    } catch {
        Write-Log "Warn: PowerCLI connection failed for $label using $connectionMethod ($connectionAddress): $($_.Exception.Message)"
    }

    if (-not $connected -and $connectionMethod -eq 'FQDN' -and -not [string]::IsNullOrWhiteSpace($ip)) {
        $ipMs = Test-Port -ComputerName $ip -Port 443
        if ($null -ne $ipMs) {
            try {
                Write-Log "Trying PowerCLI fallback connection for $label using IP $ip"
                if ($Global:VICredential) {
                    Connect-VIServer -Server $ip -Credential $Global:VICredential -WarningAction SilentlyContinue -ErrorAction Stop | Out-Null
                } else {
                    Connect-VIServer -Server $ip -WarningAction SilentlyContinue -ErrorAction Stop | Out-Null
                }
                $connectionAddress = $ip
                $connectionMethod  = 'IP fallback'
                $ms                = $ipMs
                $connected         = $true
            } catch {
                Write-Log "Error: PowerCLI fallback connection failed for $label using IP $ip : $($_.Exception.Message)"
            }
        }
    }

    if (-not $connected) {
        $intVcenterDown++
        $availability += [pscustomobject][ordered]@{
            vCenter     = $label
            FQDN        = $fqdn
            IP          = $ip
            ConnectedBy = $connectionMethod
            Result      = 'DOWN'
            ResponseMs  = $ms
            Detail      = 'Port 443 responded, but Connect-VIServer failed by all configured methods'
        }
        continue
    }

    $availability += [pscustomobject][ordered]@{
        vCenter     = $label
        FQDN        = $fqdn
        IP          = $ip
        ConnectedBy = $connectionMethod
        Result      = 'UP'
        ResponseMs  = $ms
        Detail      = ''
    }

    $vms        = @(Get-View -ViewType VirtualMachine -Property Name,Snapshot)
    $datastores = @(Get-View -ViewType Datastore -Property Summary)
    $vmHosts    = @(Get-View -ViewType HostSystem -Property Name,Runtime.ConnectionState,Runtime.InMaintenanceMode,Runtime.PowerState)

    foreach ($vmHost in $vmHosts) {
        $connState = [string]$vmHost.Runtime.ConnectionState
        $powState  = [string]$vmHost.Runtime.PowerState
        $inMaint   = [bool]$vmHost.Runtime.InMaintenanceMode

        $status = $null
        if     ($connState -ne 'connected') { $status = $connState }
        elseif ($powState  -eq 'standBy')   { $status = 'standby' }
        elseif ($inMaint)                   { $status = 'maintenance' }

        if ($status) {
            $disconnectedHost += [pscustomobject][ordered]@{ vCenter=$label; Host=$vmHost.Name; Status=$status }
        }
    }

    $vmHash = @{}
    foreach ($vm in $vms) { $vmHash[$vm.MoRef.Value] = $vm.Name }

    $si  = Get-View ServiceInstance
    $em  = Get-View $si.Content.EventManager
    $spec = New-Object VMware.Vim.EventFilterSpec
    $spec.EventTypeId = $EventTypeIds
    $spec.Time = New-Object VMware.Vim.EventFilterSpecByTime
    $spec.Time.BeginTime = $haStart
    $spec.Time.EndTime   = $now

    $records = @()
    try {
        $collector = Get-View $em.CreateCollectorForEvents($spec)
        $page = $collector.ReadNextEvents(100)
        while ($page) { $records += $page; $page = $collector.ReadNextEvents(100) }
        $collector.DestroyCollector()
    } catch { Write-Log "Warn: event query failed on $connectionAddress : $($_.Exception.Message)" }

    foreach ($record in $records) {
        $created = $record.CreatedTime.ToLocalTime().AddHours($EventTimeOffsetHours)
        $vmName  = if ($record.Vm -and $vmHash.ContainsKey($record.Vm.Vm.Value)) { $vmHash[$record.Vm.Vm.Value] }
                   elseif ($record.Vm) { $record.Vm.Name } else { '' }
        if ($ExcludeVms -contains $vmName) { continue }

        $type = $null; $isClient = $false
        if ($record.EventTypeId -eq 'com.vmware.vc.ha.VmRestartedByHAEvent') { $type = 'HA VM Restart' }
        elseif ($record.EventTypeId -eq 'com.vmware.vc.HA.CannotResetVmWithInaccessibleDatastore') { $type = 'HA VM Restart Failure' }
        elseif ($record.Message -and $record.Message.StartsWith('The storage backing virtual disk')) { $type = 'Storage - Lost Access' }
        elseif ($record.FullFormattedMessage -and $record.FullFormattedMessage -match 'reset by vSphere HA\. Reason: VMware Tools heartbeat failure') { $type = 'Restart After VM Heartbeat Failure'; $isClient = $true }
        elseif ($record.FullFormattedMessage -and $record.FullFormattedMessage -match 'reset by vSphere HA\. Reason: Guest OS crash failure') { $type = 'Restart After Guest OS Crash'; $isClient = $true }
        if (-not $type) { continue }

        $hostName = if ($record.Host) { $record.Host.Name } else { '' }
        $inc = [pscustomobject][ordered]@{
            CreatedTime = $created.ToString('yyyy-MM-dd HH:mm')
            IncidentType = $type
            VM = $vmName
            Host = $hostName
            vCenter = $label
            Detail = ([string]$record.FullFormattedMessage -replace ',', ' ')
        }

        if ($isClient) {
            $clientHaEvents += $inc
            if ($clientVMs -notcontains $vmName) { $clientVMs += $vmName }
            if ($created -ge $lastHourStart -and $clientVMsLastHour -notcontains $vmName) { $clientVMsLastHour += $vmName }
        } else {
            $haEvents += $inc
            if ($haVMs -notcontains $vmName) { $haVMs += $vmName }
            if ($hostName -and $haHosts -notcontains $hostName) { $haHosts += $hostName }
            if ($created -ge $lastHourStart) {
                if ($haVMsLastHour -notcontains $vmName) { $haVMsLastHour += $vmName }
                if ($hostName -and $haHostsLastHour -notcontains $hostName) { $haHostsLastHour += $hostName }
            }
        }
    }

    foreach ($vm in $vms) {
        if ($null -ne $vm.Snapshot) {
            foreach ($root in $vm.Snapshot.RootSnapshotList) {
                $ageDays = (New-TimeSpan -Start $root.CreateTime -End $now).Days
                if ($ageDays -gt $SnapshotAgeDays) {
                    $oldSnaps += [pscustomobject][ordered]@{
                        AgeInDays    = $ageDays
                        Created      = $root.CreateTime.ToString('yyyy-MM-dd HH:mm')
                        SnapshotName = $root.Name
                        VM           = $vm.Name
                        vCenter      = $label
                        Description  = ([string]$root.Description -replace '\s+',' ').Trim()
                    }
                }
            }
        }
    }

    foreach ($ds in $datastores) {
        if ($ds.Summary.Capacity -eq 0) { continue }
        $percentFree = [Math]::Round(($ds.Summary.FreeSpace / $ds.Summary.Capacity) * 10000) / 100
        if ($percentFree -lt $DatastorePercentFree -and $ds.Summary.Uncommitted -gt $ds.Summary.FreeSpace) {
            $overcommitDs += [pscustomobject][ordered]@{
                Datastore = $ds.Summary.Name
                PercentFree = $percentFree
                FreeSpaceGB = [Math]::Round($ds.Summary.FreeSpace / $BYTES_IN_GB)
                UncommittedGB = [Math]::Round($ds.Summary.Uncommitted / $BYTES_IN_GB)
                CapacityGB = [Math]::Round($ds.Summary.Capacity / $BYTES_IN_GB)
                vCenter = $label
            }
        }
    }

    Disconnect-VIServer -Force -Confirm:$false
}
if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$false }

foreach ($label in $vCenters.Keys) {
    $fqdn = [string]$vCenters[$label].Fqdn
    $ip   = [string]$vCenters[$label].IP

    $fqdnUrl   = "https://$fqdn/ui"
    $testedUrl = $fqdnUrl
    $testedBy  = 'FQDN'
    $code      = Test-Url -Url $fqdnUrl -IgnoreSsl

    if ($code -notin @(200,401,403,500) -and -not [string]::IsNullOrWhiteSpace($ip)) {
        $ipUrl = "https://$ip/ui"
        Write-Log "Warn: URL test for $label failed through FQDN with HTTP $code. Trying IP $ip"
        $ipCode = Test-Url -Url $ipUrl -IgnoreSsl

        if ($ipCode -in @(200,401,403,500)) {
            $code      = $ipCode
            $testedUrl = $ipUrl
            $testedBy  = 'IP fallback'
        } elseif ($code -eq 0) {
            $code      = $ipCode
            $testedUrl = $ipUrl
            $testedBy  = 'IP fallback'
        }
    }

    if ($code -in @(200,401,403,500)) {
        $status = "Up ($code)"
    } else {
        $status = "Down ($code)"
        $intUrlDown++
    }

    $urlResults += [pscustomobject][ordered]@{
        Application = $label
        FQDN        = $fqdn
        IP          = $ip
        TestedBy    = $testedBy
        URL         = $testedUrl
        Status      = $status
    }
}

$errorsFound = ($intVcenterDown -gt 0) -or ($disconnectedHost.Count -gt 0) -or ($haEvents.Count -gt 0) -or ($clientHaEvents.Count -gt 0) -or ($overcommitDs.Count -gt 0) -or ($intUrlDown -gt 0)

$cards = @(
    @{ Label='vCenters down';        Value=$intVcenterDown },
    @{ Label='Disc/Maint hosts';     Value=$disconnectedHost.Count },
    @{ Label='HA events (24h)';      Value=$haEvents.Count },
    @{ Label='Client HA (24h)';      Value=$clientHaEvents.Count },
    @{ Label='Datastores <5% free';  Value=$overcommitDs.Count },
    @{ Label='Old snapshots';        Value=$oldSnaps.Count },
    @{ Label='URLs down';            Value=$intUrlDown }
)
$summaryStrip = New-CvsSummaryStrip -Cards $cards

$haContext = ''
if ($haEvents.Count -gt 0) {
    $haContext = "<p style='font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:#374151;margin:2px 0 6px;'>Last hour: <b>$($haVMsLastHour.Count)</b> VMs / <b>$($haHostsLastHour.Count)</b> hosts &nbsp;|&nbsp; Last 24h: <b>$($haVMs.Count)</b> VMs / <b>$($haHosts.Count)</b> hosts</p>"
}
$clientContext = ''
if ($clientHaEvents.Count -gt 0) {
    $clientContext = "<p style='font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:#374151;margin:2px 0 6px;'>Last hour: <b>$($clientVMsLastHour.Count)</b> VMs &nbsp;|&nbsp; Last 24h: <b>$($clientVMs.Count)</b> VMs</p>"
}

$fAvail  = $availability     | Sort-Object Result,vCenter | Select-Object vCenter,FQDN,IP,ConnectedBy,Result,ResponseMs,Detail | ConvertTo-Html -Fragment
$fHosts  = $disconnectedHost | Sort-Object vCenter,Host | ConvertTo-Html -Fragment
$fHa     = $haEvents         | Sort-Object CreatedTime -Descending | ConvertTo-Html -Fragment
$fClient = $clientHaEvents   | Sort-Object CreatedTime -Descending | ConvertTo-Html -Fragment
$fDs     = $overcommitDs     | Sort-Object PercentFree | ConvertTo-Html -Fragment
$fOld    = $oldSnaps         | Sort-Object AgeInDays -Descending | ConvertTo-Html -Fragment
$fUrl    = $urlResults       | Sort-Object Status,Application | ConvertTo-Html -Fragment

$sections  = New-CvsReportSectionHtml -Title 'vCenter Availability' -TableHtml (Set-StatusColors (Format-CvsTableHtml -Fragment ($fAvail -join "`n") -Accent '#0c4a6e')) -Accent '#0c4a6e'
$sections += New-CvsReportSectionHtml -Title 'Disconnected/Maintenance Hosts' -TableHtml (Format-CvsTableHtml -Fragment ($fHosts -join "`n") -Accent '#075985') -Accent '#075985'
$sections += New-CvsReportSectionHtml -Title 'HA Events (last 24 hours)' -TableHtml ($haContext + (Format-CvsTableHtml -Fragment ($fHa -join "`n") -Accent '#0e7490')) -Accent '#0e7490'
$sections += New-CvsReportSectionHtml -Title 'Client HA Events (last 24 hours)' -TableHtml ($clientContext + (Format-CvsTableHtml -Fragment ($fClient -join "`n") -Accent '#155e75')) -Accent '#155e75'
$sections += New-CvsReportSectionHtml -Title 'Overcommitted Datastores (< 5% free)' -TableHtml (Format-CvsTableHtml -Fragment ($fDs -join "`n") -Accent '#0369a1') -Accent '#0369a1'
$sections += New-CvsReportSectionHtml -Title "Snapshots older than $SnapshotAgeDays days" -TableHtml (Format-CvsTableHtml -Fragment ($fOld -join "`n") -Accent '#1e40af') -Accent '#1e40af'
$sections += New-CvsReportSectionHtml -Title 'URL Test Results' -TableHtml (Set-StatusColors (Format-CvsTableHtml -Fragment ($fUrl -join "`n") -Accent '#3730a3')) -Accent '#3730a3'

$subjectParts = @()
if ($intVcenterDown -gt 0)     { $subjectParts += "$intVcenterDown vCenters down" }
if ($disconnectedHost.Count)   { $subjectParts += "$($disconnectedHost.Count) hosts disconnected" }
if ($haEvents.Count)           { $subjectParts += "$($haEvents.Count) HA events" }
if ($clientHaEvents.Count)     { $subjectParts += "$($clientHaEvents.Count) client HA" }
if ($overcommitDs.Count)       { $subjectParts += "$($overcommitDs.Count) datastores <5%" }
if ($intUrlDown -gt 0)         { $subjectParts += "$intUrlDown URLs down" }
if (-not $errorsFound)         { $subjectParts += 'No Problems Found' }
$subject = "$MailSubjectstring - " + ($subjectParts -join ' | ')

$body = New-CvsReportHtml -Title 'VI Health Check' -Summary $summaryStrip -Sections $sections -FooterScriptName 'vi_healthcheck.ps1'
$body = (($body -split "`r?`n") | ForEach-Object { $_.TrimEnd() } | Where-Object { $_.Trim().Length -gt 0 }) -join "`n"
try { $body | Out-File -FilePath (Join-Path $Global:DebugDir 'vi_healthcheck_result.html') -Encoding utf8 } catch {}

if ($eMailReport -eq 'yes') { SendMail -Body $body -Subject $subject }

if ($TeamsAlert -eq 'yes') {
    if ($TeamsAlertOnlyOnError -eq 'yes' -and -not $errorsFound) {
        Write-Log 'Teams: no findings, alert suppressed'
    } else {
        $details = @()
        $details += @{ Heading = 'vCenters unreachable'; Lines = @($availability | Where-Object { $_.Result -eq 'DOWN' } | Select-Object -First $TeamsMaxRows | ForEach-Object {
            $addr = if ([string]::IsNullOrWhiteSpace($_.IP)) { $_.FQDN } else { "$($_.FQDN) / $($_.IP)" }
            "$($_.vCenter) ($addr) - $($_.Detail)"
        }) }
        $details += @{ Heading = 'Hosts not connected';  Lines = @($disconnectedHost | Select-Object -First $TeamsMaxRows | ForEach-Object { "$($_.Host) [$($_.vCenter)] - $($_.Status)" }) }
        $details += @{ Heading = 'HA events';            Lines = @($haEvents | Sort-Object CreatedTime -Descending | Select-Object -First $TeamsMaxRows | ForEach-Object { "$($_.CreatedTime) $($_.VM) - $($_.IncidentType)" }) }
        $details += @{ Heading = 'Client HA events';     Lines = @($clientHaEvents | Sort-Object CreatedTime -Descending | Select-Object -First $TeamsMaxRows | ForEach-Object { "$($_.CreatedTime) $($_.VM) - $($_.IncidentType)" }) }
        $details += @{ Heading = 'Datastores under 5% free'; Lines = @($overcommitDs | Sort-Object PercentFree | Select-Object -First $TeamsMaxRows | ForEach-Object { "$($_.Datastore) [$($_.vCenter)] - $($_.PercentFree)% free, $($_.UncommittedGB) GB uncommitted" }) }
        $details += @{ Heading = 'URLs down';            Lines = @($urlResults | Where-Object { $_.Status -like 'Down*' } | Select-Object -First $TeamsMaxRows | ForEach-Object { "$($_.Application) [$($_.TestedBy)] - $($_.Status)" }) }

        $teamsTitle = if ($errorsFound) { 'VI Health Check - Issues Detected' } else { 'VI Health Check - All Clear' }
        $teamsSummary = "$(Get-Date -Format 'yyyy-MM-dd HH:mm') | " + ($subjectParts -join ' | ')

        if ($intVcenterDown -gt 0 -or $disconnectedHost.Count -gt 0 -or $intUrlDown -gt 0) { $severity = 'high' }
        elseif ($haEvents.Count -gt 0 -or $clientHaEvents.Count -gt 0 -or $overcommitDs.Count -gt 0) { $severity = 'medium' }
        else { $severity = 'low' }

        Send-TeamsAlert -WebhookUrl $TeamsWebhookUrl -Title $teamsTitle -Summary $teamsSummary -Cards $cards -Details $details -Severity $severity
    }
}

Write-Log "=== VI Health Check end ($subject) ==="