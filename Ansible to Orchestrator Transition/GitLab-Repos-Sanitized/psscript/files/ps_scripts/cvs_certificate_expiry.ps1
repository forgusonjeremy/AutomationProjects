[CmdletBinding()]
param(
    [string]$Action,                 # accepted for playbook compatibility; not used (dedicated script)
    [string]$eMailReport = 'no',
    [string]$SMTPServer,
    [string]$MailToString,
    [string]$MailCcString,
    [string]$MailSubjectstring,
    [string]$vCenterList,
    [int]$ExpiryDays = 90,
    [string]$CheckEsxi = 'yes',
    [string]$CheckRegisteredSolutions = 'yes',
    [int]$ConnectionTimeoutMs = 5000
)

$script:ReportName = 'cvs_certificate_expiry report'
$script:LogFileName = 'cvs_certificate_expiry.log'

# ---- Standalone framework shims (not sourcing cvs_functions.ps1) -------------
$DebugDir = Join-Path $PSScriptRoot 'debug'
if (-not (Test-Path $DebugDir)) { New-Item -ItemType Directory -Path $DebugDir -Force | Out-Null }
$LogFile = Join-Path $DebugDir $script:LogFileName

function Write-Log { param([string]$Message) $line = ('{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message); $line | Out-File -FilePath $LogFile -Append -Encoding utf8; Write-Host $line }

function Format-CvsTableHtml {
    param([string]$Fragment,[string]$Accent,[string]$EmptyText = 'None in this range.')
    if ([string]::IsNullOrWhiteSpace($Fragment) -or ($Fragment -notmatch '<td')) { return ('<p style="margin:6px 0 20px;padding:10px 12px;background:#f9fafb;border:1px dashed #d1d5db;border-radius:4px;color:#6b7280;font-size:13px;font-family:Segoe UI,Arial,sans-serif;">' + $EmptyText + '</p>') }
    $t = $Fragment
    $t = $t -replace '<table>','<table cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;width:100%;margin:6px 0 20px;font-family:Segoe UI,Arial,sans-serif;font-size:13px;">'
    $t = $t -replace '<th>',('<th align="left" bgcolor="' + $Accent + '" style="background:' + $Accent + ';color:#ffffff;text-align:left;padding:9px 11px;font-weight:600;font-size:12px;white-space:nowrap;border:1px solid ' + $Accent + ';">')
    $t = $t -replace '<td>','<td style="padding:7px 11px;border:1px solid #e5e7eb;color:#111827;background:#ffffff">'
    $t = $t -replace '(<td style="[^"]+?)(">)(\s*[\d.,-]+\s*)(</td>)','$1;text-align:right$2$3$4'
    $script:__zebraRow = 0
    $t = [regex]::Replace($t, '<tr>(?=\s*<td)', { param($m) $script:__zebraRow++; if ($script:__zebraRow % 2 -eq 0) { '<tr style="background:#f9fafb">' } else { '<tr>' } })
    return $t
}

function Convert-RowsToStyledHtml { param([array]$Rows,[string]$Accent,[string]$EmptyText = 'None in this range.') if (($null -eq $Rows) -or (@($Rows).Count -eq 0)) { return Format-CvsTableHtml -Fragment '' -Accent $Accent -EmptyText $EmptyText } $fragment = $Rows | ConvertTo-Html -Fragment; return Format-CvsTableHtml -Fragment ($fragment -join "`n") -Accent $Accent -EmptyText $EmptyText }
function Get-ShortVcName { param([string]$vCenter) if ([string]::IsNullOrWhiteSpace($vCenter)) { return '' } return ($vCenter.Trim().Split('.')[0]) }
function Test-VcenterTcp443 { param([string]$Server) $tcp = New-Object System.Net.Sockets.TcpClient; try { $iar = $tcp.BeginConnect($Server,443,$null,$null); if (-not $iar.AsyncWaitHandle.WaitOne(5000)) { Write-Log "  $Server unreachable on 443 (5s timeout) - skipping"; return $false }; $tcp.EndConnect($iar); return $true } catch { Write-Log "  $Server TCP 443 test failed: $($_.Exception.Message) - skipping"; return $false } finally { $tcp.Close() } }

function Get-RemoteSslCertRow {
    param(
        [string]$vCenterShort,
        [string]$Scope,
        [string]$Name,
        [string]$HostName,
        [int]$Port = 443,
        [string]$SourceUrl = '',
        [int]$TimeoutMs = 5000
    )

    if ([string]::IsNullOrWhiteSpace($HostName)) { return $null }
    $tcp = New-Object System.Net.Sockets.TcpClient
    $ssl = $null
    try {
        $iar = $tcp.BeginConnect($HostName, $Port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs)) { throw "TCP connect timed out after $TimeoutMs ms" }
        $tcp.EndConnect($iar)
        $callback = [System.Net.Security.RemoteCertificateValidationCallback]{ param($sender,$certificate,$chain,$sslPolicyErrors) return $true }
        $ssl = New-Object System.Net.Security.SslStream($tcp.GetStream(), $false, $callback)
        $ssl.AuthenticateAsClient($HostName)
        $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($ssl.RemoteCertificate)
        $notAfter = [datetime]$cert.NotAfter
        $days = [int](New-TimeSpan -Start (Get-Date) -End $notAfter).TotalDays
        $status = if ($days -lt 0) { 'Expired' } elseif ($days -le 30) { 'Expires within 30 days' } elseif ($days -le 90) { 'Expires within 90 days' } else { 'OK' }
        return [pscustomobject][ordered]@{
            'Status'      = $status
            'vCenter'     = $vCenterShort
            'Scope'       = $Scope
            'Name'        = $Name
            'Endpoint'    = "$HostName`:$Port"
            'DaysLeft'    = $days
            'Expires'     = $notAfter.ToString('yyyy-MM-dd HH:mm:ss')
            'Subject'     = $cert.Subject
            'Issuer'      = $cert.Issuer
            'Thumbprint'  = $cert.Thumbprint
            'SourceUrl'   = $SourceUrl
        }
    } catch {
        Write-Log "    Certificate check failed for [$Scope][$Name][$HostName`:$Port]: $($_.Exception.Message)"
        return [pscustomobject][ordered]@{
            'Status'      = 'Check failed'
            'vCenter'     = $vCenterShort
            'Scope'       = $Scope
            'Name'        = $Name
            'Endpoint'    = "$HostName`:$Port"
            'DaysLeft'    = $null
            'Expires'     = ''
            'Subject'     = ''
            'Issuer'      = ''
            'Thumbprint'  = ''
            'SourceUrl'   = $SourceUrl
        }
    } finally {
        if ($ssl) { $ssl.Dispose() }
        if ($tcp) { $tcp.Close() }
    }
}

function Get-HttpsEndpointFromUrl {
    param([string]$Url)
    try {
        if ([string]::IsNullOrWhiteSpace($Url)) { return $null }
        $uri = [uri]$Url
        if ($uri.Scheme -ne 'https') { return $null }
        $port = if ($uri.Port -gt 0) { $uri.Port } else { 443 }
        return [pscustomobject]@{ Host = $uri.Host; Port = $port; Url = $Url }
    } catch { return $null }
}

$MailFrom = 'user5@dom3.example'
[array]$allResults = @()

Write-Log "=== $script:ReportName start (Action=$Action) ==="
Write-Log "Thresholds: ExpiryDays=$ExpiryDays CheckEsxi=$CheckEsxi CheckRegisteredSolutions=$CheckRegisteredSolutions ConnectionTimeoutMs=$ConnectionTimeoutMs"

if ([string]::IsNullOrEmpty($env:VC_USER) -or [string]::IsNullOrEmpty($env:VC_PASS)) { Write-Log "ERROR: VC_USER/VC_PASS not present in environment - vault creds not delivered by the task. Aborting."; exit 1 }
$vcCred = [pscredential]::new($env:VC_USER,(ConvertTo-SecureString $env:VC_PASS -AsPlainText -Force))
Write-Log "Credential built for user [$($vcCred.UserName)]."

Write-Log "Loading PowerCLI module..."
if (!(Get-Module VMware.VimAutomation.Core)) { Import-Module VMware.VimAutomation.Core }
Set-PowerCLIConfiguration -InvalidCertificateAction Ignore -Scope Session -Confirm:$false | Out-Null
Write-Log "PowerCLI ready."

if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$False }

foreach ($vcenter in $vCenterList.Split(',')) {
    $vcenter = $vcenter.Trim()
    if ([string]::IsNullOrWhiteSpace($vcenter)) { continue }
    $vcShort = Get-ShortVcName $vcenter
    Write-Log "vCenter: $vcenter"

    # vCenter certificate itself can be checked before authenticating.
    $allResults += Get-RemoteSslCertRow -vCenterShort $vcShort -Scope 'vCenter' -Name $vcenter -HostName $vcenter -Port 443 -SourceUrl "https://$vcenter/" -TimeoutMs $ConnectionTimeoutMs

    if (-not (Test-VcenterTcp443 -Server $vcenter)) { continue }

    try {
        Write-Log "  Connecting to $vcenter..."
        Connect-VIServer -Server $vcenter -Credential $vcCred -Force -WarningAction 0 -ErrorAction Stop | Out-Null
        Write-Log "  Connected. Gathering ESXi hosts and registered extension endpoints."

        if ($CheckEsxi -eq 'yes') {
            [array]$vmhosts = @(Get-VMHost | Sort-Object Name)
            Write-Log "  ESXi host count: $($vmhosts.Count)"
            foreach ($host in $vmhosts) {
                $hostName = $host.Name
                $allResults += Get-RemoteSslCertRow -vCenterShort $vcShort -Scope 'ESXi Host' -Name $hostName -HostName $hostName -Port 443 -SourceUrl "https://$hostName/" -TimeoutMs $ConnectionTimeoutMs
            }
        }

        if ($CheckRegisteredSolutions -eq 'yes') {
            try {
                $em = Get-View ExtensionManager -ErrorAction Stop
                [array]$extensions = @($em.ExtensionList | Sort-Object Key)
                Write-Log "  Registered extension count: $($extensions.Count)"
                $seen = @{}
                foreach ($ext in $extensions) {
                    $urls = @()
                    if ($ext.Server) { foreach ($server in $ext.Server) { if ($server.Url) { $urls += $server.Url } } }
                    if ($ext.Client) { foreach ($client in $ext.Client) { if ($client.Url) { $urls += $client.Url } } }
                    foreach ($url in ($urls | Sort-Object -Unique)) {
                        $endpoint = Get-HttpsEndpointFromUrl -Url $url
                        if ($null -eq $endpoint) { continue }
                        $dedupeKey = "$($ext.Key)|$($endpoint.Host)|$($endpoint.Port)"
                        if ($seen.ContainsKey($dedupeKey)) { continue }
                        $seen[$dedupeKey] = $true
                        $allResults += Get-RemoteSslCertRow -vCenterShort $vcShort -Scope 'Registered Solution' -Name $ext.Key -HostName $endpoint.Host -Port $endpoint.Port -SourceUrl $endpoint.Url -TimeoutMs $ConnectionTimeoutMs
                    }
                }
            } catch {
                Write-Log "  Registered extension lookup failed on $vcenter : $($_.Exception.Message)"
            }
        }
    } catch {
        Write-Log "  ERROR processing $vcenter : $($_.Exception.Message)"
    } finally {
        if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$False }
    }
}

if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$False }
$allResults = @($allResults | Where-Object { $null -ne $_ })
Write-Log "Collection complete. $($allResults.Count) certificate endpoints evaluated."

$expired = @($allResults | Where-Object { $_.Status -eq 'Expired' } | Sort-Object DaysLeft)
$expiring = @($allResults | Where-Object { ($_.DaysLeft -ne $null) -and ($_.DaysLeft -ge 0) -and ($_.DaysLeft -le $ExpiryDays) } | Sort-Object DaysLeft)
$failed = @($allResults | Where-Object { $_.Status -eq 'Check failed' } | Sort-Object Scope, Name)
$okSample = @($allResults | Where-Object { ($_.DaysLeft -ne $null) -and ($_.DaysLeft -gt $ExpiryDays) } | Sort-Object DaysLeft | Select-Object -First 25)

$alert_title = "$($expired.Count) expired | $($expiring.Count) expiring within $ExpiryDays days | $($failed.Count) check failures"
$tblExpired = Convert-RowsToStyledHtml -Rows $expired -Accent '#7f1d1d' -EmptyText 'No expired certificates found.'
$tblExpiring = Convert-RowsToStyledHtml -Rows $expiring -Accent '#b91c1c' -EmptyText "No certificates expire within $ExpiryDays days."
$tblFailed = Convert-RowsToStyledHtml -Rows $failed -Accent '#c2410c' -EmptyText 'No certificate checks failed.'
$tblOk = Convert-RowsToStyledHtml -Rows $okSample -Accent '#64748b' -EmptyText 'No OK certificate sample rows to show.'
$reportTime = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

$body = @"
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;-webkit-text-size-adjust:100%;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="1120" cellpadding="0" cellspacing="0" style="max-width:1120px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      <tr><td style="background:#1f2937;padding:20px 28px;font-family:Segoe UI,Arial,sans-serif;color:#ffffff;font-size:19px;font-weight:700;">VMware Certificate Expiry Report</td></tr>
      <tr><td style="padding:18px 28px 4px;font-family:Segoe UI,Arial,sans-serif;color:#374151;font-size:13px;line-height:1.5;">
        Checks vCenter certificates, ESXi host HTTPS certificates, and HTTPS endpoints registered through vCenter ExtensionManager. Certificates expiring within <b>$ExpiryDays days</b> are flagged. Check failures usually mean DNS/routing/firewall/handshake issues from the Ansible execution host to that endpoint.
      </td></tr>
      <tr><td style="padding:8px 28px 4px;">
        <div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:700;color:#7f1d1d;margin:14px 0 0;padding-bottom:6px;border-bottom:2px solid #7f1d1d;">&#9679; Expired certificates</div>
        $tblExpired
        <div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:700;color:#b91c1c;margin:14px 0 0;padding-bottom:6px;border-bottom:2px solid #b91c1c;">&#9679; Expiring certificates &nbsp;&ndash;&nbsp; within $ExpiryDays days</div>
        $tblExpiring
        <div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:700;color:#c2410c;margin:14px 0 0;padding-bottom:6px;border-bottom:2px solid #c2410c;">&#9679; Certificate check failures</div>
        $tblFailed
        <div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:700;color:#64748b;margin:14px 0 0;padding-bottom:6px;border-bottom:2px solid #64748b;">&#9679; OK sample &nbsp;&ndash;&nbsp; next 25 after threshold</div>
        $tblOk
      </td></tr>
      <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 28px;font-family:Segoe UI,Arial,sans-serif;color:#6b7280;font-size:11px;line-height:1.5;">
        Automated report generated by cvs_certificate_expiry.ps1 via Ansible &bull; $reportTime
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>
"@

$resultFile = Join-Path $DebugDir 'result.html'
$body | Out-File -FilePath $resultFile -Encoding utf8
$csvFile = Join-Path $DebugDir 'certificate_expiry.csv'
$allResults | Sort-Object @{Expression='DaysLeft';Ascending=$true}, Scope, Name | Export-Csv -NoTypeInformation -Path $csvFile -Encoding utf8
Write-Log "Report written: $resultFile ($alert_title)"
Write-Log "CSV written: $csvFile"

if ($eMailReport -eq 'yes') {
    $mailParams = @{ SmtpServer = $SMTPServer; From = $MailFrom; To = ($MailToString -split ',').Trim(); Subject = "$MailSubjectstring | $alert_title"; Body = $body; BodyAsHtml = $true }
    if ($MailCcString) { $mailParams.Cc = ($MailCcString -split ',').Trim() }
    Send-MailMessage @mailParams
    Write-Log "Email sent to $MailToString"
}

Write-Log "=== $script:ReportName end ==="
