[CmdletBinding()]
param(
    [string[]] $reportAreas   = @('conus', 'oconus', 'combined'),
    [string[]] $emailAreas    = @('conus', 'oconus'),
    [ValidateSet('ALL', 'CONUS', 'OCONUS')]
    [string]   $collectArea   = 'ALL',
    [string]   $extraEndpoints = $env:EXTRA_ENDPOINTS,
    [string]   $csvPath,
    [string]   $pbiPath,
    [switch]   $includeSts,
    [switch]   $includeTrustedRoots,
    [switch]   $includeVecs,
    [switch]   $skipIcmp,
    [switch]   $exclusiveBands,
    [switch]   $legacyColumns = $true,
    [switch]   $noEmail,
    [switch]   $testing,
    [int]      $webTimeoutSec  = 15,
    [int]      $progressEvery  = 25,
    [string]   $onlyVc,
    [switch]   $skipUnreachable,
    [string]   $transcriptPath,
    [string]   $plinkPath      = 'C:\Program Files\PuTTY\plink.exe',
    [string]   $renderSample,
    [string]   $smtpServer
)

# =============================================================================
#  EDIT — vCenter inventory
#  Name   = VM name of the vCenter appliance
#  FQDN   = connection target
#  Area   = CONUS | OCONUS
#  Active = $false retires a vCenter without deleting the line
# =============================================================================
$vCenterList = @(
    [pscustomobject]@{ Name = 'ESOCO26VCS01'; FQDN = 'dom10.dom5.dom3.invalid'; Area = 'CONUS';  Active = $true }
    [pscustomobject]@{ Name = 'ESOCO26VCS02'; FQDN = 'dom11.dom5.dom3.invalid'; Area = 'CONUS';  Active = $true }
    [pscustomobject]@{ Name = 'ESOCOEWVCS';   FQDN = 'dom14.dom5.dom3.invalid';   Area = 'CONUS';  Active = $true }
    [pscustomobject]@{ Name = 'ESOCOEWVCS01'; FQDN = 'dom9.dom5.dom3.invalid'; Area = 'CONUS';  Active = $true }
    [pscustomobject]@{ Name = 'ESOCOEWVCS02'; FQDN = 'dom8.dom5.dom3.invalid'; Area = 'CONUS';  Active = $true }
    [pscustomobject]@{ Name = 'AFVC60';       FQDN = 'dom44.dom45.dom3.invalid';           Area = 'OCONUS'; Active = $true }
    [pscustomobject]@{ Name = 'EAPVC60';      FQDN = 'dom40.dom41.dom3.invalid';         Area = 'OCONUS'; Active = $true }
    [pscustomobject]@{ Name = 'EURVC60';      FQDN = 'dom38.dom39.dom3.invalid';         Area = 'OCONUS'; Active = $true }
    [pscustomobject]@{ Name = 'GITMVC651ST';  FQDN = 'dom12.dom5.dom3.invalid';  Area = 'OCONUS'; Active = $true }
    [pscustomobject]@{ Name = 'NEASAVC60';    FQDN = 'dom24.dom25.dom3.invalid';     Area = 'OCONUS'; Active = $true }
    [pscustomobject]@{ Name = 'WHAVC60';      FQDN = 'dom42.dom43.dom3.invalid';         Area = 'OCONUS'; Active = $true }
)

# =============================================================================
#  EDIT — approved issuers (matched against the leading CN of the issuer DN)
# =============================================================================
$caSigned = @(
    'U.S. Department of State AD High Assurance CA'
    'DOSMSSUBCA'
    'U.S. Department of State NPE03 Sub CA'
    'dom10.dom5.dom3.invalid'
    'dom11.dom5.dom3.invalid'
    'dom14.dom5.dom3.invalid'
    'dom9.dom5.dom3.invalid'
    'dom8.dom5.dom3.invalid'
    'dom44.dom45.dom3.invalid'
    'dom40.dom41.dom3.invalid'
    'dom38.dom39.dom3.invalid'
    'dom12.dom5.dom3.invalid'
    'dom24.dom25.dom3.invalid'
    'dom42.dom43.dom3.invalid'
)

# =============================================================================
#  EDIT — paths, email distros, thresholds
# =============================================================================
if (-not $csvPath)    { $csvPath = 'D:\CVS_SSL' }
if (-not $pbiPath)    { $pbiPath = '\\dom7.dom5.dom3.invalid\ceisshare$\ViPR\Datastores\SSL' }
if (-not $smtpServer) { $smtpServer = 'dom1.dom2.dom3.example' }
$archivePath = Join-Path $csvPath 'Archive'
$mailFrom    = "$env:user7@dom3.example"
$emailSend   = $true          

# Target for -renderSample previews and for the -testing override.
$reportRecipient = 'user3@dom3.example'
$testingTo       = @($reportRecipient)

$distros = @{
    conus = @{
        Summary   = @{ To = @('user1@dom3.example', 'user8@dom3.example', 'user2@dom3.example')
                       Cc = @('user9@dom3.example') }
        Files     = @{ To = @('user1@dom3.example', 'user8@dom3.example', 'user2@dom3.example')
                       Cc = @('user9@dom3.example') }
        FilesList = @('user10@dom3.example', 'user11@dom3.example')
    }
    oconus = @{
        Summary   = @{ To = @('user12@dom3.example', 'user1@dom3.example', 'user8@dom3.example')
                       Cc = @('user9@dom3.example', 'user13@dom3.example', 'user14@dom3.example', 'user15@dom3.example') }
        Files     = @{ To = @('user12@dom3.example', 'user1@dom3.example', 'user8@dom3.example')
                       Cc = @('user9@dom3.example', 'user15@dom3.example') }
        FilesList = @('user12@dom3.example')
    }
}

$pbiUrl = 'https://app.powerbigov.us/groups/00000001-0000-4000-8000-000000000001/reports/00000002-0000-4000-8000-000000000002'

[int]$bandPast = 0
$band1mon = 30.5
$band3mon = 91.25
$band6mon = 182.5
$bandYear = 365

# ============================ NO EDITING BEYOND THIS POINT ===================

$fnt   = 'font-family:Aptos,Calibri,Arial,sans-serif;'
$cInk  = '#1f2937'
$cMute = '#6b7280'
$cLine = '#d1d5db'
$cZeb  = '#f9fafb'
$cBan  = '#0f172a'
$cOff  = '#9ca3af'
$cHot  = '#b91c1c'
$cDim  = '#64748b'

$accFail = '#0369a1'
$accInv  = '#c2410c'
$accExp  = '#b91c1c'

function HE { param($s) [System.Web.HttpUtility]::HtmlEncode([string]$s) }

function P {
    param([string]$Text, [string]$Size = '9.5pt', [string]$Color = $cInk,
          [string]$Weight = '400', [string]$Align = 'left', [string]$Extra = '')
    "<p style='margin:0;padding:0;text-align:$Align;$fnt'>" +
    "<span style='font-size:$Size;color:$Color;font-weight:$Weight;$Extra$fnt'>$Text</span></p>"
}

function Format-CvsTableHtml {
    param($Rows, [string[]]$Columns, [string]$Accent, [string[]]$Emphasis = @(), [string]$DividerBefore)
    if (-not $Rows) { return '' }

    $head = ''
    foreach ($c in $Columns) {
        $al  = if ($c -eq 'vCenter') { 'left' } else { 'right' }
        $div = if ($c -eq $DividerBefore) { 'border-left:2px solid #ffffff;' } else { '' }
        $head += "<td nowrap bgcolor='$Accent' style='background-color:$Accent;padding:7px 10px;" +
                 "border:1px solid $Accent;$div'>" +
                 (P -Text $c -Size '8.5pt' -Color '#ffffff' -Weight '700' -Align $al -Extra 'letter-spacing:.4px;') +
                 "</td>"
    }

    $body = ''
    $n = 0
    foreach ($r in $Rows) {
        $isTotal = ($r.vCenter -eq 'ALL')
        $bg = if ($isTotal) { '#eef2f7' } elseif ($n % 2) { $cZeb } else { '#ffffff' }
        $bb = if ($isTotal) { "border-bottom:2px solid $Accent;" } else { '' }
        $cells = ''
        foreach ($c in $Columns) {
            $div = if ($c -eq $DividerBefore) { "border-left:2px solid $cLine;" } else { '' }
            if ($c -eq 'vCenter') {
                $col = if ($isTotal) { $Accent } else { $cInk }
                $wt  = if ($isTotal) { '700' } else { '400' }
                $cells += "<td bgcolor='$bg' style='background-color:$bg;padding:6px 10px;" +
                          "border:1px solid $cLine;$bb $div'>" +
                          (P -Text (HE $r.$c) -Color $col -Weight $wt) + "</td>"
            }
            else {
                $v = 0
                [void][int]::TryParse([string]$r.$c, [ref]$v)
                $alarm = ($Emphasis -contains $c)
                $col = if ($v -eq 0) { $cOff } elseif ($alarm) { $cHot } else { $cInk }
                $wt  = if ($isTotal -or ($v -ne 0 -and $alarm)) { '700' } else { '400' }
                $cells += "<td bgcolor='$bg' style='background-color:$bg;padding:6px 10px;" +
                          "border:1px solid $cLine;$bb $div'>" +
                          (P -Text (HE $r.$c) -Color $col -Weight $wt -Align 'right') + "</td>"
            }
        }
        $body += "<tr>$cells</tr>"
        if (-not $isTotal) { $n++ }
    }
    "<table border='0' cellpadding='0' cellspacing='0' width='100%' style='width:100%;border-collapse:collapse;'>" +
    "<tr>$head</tr>$body</table>"
}

function New-CvsReportSectionHtml {
    param([string]$Title, [string]$Anchor, [string]$Legend, [string]$TableHtml, [string]$Accent)
    if (-not $TableHtml) { return '' }
    $rows = ''
    if ($Anchor) { $rows += "<tr><td style='font-size:1px;line-height:1px;padding:0;'><a id='$Anchor' name='$Anchor'></a></td></tr>" }
    $rows += "<tr><td bgcolor='$Accent' style='background-color:$Accent;padding:8px 12px;border:1px solid $Accent;'>" +
             (P -Text $Title -Size '11pt' -Color '#ffffff' -Weight '700' -Extra 'letter-spacing:.4px;') + "</td></tr>"
    if ($Legend) {
        $rows += "<tr><td bgcolor='#f8fafc' style='background-color:#f8fafc;padding:8px 12px;" +
                 "border-left:3px solid $Accent;border-right:1px solid $cLine;border-bottom:1px solid $cLine;'>" +
                 "<p style='margin:0;padding:0;$fnt'><span style='font-size:8.5pt;color:#4b5563;$fnt'>$Legend</span></p></td></tr>"
    }
    $rows += "<tr><td style='padding:0;'>$TableHtml</td></tr>"
    $rows += "<tr><td height='20' style='height:15pt;font-size:1px;line-height:1px;padding:0;'>&nbsp;</td></tr>"
    $rows
}

function New-CvsSummaryStrip {
    param($Cards)
    $cells = @()
    foreach ($c in $Cards) {
        $num = if ($c.Anchor) {
            "<p style='margin:0;padding:0;text-align:center;$fnt'><a href='#$($c.Anchor)' style='text-decoration:none;'>" +
            "<span style='font-size:20pt;font-weight:700;color:#ffffff;$fnt'>$($c.Value)</span></a></p>"
        } else { P -Text $c.Value -Size '20pt' -Color '#ffffff' -Weight '700' -Align 'center' }
        $lab = if ($c.Anchor) {
            "<p style='margin:0;padding:0;text-align:center;$fnt'><a href='#$($c.Anchor)' style='text-decoration:none;'>" +
            "<span style='font-size:8pt;font-weight:600;color:#e5e7eb;letter-spacing:.8px;$fnt'>$($c.Label.ToUpper())</span></a></p>"
        } else { P -Text $c.Label.ToUpper() -Size '8pt' -Color '#e5e7eb' -Weight '600' -Align 'center' }
        $cells += "<td width='24%' align='center' valign='middle' bgcolor='$($c.Color)' " +
                  "style='background-color:$($c.Color);border:1px solid $($c.Color);padding:10px 6px;'>$num$lab</td>"
    }
    $sp = "<td width='9' style='width:7pt;font-size:1px;line-height:1px;padding:0;'>&nbsp;</td>"
    "<table border='0' cellpadding='0' cellspacing='0' width='100%' style='width:100%;border-collapse:collapse;'>" +
    "<tr>" + ($cells -join $sp) + "</tr></table>"
}

function New-EmailBody {
    param($R, [string]$AreaKey, [bool]$WithFiles)

    $expAll  = $R.ExpRpt     | Where-Object { $_.vCenter -eq 'ALL' }
    $invAll  = $R.InvalidRpt | Where-Object { $_.vCenter -eq 'ALL' }
    $failAll = $R.FailedRpt  | Where-Object { $_.vCenter -eq 'ALL' }

    $tExpired  = if ($expAll)  { [int]$expAll.Expired }  else { 0 }
    $tExpiring = if ($expAll)  { [int]$expAll.Expiring } else { 0 }
    $tInvalid  = if ($invAll)  { [int]$invAll.Invalid }  else { 0 }
    $tFailed   = if ($failAll) { [int]$failAll.Devices } else { 0 }

    $cards = @(
        @{ Label = 'Unreachable'; Value = $tFailed;   Anchor = 'sec-failed'
           Color = $(if ($tFailed   -gt 0) { $accFail } else { $cDim }) }
        @{ Label = 'Invalid';     Value = $tInvalid;  Anchor = 'sec-invalid'
           Color = $(if ($tInvalid  -gt 0) { $accInv }  else { $cDim }) }
        @{ Label = 'Expiring';    Value = $tExpiring; Anchor = 'sec-expiring'
           Color = $(if ($tExpiring -gt 0) { '#a16207ff' } else { $cDim }) }
        @{ Label = 'Expired';     Value = $tExpired;  Anchor = 'sec-expiring'
           Color = $(if ($tExpired  -gt 0) { $accExp }  else { $cDim }) }
    )

    $sectionRows = ''
    if ($R.Failed) {
        $sectionRows += New-CvsReportSectionHtml -Title 'Failed Connection' -Anchor 'sec-failed' -Accent $accFail `
            -Legend ("<b style='color: '#000000';'>ICMP Failure:</b> <i>connection failure/timeout while obtaining the IP Address</i><br>" +
                     "<b style='color: '#000000';'>WebRequest Failure:</b> <i>failure to establish connection to the URL for SSL query</i>") `
            -TableHtml (Format-CvsTableHtml -Rows $R.FailedRpt -Accent $accFail `
                        -Columns 'vCenter','Devices','ICMP','WebRequest' -Emphasis 'ICMP','WebRequest')
    }
    if ($R.Invalid) {
        $sectionRows += New-CvsReportSectionHtml -Title 'Invalid Certificates' -Anchor 'sec-invalid' -Accent $accInv `
            -Legend "<b style='color: '#000000';'>Invalid:</b> <i>Certificate is not equal to DoS Standard, most likely VMware Default</i>" `
            -TableHtml (Format-CvsTableHtml -Rows $R.InvalidRpt -Accent $accInv `
                        -Columns 'vCenter','Devices','Valid','Invalid' -Emphasis 'Invalid')
    }
    if ($R.ExpRpt) {
        $sectionRows += New-CvsReportSectionHtml -Title 'Expired/Expiring Certificates' -Anchor 'sec-expiring' -Accent $accExp `
            -Legend "<b style='color: '#000000';'>Expiration:</b> <i>Certificate Expired or Set to Expire within the next year</i>" `
            -TableHtml (Format-CvsTableHtml -Rows $R.ExpRpt -Accent $accExp -DividerBefore '1mon' `
                        -Columns 'vCenter','Devices','Expired','Expiring','1mon','3mon','6mon','1yr' `
                        -Emphasis 'Expired','Expiring')
    }

    $noIssues = ''
    if (-not $R.Failed -and -not $R.Invalid -and $tExpiring -eq 0 -and $tExpired -eq 0) {
        $noIssues = "<tr><td bgcolor='#15803d' style='background-color:#15803d;padding:9px 12px;border:1px solid #15803d;'>" +
                    (P -Text 'No Issues Identified' -Size '11pt' -Color '#ffffff' -Weight '700') + "</td></tr>" +
                    "<tr><td height='20' style='height:15pt;font-size:1px;line-height:1px;padding:0;'>&nbsp;</td></tr>"
    }

    $filesList  = ($distros[$AreaKey].FilesList) -join ', '
    $attachNote = if ($WithFiles) {
        "Attached: $AreaKey-ssl-all.csv &middot; $AreaKey-ssl_failed.csv &middot; $AreaKey-ssl_invalid.csv &middot; $AreaKey-ssl_exp.csv"
    } else {
        "Detailed Reports Sent To: $(HE $filesList)"
    }
    $subLine = "$($AreaKey.ToUpper()) &middot; $env:COMPUTERNAME &middot; $(Get-Date -Format 'dddd, MMMM d yyyy  HH:mm')"
    $footLink = "Detailed Reports On PowerBi: <a href='$pbiUrl' style='color:$accFail;font-weight:700;'>VMware_SSL_Report</a>"

    $bodyRows =
        "<tr><td bgcolor='$cBan' style='background-color:$cBan;padding:14px 16px;'>" +
        (P -Text 'SSL Issues Report' -Size '15pt' -Color '#ffffff' -Weight '700' -Extra 'letter-spacing:.4px;') +
        (P -Text $subLine -Size '8.5pt' -Color '#94a3b8') + "</td></tr>" +
        "<tr><td height='18' style='height:13pt;font-size:1px;line-height:1px;padding:0;'>&nbsp;</td></tr>" +
        "<tr><td style='padding:0;'>$(New-CvsSummaryStrip -Cards $cards)</td></tr>" +
        "<tr><td height='20' style='height:15pt;font-size:1px;line-height:1px;padding:0;'>&nbsp;</td></tr>" +
        $noIssues + $sectionRows +
        "<tr><td style='padding:10px 0 0 0;border-top:1px solid $cLine;'>" +
        "<p style='margin:0;padding:0;$fnt'><span style='font-size:8.5pt;color:$cMute;$fnt'>$footLink</span></p>" +
        "<p style='margin:4px 0 0 0;padding:0;$fnt'><span style='font-size:8.5pt;color:$cMute;$fnt'>$attachNote</span></p>" +
        "<p style='margin:4px 0 0 0;padding:0;$fnt'><span style='font-size:8pt;color:#9ca3af;$fnt'>$(@($R.Data).Count) devices checked &middot; $(@($R.Open).Count) responded</span></p>" +
        "</td></tr>"

    "<html><head><meta http-equiv='Content-Type' content='text/html; charset=utf-8'></head>" +
    "<body style='margin:0;padding:0;background-color:#ffffff;'>" +
    "<div style='display:none;font-size:1px;color:#ffffff;max-height:0;overflow:hidden;'>" +
    "$tExpired expired / $tExpiring expiring / $tInvalid invalid / $tFailed unreachable</div>" +
    "<table border='0' cellpadding='0' cellspacing='0' width='940' style='width:705pt;border-collapse:collapse;'>" +
    $bodyRows + "</table></body></html>"
}



$ErrorActionPreference = 'Stop'
$ConfirmPreference     = 'None'
$ProgressPreference    = 'SilentlyContinue'
$runStart = Get-Date
Add-Type -AssemblyName System.Web

if ($transcriptPath) { Start-Transcript -Path $transcriptPath -Force | Out-Null }
function Log { param([string]$Msg) Write-Host ("{0:HH:mm:ss}  {1}" -f (Get-Date), $Msg) }

[Net.ServicePointManager]::DefaultConnectionLimit = 1024
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
[Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }

$legacyProps = 'Area', 'Type', 'vCenter', 'Device', 'IP_Address', 'Status', 'Issuer', 'Exp_Date', 'Exp_Days'
$fullProps   = $legacyProps + @('Issuer_Valid', 'Component', 'Subject', 'Thumbprint', 'Error')
$outProps    = if ($legacyColumns) { $legacyProps } else { $fullProps }

if ($renderSample) {
    $sampleR = [pscustomobject]@{
        Data   = 1..358 | ForEach-Object { [pscustomobject]@{ x = $_ } }
        Open   = 1..356 | ForEach-Object { [pscustomobject]@{ x = $_ } }
        Failed = 1..5   | ForEach-Object { [pscustomobject]@{ x = $_ } }
        Invalid= 1..3   | ForEach-Object { [pscustomobject]@{ x = $_ } }
        Expiring = @()
        FailedRpt = @(
            [pscustomobject]@{ vCenter='ALL';       Devices=5; ICMP=5; WebRequest=2 }
            [pscustomobject]@{ vCenter='EURVC60';   Devices=2; ICMP=2; WebRequest=0 }
            [pscustomobject]@{ vCenter='NEASAVC60'; Devices=1; ICMP=1; WebRequest=0 }
            [pscustomobject]@{ vCenter='WHAVC60';   Devices=2; ICMP=2; WebRequest=2 })
        InvalidRpt = @(
            [pscustomobject]@{ vCenter='ALL';          Devices=356; Valid=353; Invalid=3 }
            [pscustomobject]@{ vCenter='EAPVC60';      Devices=118; Valid=118; Invalid=0 }
            [pscustomobject]@{ vCenter='ESOCO26VCS01'; Devices=6;   Valid=6;   Invalid=0 }
            [pscustomobject]@{ vCenter='EURVC60';      Devices=142; Valid=142; Invalid=0 }
            [pscustomobject]@{ vCenter='GITMVC651ST';  Devices=4;   Valid=1;   Invalid=3 }
            [pscustomobject]@{ vCenter='NEASAVC60';    Devices=70;  Valid=70;  Invalid=0 }
            [pscustomobject]@{ vCenter='WHAVC60';      Devices=16;  Valid=16;  Invalid=0 })
        ExpRpt = @(
            'ALL','EAPVC60','ESOCO26VCS01','EURVC60','GITMVC651ST','NEASAVC60','WHAVC60' |
            ForEach-Object {
                $d = switch ($_) { 'ALL'{356} 'EAPVC60'{118} 'ESOCO26VCS01'{6} 'EURVC60'{142}
                                   'GITMVC651ST'{4} 'NEASAVC60'{70} 'WHAVC60'{16} }
                [pscustomobject]@{ vCenter=$_; Devices=$d; Expired=0; Expiring=0
                                   '1mon'=0; '3mon'=0; '6mon'=0; '1yr'=0 }
            })
    }
    $html = New-EmailBody -R $sampleR -AreaKey 'oconus' -WithFiles $false
    Set-Content -Path $renderSample -Value $html -Encoding UTF8
    Write-Host "wrote $renderSample"
    if ($smtpServer -and $reportRecipient) {
        Send-MailMessage -SmtpServer $smtpServer -From "$env:user7@dom3.example" `
                         -To $reportRecipient -Subject 'SSL Report - FORMAT PREVIEW' `
                         -Body $html -BodyAsHtml
        Write-Host "sent preview to $reportRecipient"
    }
    exit 0
}

$targets = New-Object System.Collections.ArrayList

function New-Target {
    param([string]$Area, [string]$Type, [string]$VCenter, [string]$Device,
          [string]$Component = '', [int]$Port = 443)
    [pscustomobject]@{
        Area = $Area; Type = $Type; vCenter = $VCenter; Device = $Device
        IP_Address = ''; Status = ''; Issuer = ''; Exp_Date = ''; Exp_Days = $null
        Issuer_Valid = ''; Component = $Component; Subject = ''; Thumbprint = ''
        Port = $Port; Error = ''
    }
}

function Get-ShortVc { param([string]$Fqdn) if ($Fqdn) { ($Fqdn -split '\.')[0].ToUpper() } else { '' } }

function Get-IssuerCn {
    param([string]$IssuerDn)
    if (-not $IssuerDn) { return '' }
    $first = ($IssuerDn -split ',')[0]
    if ($first -match '=') { ($first -split '=', 2)[1].Trim() } else { $first.Trim() }
}

function Test-TargetIp {
    param([string]$TargetHost)
    if ($skipIcmp) { return 'SKIPPED' }
    try {
        if (Test-Connection -ComputerName $TargetHost -Count 1 -Quiet -ErrorAction SilentlyContinue) {
            $p = Get-CimInstance Win32_PingStatus -Filter "Address='$TargetHost' and Timeout=5000" -ErrorAction SilentlyContinue
            if ($p.IPV4Address) { return $p.IPV4Address.IPAddressToString }
        }
    } catch { }
    '0.0.0.0'
}

function Invoke-SslCheck {
    param($Record)

    try { [void][Net.Dns]::GetHostEntry($Record.Device) }
    catch {
        $Record.Status = 'Closed'
        $Record.Error  = "DNS resolution failed: $($_.Exception.Message)"
        return
    }

    $uri = 'https://{0}{1}' -f $Record.Device, $(if ($Record.Port -ne 443) { ":$($Record.Port)" } else { '' })
    $req = [Net.WebRequest]::Create($uri)
    $req.Timeout          = $webTimeoutSec * 1000
    $req.ReadWriteTimeout = $webTimeoutSec * 1000
    $req.AllowAutoRedirect = $true
    $resp = $null
    try {
        $resp = $req.GetResponse()
        $cert = $req.ServicePoint.Certificate
        if (-not $cert) { throw 'no certificate presented' }
        $Record.Status     = 'Open'
        $Record.Issuer     = Get-IssuerCn $cert.Issuer
        $Record.Subject    = $cert.Subject
        $Record.Thumbprint = $cert.GetCertHashString()
        $exp               = [datetime]$cert.GetExpirationDateString()
        $Record.Exp_Date   = $exp.ToString('MM/dd/yyyy')
        $Record.Exp_Days   = (New-TimeSpan -Start (Get-Date) -End $exp).Days
    }
    catch {
        $Record.Status = 'Closed'
        $Record.Error  = $_.Exception.Message
        if ($_.Exception.Response) { try { $_.Exception.Response.Close() } catch { } }
    }
    finally { if ($resp) { $resp.Close() } }
}

function Set-CertFromX509 {
    param($Record, [System.Security.Cryptography.X509Certificates.X509Certificate2]$Cert)
    $Record.Status     = 'Open'
    $Record.Issuer     = Get-IssuerCn $Cert.Issuer
    $Record.Subject    = $Cert.Subject
    $Record.Thumbprint = $Cert.Thumbprint
    $Record.Exp_Date   = $Cert.NotAfter.ToString('MM/dd/yyyy')
    $Record.Exp_Days   = (New-TimeSpan -Start (Get-Date) -End $Cert.NotAfter).Days
}

function ConvertFrom-Pem {
    param([string]$Pem)
    $b64 = ($Pem -replace '-----(BEGIN|END) CERTIFICATE-----', '') -replace '\s', ''
    if (-not $b64) { return $null }
    New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 (, [Convert]::FromBase64String($b64))
}

function Connect-VcRest {
    param([string]$Server, [string]$User, [string]$Pass)
    $auth = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("${User}:${Pass}"))
    $r = Invoke-RestMethod -Method Post -Uri "https://$Server/api/session" -Headers @{ Authorization = "Basic $auth" }
    @{ Server = $Server; Headers = @{ 'vmware-api-session-id' = $r } }
}

function Invoke-VcRest {
    param($Session, [string]$Path)
    Invoke-RestMethod -Method Get -Uri "https://$($Session.Server)$Path" -Headers $Session.Headers
}

# ------------------------------------------------------- Phase 1: target list
Log "[phase 1] building target list"

$active = $vCenterList | Where-Object { $_.Active }
if ($collectArea -ne 'ALL') { $active = $active | Where-Object { $_.Area -eq $collectArea } }
if ($onlyVc) { $active = $active | Where-Object { $_.FQDN -like "*$onlyVc*" -or $_.Name -like "*$onlyVc*" } }
if (-not $active) { throw "No active vCenters match area '$collectArea' / onlyVc '$onlyVc'." }

Log 'importing PowerCLI'
if (-not (Get-Module VMware.VimAutomation.Core)) { Import-Module VMware.VimAutomation.Core }

foreach ($scope in 'User', 'Session') {
    try {
        Set-PowerCLIConfiguration -InvalidCertificateAction Ignore -ParticipateInCEIP $false `
                                  -DisplayDeprecationWarnings $false -Confirm:$false -Scope $scope | Out-Null
    }
    catch { Write-Warning "Set-PowerCLIConfiguration -Scope $scope failed: $($_.Exception.Message)" }
}

$vcUser = $env:VC_USER
$vcPass = $env:VC_PASS
if (-not $vcUser -or -not $vcPass) {
    throw 'VC_USER / VC_PASS not present in the environment. Connect-VIServer would prompt and hang in a non-interactive session.'
}
$cred = New-Object System.Management.Automation.PSCredential ($vcUser, (ConvertTo-SecureString $vcPass -AsPlainText -Force))

foreach ($vcEntry in $active) {
    $vcFqdn = $vcEntry.FQDN
    Log "  -> $vcFqdn"
    if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$false }
    try {
        if ($cred) { Connect-VIServer -Server $vcFqdn -Credential $cred -WarningAction 0 -ErrorAction Stop | Out-Null }
        else       { Connect-VIServer -Server $vcFqdn -WarningAction 0 -ErrorAction Stop | Out-Null }
    }
    catch {
        $t = New-Target -Area $vcEntry.Area -Type 'vCenter' -VCenter $vcFqdn -Device $vcFqdn -Component 'vCenter connect'
        $t.Status = 'Closed'; $t.IP_Address = '0.0.0.0'; $t.Error = $_.Exception.Message
        [void]$targets.Add($t); continue
    }

    $vmNames = @{}
    foreach ($n in (Get-VM -ErrorAction SilentlyContinue).Name) { $vmNames[$n] = $true }
    foreach ($entry in $vCenterList) {
        if ($vmNames.ContainsKey($entry.Name)) {
            [void]$targets.Add((New-Target -Area $entry.Area -Type 'vCenter' -VCenter $vcFqdn `
                                -Device $entry.FQDN -Component 'vCenter machine SSL'))
        }
    }

    $hosts = @(Get-VMHost -ErrorAction SilentlyContinue | Sort-Object Name)
    Log "     $($hosts.Count) ESXi hosts"
    foreach ($vmh in $hosts) {
        [void]$targets.Add((New-Target -Area $vcEntry.Area -Type 'Host' -VCenter $vcFqdn `
                            -Device $vmh.Name -Component 'ESXi host cert'))
    }

    if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$false }
}

foreach ($vcEntry in $active) {
    if (-not ($targets | Where-Object { $_.Device -eq $vcEntry.FQDN })) {
        [void]$targets.Add((New-Target -Area $vcEntry.Area -Type 'vCenter' -VCenter $vcEntry.FQDN `
                            -Device $vcEntry.FQDN -Component 'vCenter machine SSL'))
    }
}

foreach ($ep in ($extraEndpoints -split ',' | Where-Object { $_ } | ForEach-Object { $_.Trim() })) {
    $parts  = $ep -split ':'
    $epPort = if ($parts.Count -gt 1) { [int]$parts[1] } else { 443 }
    $epArea = if ($collectArea -eq 'ALL') { 'CONUS' } else { $collectArea }
    [void]$targets.Add((New-Target -Area $epArea -Type 'Endpoint' -VCenter 'OTHER' `
                        -Device $parts[0] -Component "TLS endpoint :$epPort" -Port $epPort))
}

Log "[phase 2] probing $($targets.Count) targets"

$ipCache = @{}
$i = 0
foreach ($t in $targets) {
    if (-not $ipCache.ContainsKey($t.Device)) { $ipCache[$t.Device] = Test-TargetIp -TargetHost $t.Device }
    $t.IP_Address = $ipCache[$t.Device]
    $i++
    if ($progressEvery -gt 0 -and $i % $progressEvery -eq 0) { Log "  icmp $i/$($targets.Count)" }
}
Log "  icmp complete: $(@($ipCache.Values | Where-Object { $_ -eq '0.0.0.0' }).Count) unreachable"

$sslCache = @{}
$i = 0
foreach ($t in $targets) {
    $i++
    if ($progressEvery -gt 0 -and $i % $progressEvery -eq 0) { Log "  ssl $i/$($targets.Count)" }

    if ($skipUnreachable -and $t.IP_Address -eq '0.0.0.0') {
        $t.Status = 'Closed'
        $t.Error  = 'skipped, ICMP unreachable'
        continue
    }

    $key = "$($t.Device):$($t.Port)"
    if ($sslCache.ContainsKey($key)) {
        $c = $sslCache[$key]
        $t.Status = $c.Status; $t.Issuer = $c.Issuer; $t.Subject = $c.Subject
        $t.Thumbprint = $c.Thumbprint; $t.Exp_Date = $c.Exp_Date; $t.Exp_Days = $c.Exp_Days
        $t.Error = $c.Error
        continue
    }
    Invoke-SslCheck -Record $t
    $sslCache[$key] = $t.PSObject.Copy()
}

if (($includeSts -or $includeTrustedRoots -or $includeVecs) -and -not $cred) {
    Write-Warning 'VC_USER/VC_PASS not set - skipping internal store collection.'
}
elseif ($includeSts -or $includeTrustedRoots -or $includeVecs) {
    foreach ($vcEntry in $active) {
        $vcFqdn = $vcEntry.FQDN
        try { $sess = Connect-VcRest -Server $vcFqdn -User $vcUser -Pass $vcPass }
        catch {
            $t = New-Target -Area $vcEntry.Area -Type 'vCenter' -VCenter $vcFqdn -Device $vcFqdn -Component 'REST session'
            $t.Status = 'Closed'; $t.Error = $_.Exception.Message; [void]$targets.Add($t); continue
        }

        if ($includeSts) {
            try {
                $s = Invoke-VcRest $sess '/api/vcenter/certificate-management/vcenter/signing-certificate'
                $i = 0
                foreach ($pem in @($s.active_cert_chain.cert_chain)) {
                    $t = New-Target -Area $vcEntry.Area -Type 'STS' -VCenter $vcFqdn -Device $vcFqdn -Component "STS signing (active[$i])"
                    Set-CertFromX509 -Record $t -Cert (ConvertFrom-Pem $pem); [void]$targets.Add($t); $i++
                }
            }
            catch {
                $t = New-Target -Area $vcEntry.Area -Type 'STS' -VCenter $vcFqdn -Device $vcFqdn -Component 'STS signing'
                $t.Status = 'Closed'; $t.Error = $_.Exception.Message; [void]$targets.Add($t)
            }
        }

        if ($includeTrustedRoots) {
            try {
                foreach ($id in @(Invoke-VcRest $sess '/api/vcenter/certificate-management/vcenter/trusted-root-chains')) {
                    $key   = if ($id.chain) { $id.chain } else { $id }
                    $chain = Invoke-VcRest $sess "/api/vcenter/certificate-management/vcenter/trusted-root-chains/$key"
                    foreach ($pem in @($chain.cert_chain.cert_chain)) {
                        $t = New-Target -Area $vcEntry.Area -Type 'TrustedRoot' -VCenter $vcFqdn -Device $vcFqdn -Component "Trusted root ($key)"
                        Set-CertFromX509 -Record $t -Cert (ConvertFrom-Pem $pem); [void]$targets.Add($t)
                    }
                }
            }
            catch {
                $t = New-Target -Area $vcEntry.Area -Type 'TrustedRoot' -VCenter $vcFqdn -Device $vcFqdn -Component 'Trusted roots'
                $t.Status = 'Closed'; $t.Error = $_.Exception.Message; [void]$targets.Add($t)
            }
        }

        if ($includeVecs -and $env:VC_ROOT_PASS) {
            foreach ($store in 'machine', 'vpxd', 'vpxd-extension', 'vsphere-webclient', 'data-encipherment') {
                $cmd = "/usr/lib/vmware-vmafd/bin/vecs-cli entry list --store $store --text | grep -E 'Alias|Not After'"
                $out = & $plinkPath -batch -ssh -l root -pw $env:VC_ROOT_PASS $vcFqdn $cmd 2>&1
                if ($LASTEXITCODE -ne 0) {
                    $t = New-Target -Area $vcEntry.Area -Type 'VECS' -VCenter $vcFqdn -Device $vcFqdn -Component "VECS/$store"
                    $t.Status = 'Closed'; $t.Error = ($out -join ' '); [void]$targets.Add($t); continue
                }
                $alias = $null
                foreach ($line in $out) {
                    if ($line -match 'Alias\s*:\s*(.+)$') { $alias = $Matches[1].Trim() }
                    elseif ($line -match 'Not After\s*:\s*(.+)$' -and $alias) {
                        $t = New-Target -Area $vcEntry.Area -Type 'VECS' -VCenter $vcFqdn -Device $vcFqdn -Component "VECS/$store ($alias)"
                        $exp = [datetime]::Parse($Matches[1].Trim())
                        $t.Status = 'Open'; $t.Issuer = '(vecs-cli)'; $t.Subject = $alias
                        $t.Exp_Date = $exp.ToString('MM/dd/yyyy')
                        $t.Exp_Days = (New-TimeSpan -Start (Get-Date) -End $exp).Days
                        [void]$targets.Add($t); $alias = $null
                    }
                }
            }
        }
    }
}

Log "[phase 3] classifying and writing files"

foreach ($t in $targets) {
    $t.Issuer_Valid = if ($t.Status -ne 'Open') { '' }
                      elseif ($caSigned -contains $t.Issuer) { 'Valid' }
                      else { 'Invalid' }
}

$allData = $targets | Select-Object $outProps
$allData | Export-Csv (Join-Path $csvPath 'ssl-all.csv') -NoTypeInformation

if (-not (Test-Path $archivePath)) { New-Item -ItemType Directory -Path $archivePath -Force | Out-Null }

function Get-FailedRpt {
    param($Failed)
    $icmp = $Failed | Where-Object { $_.IP_Address -eq '0.0.0.0' }
    $web  = $Failed | Where-Object { $_.Status -eq 'Closed' }
    $rows = @([pscustomobject]@{ vCenter = 'ALL'; Devices = @($Failed).Count
                                 ICMP = @($icmp).Count; WebRequest = @($web).Count })
    foreach ($vc in ($Failed.vCenter | Select-Object -Unique | Sort-Object)) {
        $rows += [pscustomobject]@{
            vCenter    = Get-ShortVc $vc
            Devices    = @($Failed | Where-Object { $_.vCenter -eq $vc }).Count
            ICMP       = @($icmp   | Where-Object { $_.vCenter -eq $vc }).Count
            WebRequest = @($web    | Where-Object { $_.vCenter -eq $vc }).Count
        }
    }
    $rows
}

function Get-InvalidRpt {
    param($Open)
    $inv = $Open | Where-Object { $_.Issuer_Valid -eq 'Invalid' }
    $val = $Open | Where-Object { $_.Issuer_Valid -eq 'Valid' }
    $rows = @([pscustomobject]@{ vCenter = 'ALL'; Devices = @($Open).Count
                                 Valid = @($val).Count; Invalid = @($inv).Count })
    foreach ($vc in ($Open.vCenter | Select-Object -Unique | Sort-Object)) {
        $rows += [pscustomobject]@{
            vCenter = Get-ShortVc $vc
            Devices = @($Open | Where-Object { $_.vCenter -eq $vc }).Count
            Valid   = @($val  | Where-Object { $_.vCenter -eq $vc }).Count
            Invalid = @($inv  | Where-Object { $_.vCenter -eq $vc }).Count
        }
    }
    $rows
}

function Get-ExpRpt {
    param($Open)
    $lo1      = if ($exclusiveBands) { $bandPast } else { -999999 }
    $withDays = @($Open | Where-Object { $null -ne $_.Exp_Days -and $_.Exp_Days -ne '' })

    $scopes = @([pscustomobject]@{ Label = 'ALL'; Vc = $null })
    foreach ($vc in ($Open.vCenter | Select-Object -Unique | Sort-Object)) {
        $scopes += [pscustomobject]@{ Label = (Get-ShortVc $vc); Vc = $vc }
    }

    $rows = @()
    foreach ($s in $scopes) {
        $all = if ($null -eq $s.Vc) { @($Open) }  else { @($Open     | Where-Object { $_.vCenter -eq $s.Vc }) }
        $set = if ($null -eq $s.Vc) { $withDays } else { @($withDays | Where-Object { $_.vCenter -eq $s.Vc }) }
        $rows += [pscustomobject]@{
            vCenter  = $s.Label
            Devices  = $all.Count
            Expired  = @($set | Where-Object { [int]$_.Exp_Days -le $bandPast }).Count
            Expiring = @($set | Where-Object { [int]$_.Exp_Days -le $bandYear }).Count
            '1mon'   = @($set | Where-Object { [int]$_.Exp_Days -gt $lo1      -and [int]$_.Exp_Days -le $band1mon }).Count
            '3mon'   = @($set | Where-Object { [int]$_.Exp_Days -gt $band1mon -and [int]$_.Exp_Days -le $band3mon }).Count
            '6mon'   = @($set | Where-Object { [int]$_.Exp_Days -gt $band3mon -and [int]$_.Exp_Days -le $band6mon }).Count
            '1yr'    = @($set | Where-Object { [int]$_.Exp_Days -gt $band6mon -and [int]$_.Exp_Days -le $bandYear }).Count
        }
    }
    $rows
}

function Export-Report {
    param($Rows, [string]$Path, [string[]]$Columns)
    if ($Rows) {
        $Rows | Select-Object $Columns | Export-Csv -Path $Path -NoTypeInformation
    }
    else {
        ('"' + ($Columns -join '","') + '"') | Set-Content -Path $Path -Encoding UTF8
    }
}

function Write-AreaFiles {
    param([string]$RptArea, $Data)

    $failed = $Data | Where-Object { $_.IP_Address -eq '0.0.0.0' -or $_.Status -eq 'Closed' }
    $open   = $Data | Where-Object { $_.Status -eq 'Open' }
    $inv    = $open | Where-Object { $_.Issuer_Valid -eq 'Invalid' }
    $exp    = $open | Where-Object { $null -ne $_.Exp_Days -and $_.Exp_Days -ne '' -and [int]$_.Exp_Days -le $bandYear } |
              Sort-Object { [int]$_.Exp_Days }

    $failedRpt  = if ($failed) { Get-FailedRpt  -Failed $failed } else { @() }
    $invalidRpt = if ($open)   { Get-InvalidRpt -Open   $open }   else { @() }
    $expRpt     = if ($open)   { Get-ExpRpt     -Open   $open }   else { @() }

    Get-ChildItem -Path $csvPath -Filter "$RptArea-ssl*.csv" -ErrorAction SilentlyContinue |
        Move-Item -Destination $archivePath -Force -ErrorAction SilentlyContinue

    if ($RptArea -ne 'combined') {
        Export-Report -Rows $Data -Columns $outProps -Path (Join-Path $csvPath "$RptArea-ssl-all.csv")
    }
    Export-Report -Rows $failed     -Columns $outProps -Path (Join-Path $csvPath "$RptArea-ssl_failed.csv")
    Export-Report -Rows $inv        -Columns $outProps -Path (Join-Path $csvPath "$RptArea-ssl_invalid.csv")
    Export-Report -Rows $exp        -Columns $outProps -Path (Join-Path $csvPath "$RptArea-ssl_exp.csv")
    Export-Report -Rows $failedRpt  -Columns 'vCenter','Devices','ICMP','WebRequest' `
                  -Path (Join-Path $csvPath "$RptArea-ssl_failed_rpt.csv")
    Export-Report -Rows $invalidRpt -Columns 'vCenter','Devices','Valid','Invalid' `
                  -Path (Join-Path $csvPath "$RptArea-ssl_invalid_rpt.csv")
    Export-Report -Rows $expRpt     -Columns 'vCenter','Devices','Expired','Expiring','1mon','3mon','6mon','1yr' `
                  -Path (Join-Path $csvPath "$RptArea-ssl_exp_rpt.csv")

    [pscustomobject]@{
        Area = $RptArea; Data = $Data; Failed = $failed; Open = $open; Invalid = $inv; Expiring = $exp
        FailedRpt = $failedRpt; InvalidRpt = $invalidRpt; ExpRpt = $expRpt
    }
}

$areaResults = @{}
foreach ($rptArea in $reportAreas) {
    $subset = if ($rptArea -eq 'combined') { $allData }
              else { $allData | Where-Object { $_.Area -eq $rptArea.ToUpper() } }
    if (-not $subset) { Write-Host "  no data for $rptArea"; continue }
    $areaResults[$rptArea] = Write-AreaFiles -RptArea $rptArea -Data $subset
    Write-Host "  $rptArea : $(@($subset).Count) rows"
}

# ------------------------------------------------------ Phase 4: email
function HE { param($s) [System.Web.HttpUtility]::HtmlEncode([string]$s) }

if (-not $noEmail -and $emailSend) {
    foreach ($areaKey in $emailAreas) {
        if (-not $areaResults.ContainsKey($areaKey)) { continue }
        $R = $areaResults[$areaKey]
        foreach ($withFiles in @($false, $true)) {
            $dist = if ($withFiles) { $distros[$areaKey].Files } else { $distros[$areaKey].Summary }
            $subj = if ($withFiles) { "$($areaKey.ToUpper()) SSL Report VMware & Files [$env:COMPUTERNAME]" }
                    else            { "$($areaKey.ToUpper()) SSL Report VMware [$env:COMPUTERNAME]" }
            $mail = @{
                SmtpServer = $smtpServer
                From       = $mailFrom
                To         = if ($testing) { $testingTo } else { $dist.To }
                Subject    = $subj
                Body       = New-EmailBody -R $R -AreaKey $areaKey -WithFiles $withFiles
                BodyAsHtml = $true
            }
            if (-not $testing -and $dist.Cc) { $mail.Cc = $dist.Cc }
            if ($withFiles) {
                $attach = @("$areaKey-ssl-all.csv", "$areaKey-ssl_failed.csv",
                            "$areaKey-ssl_invalid.csv", "$areaKey-ssl_exp.csv") |
                          ForEach-Object { Join-Path $csvPath $_ } | Where-Object { Test-Path $_ }
                if ($attach) { $mail.Attachments = $attach }
            }
            Send-MailMessage @mail
            Write-Host "  emailed $areaKey (files=$withFiles)"
        }
    }
}

if ($pbiPath -and (Test-Path $pbiPath)) {
    $srcFull = (Resolve-Path $csvPath).ProviderPath.TrimEnd('\')
    $dstFull = (Resolve-Path $pbiPath).ProviderPath.TrimEnd('\')
    if ($srcFull -eq $dstFull) {
        Write-Host "  pbiPath equals csvPath - skipping copy"
    }
    else {
        Copy-Item -Path (Join-Path $csvPath '*.csv') -Destination $pbiPath -Force
        Write-Host "  copied CSVs to Power BI share"
    }
}

$duration = '{0:hh\:mm\:ss}' -f ((Get-Date) - $runStart)
Log ("checks={0} runtime={1}" -f $allData.Count, $duration)
Write-Output ("checks={0} runtime={1}" -f $allData.Count, $duration)
if ($transcriptPath) { Stop-Transcript | Out-Null }
exit 0