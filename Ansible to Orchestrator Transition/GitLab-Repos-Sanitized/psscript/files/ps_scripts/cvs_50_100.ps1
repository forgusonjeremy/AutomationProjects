[CmdletBinding()]
param(
    [string]$Action,
    [string]$eMailReport = 'no',
    [string]$SMTPServer,
    [string]$MailToString,
    [string]$MailCcString,
    [string]$MailSubjectstring,
    [string]$vCenterList
)

# ---- Standalone framework shims  -------------
$DebugDir = Join-Path $PSScriptRoot 'debug'
if (-not (Test-Path $DebugDir)) { New-Item -ItemType Directory -Path $DebugDir -Force | Out-Null }
$LogFile = Join-Path $DebugDir 'cvs_50_100.log'

function Write-Log {
    param([string]$Message)
    $line = ('{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message)
    $line | Out-File -FilePath $LogFile -Append -Encoding utf8
    Write-Host $line
}

# ---- Email formatting helper (presentation only) ----------------------------
# Takes a raw "ConvertTo-Html -Fragment" table and injects inline styles so it
# renders cleanly in Outlook/Exchange. Inline styles + bgcolor attributes are
# used because Outlook (Word render engine) ignores most <style>-block CSS.
function Format-DsTableHtml {
    param(
        [string]$Fragment,
        [string]$Accent
    )

    # Empty tier: ConvertTo-Html on no rows yields a table with no <td>.
    if ([string]::IsNullOrWhiteSpace($Fragment) -or ($Fragment -notmatch '<td')) {
        return '<p style="margin:6px 0 20px;padding:10px 12px;background:#f9fafb;border:1px dashed #d1d5db;border-radius:4px;color:#6b7280;font-size:13px;font-family:Segoe UI,Arial,sans-serif;">None in this range.</p>'
    }

    $t = $Fragment

    # Table shell
    $t = $t -replace '<table>',
        '<table cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;width:100%;margin:6px 0 20px;font-family:Segoe UI,Arial,sans-serif;font-size:13px;">'

    # Header cells (bgcolor attr for Outlook + inline style for everything else)
    $t = $t -replace '<th>',
        ('<th align="left" bgcolor="' + $Accent + '" style="background:' + $Accent + ';color:#ffffff;text-align:left;padding:9px 11px;font-weight:600;font-size:12px;white-space:nowrap;border:1px solid ' + $Accent + ';">')

    # Body cells (default: left aligned)
    $t = $t -replace '<td>',
        '<td style="padding:7px 11px;border:1px solid #e5e7eb;color:#111827;background:#ffffff">'

    # Right-align cells whose content is purely numeric
    $t = $t -replace '(<td style="[^"]+?)(">)(\s*[\d.,]+\s*)(</td>)',
        '$1;text-align:right$2$3$4'

    # Zebra striping on data rows (rows immediately followed by a <td>)
    $script:__zebraRow = 0
    $t = [regex]::Replace($t, '<tr>(?=\s*<td)', {
        param($m)
        $script:__zebraRow++
        if ($script:__zebraRow % 2 -eq 0) { '<tr style="background:#f9fafb">' } else { '<tr>' }
    })

    return $t
}

$MailFrom = 'user5@dom3.example'   # <-- set to a valid sender for your relay
# -----------------------------------------------------------------------------

Write-Log "=== cvs_50_100 datastore report start (Action=$Action) ==="

# Measured Limits High/Low
$high = 90 # Only Modify This Value, the rest are calculated (don't go below 20)
$med = [int]$high - 10
$low = [int]$med - 10
$med_limit = [int]$high - .01
$low_limit = [int]$med - .01
[int]$dsPercentUsed = $low

Set-Variable BYTES_IN_GB -option Constant -value ([int32]1073741824) -Visibility Private
[array]$allDsData = @()

# Build credential from Ansible Vault values passed in as environment vars
if ([string]::IsNullOrEmpty($env:VC_USER) -or [string]::IsNullOrEmpty($env:VC_PASS)) {
    Write-Log "ERROR: VC_USER/VC_PASS not present in environment - vault creds not delivered by the task. Aborting."
    exit 1
}
$vcCred = [pscredential]::new(
    $env:VC_USER,
    (ConvertTo-SecureString $env:VC_PASS -AsPlainText -Force)
)
Write-Log "Credential built for user [$($vcCred.UserName)]."

Write-Log "Loading PowerCLI module..."
if (!(Get-Module VMware.VimAutomation.Core)) { Import-Module VMware.VimAutomation.Core }
Set-PowerCLIConfiguration -InvalidCertificateAction Ignore -Scope Session -Confirm:$false | Out-Null
Write-Log "PowerCLI ready."

if ($Global:DefaultVIServers.count -gt 0) { DisConnect-VIServer * -Force -Confirm:$False }

foreach ($vcenter in $vCenterList.split(",")) {
    $vcenter = $vcenter.trim()
    Write-Log "vCenter: $($vcenter)"

    # Preflight: fail fast if 443 is unreachable/dropped (prevents multi-hour socket hang)
    $tcp = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $tcp.BeginConnect($vcenter, 443, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne(5000)) {
            Write-Log "  $vcenter unreachable on 443 (5s timeout) - skipping"
            continue
        }
        $tcp.EndConnect($iar)
    } catch {
        Write-Log "  $vcenter TCP 443 test failed: $($_.Exception.Message) - skipping"
        continue
    } finally { $tcp.Close() }

    Write-Log "  Connecting to $vcenter..."
    Connect-VIServer -Server $vcenter -Credential $vcCred -Force -warningaction 0 -ErrorAction Stop | Out-Null
    Write-Log "  Connected. Gathering datastores..."
    [array]$datastores = $null
    [array]$datastores = Get-View -ViewType DataStore -Property Summary
    foreach ($ds in $datastores) {
        if ($ds.Summary.Capacity -le 0) { continue }
        [decimal]$percentUsed = ([Math]::Round((($ds.summary.capacity - $ds.summary.freespace) / $ds.summary.capacity) * 10000)) / 100
        [decimal]$percentFree = ([Math]::Round(($ds.summary.freespace / $ds.summary.capacity) * 10000)) / 100

        if (($percentUsed -gt $dsPercentUsed) -and ($ds.summary.uncommitted -gt $ds.summary.freespace)) {
            [pscustomobject]$dsProperties = [ordered]@{
                'Datastore'     = $ds.Summary.Name
                'vCenter'       = $vcenter | % { $_.Split('.')[0]; }
                'CapacityGB'    = ([Math]::Round($ds.summary.capacity / $BYTES_IN_GB))
                'UsedGB'        = ([Math]::Round(($ds.summary.capacity - $ds.summary.freespace) / $BYTES_IN_GB))
                'FreeSpaceGB'   = ([Math]::Round($ds.summary.freespace / $BYTES_IN_GB))
                'UncommittedGB' = ([Math]::Round($ds.summary.uncommitted / $BYTES_IN_GB))
                'PercentUsed'   = $percentUsed
                'PercentFree'   = $percentFree
            }
            $singleDsData = New-Object PSObject -Property $dsProperties
            $allDsData += $singleDsData
        }
    }
    if ($Global:DefaultVIServers.count -gt 0) { DisConnect-VIServer * -Force -Confirm:$False }
}

if ($Global:DefaultVIServers.count -gt 0) { DisConnect-VIServer * -Force -Confirm:$False }
Write-Log "Collection complete. $($allDsData.Count) datastores matched."

# Identify over high%
$alert_high = $allDsData | Where-Object { $_.PercentUsed -gt $high }
$alert_high_cnt = $alert_high.Count
$alert_title = "$alert_high_cnt Datastores @ $high%"

$ds_high = $allDsData | Where-Object { $_.PercentUsed -gt $high } | Sort-Object -Property Datastore -Unique | Sort-Object -Property PercentFree | ConvertTo-Html -Fragment
$ds_med  = $allDsData | Where-Object { $_.PercentUsed -gt $med } | Where-Object { $_.PercentUsed -lt $med_limit } | Sort-Object -Property Datastore -Unique | Sort-Object -Property PercentFree | ConvertTo-Html -Fragment
$ds_low  = $allDsData | Where-Object { $_.PercentUsed -gt $low } | Where-Object { $_.PercentUsed -lt $low_limit } | Sort-Object -Property Datastore -Unique | Sort-Object -Property PercentFree | ConvertTo-Html -Fragment

# ---- Build styled HTML email ------------------------------------------------
$reportTime = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

$tblHigh = Format-DsTableHtml -Fragment ($ds_high -join "`n") -Accent '#b91c1c'
$tblMed  = Format-DsTableHtml -Fragment ($ds_med  -join "`n") -Accent '#c2410c'
$tblLow  = Format-DsTableHtml -Fragment ($ds_low  -join "`n") -Accent '#a16207'

$body = @"
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;-webkit-text-size-adjust:100%;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="760" cellpadding="0" cellspacing="0" style="max-width:760px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">

        <!-- Banner -->
        <tr>
          <td style="background:#1f2937;padding:20px 28px;font-family:Segoe UI,Arial,sans-serif;color:#ffffff;font-size:19px;font-weight:700;">
            Datastore Capacity Report
          </td>
        </tr>

        <!-- Legend -->
        <tr>
          <td style="padding:18px 28px 4px;font-family:Segoe UI,Arial,sans-serif;color:#374151;font-size:13px;line-height:1.5;">
            Datastores between <b>$low%</b> and <b>100%</b> used <i>and</i> with less free space than
            uncommitted (thin-provision) space are listed below, grouped by severity.
          </td>
        </tr>

        <!-- Sections -->
        <tr>
          <td style="padding:8px 28px 4px;">
            <div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:700;color:#b91c1c;margin:14px 0 0;padding-bottom:6px;border-bottom:2px solid #b91c1c;">
              &#9679; Critical &nbsp;&ndash;&nbsp; &ge; $high% used
            </div>
            $tblHigh

            <div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:700;color:#c2410c;margin:14px 0 0;padding-bottom:6px;border-bottom:2px solid #c2410c;">
              &#9679; Warning &nbsp;&ndash;&nbsp; $med% to $high% used
            </div>
            $tblMed

            <div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:700;color:#a16207;margin:14px 0 0;padding-bottom:6px;border-bottom:2px solid #a16207;">
              &#9679; Elevated &nbsp;&ndash;&nbsp; $low% to $med% used
            </div>
            $tblLow
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 28px;font-family:Segoe UI,Arial,sans-serif;color:#6b7280;font-size:11px;line-height:1.5;">
            Automated report generated by cvs_50_100.ps1 via Ansible &bull; $reportTime
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>
"@

$resultFile = Join-Path $DebugDir 'result.html'
$body | Out-File -Append -FilePath $resultFile -Encoding utf8
Write-Log "Report written: $resultFile ($alert_title)"

if ($eMailReport -eq 'yes') {
    $mailParams = @{
        SmtpServer = $SMTPServer
        From       = $MailFrom
        To         = ($MailToString -split ',').Trim()
        Subject    = "$MailSubjectstring | $alert_title"
        Body       = $body
        BodyAsHtml = $true
    }
    if ($MailCcString) { $mailParams.Cc = ($MailCcString -split ',').Trim() }
    Send-MailMessage @mailParams
    Write-Log "Email sent to $MailToString"
}

Write-Log "=== cvs_50_100 datastore report end ==="