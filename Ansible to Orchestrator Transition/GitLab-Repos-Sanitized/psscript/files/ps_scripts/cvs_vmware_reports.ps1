[CmdletBinding()]
param (
    [ValidateSet(
        'vmware_change_digest',
        'vmware_permission_drift',
        'vmware_host_config_drift',
        'vmware_drs_rules',
        'vmware_vmotion_blocked',
        'vmware_path_redundancy',
        'vmware_datastore_overcommit',
        'vmware_growth_outliers',
        'vmware_ha_gaps',
        'vmware_backup_staleness',
        'vmware_license_usage',
        'vmware_build_consistency',
        'vmware_guest_disk_free',
        'vmware_guest_os_eol'
    )]
    [string]$Action,
    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$eMailReport = 'yes',
    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$SMTPServer,
    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$MailToString,
    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$MailCcString = '',
    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$MailSubjectstring,
    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$vCenterList
)

[string[]]$MailTo = if ([string]::IsNullOrWhiteSpace($MailToString)) { @() } else { $MailToString.split(',') }
[string[]]$MailCc = if ([string]::IsNullOrWhiteSpace($MailCcString)) { @() } else { $MailCcString.split(',') }

# =============================================================================
#  framework
# =============================================================================
Function InitializeVariables {
    [CmdletBinding()]
    Param()
    Process{
        Try {
            $Global:SystemLog   = New-TemporaryFile
            $Global:DebugDir    = "$($PSScriptRoot)\Debug"
            if (-not (Test-Path $Global:DebugDir)) { New-Item -ItemType Directory -Path $Global:DebugDir -Force | Out-Null }
            $Global:Today       = Get-Date
            $Global:MailFrom    = $env:COMPUTERNAME + 'user6@dom3.example'
            $Global:MailSubject = ""
        }Catch{ Write-Log "Error: $_.Exception.message" $true }
    }
}

Function Write-Log {
    [CmdletBinding()]
    Param(
        [Parameter(Mandatory=$true)][ValidateNotNullOrEmpty()][string] $InformationItem,
        [Parameter(Mandatory=$false)][ValidateNotNullOrEmpty()][string] $ConsoleOut
    )
    Begin{
        $logMessage = "{0}:`t{1}" -f (Get-Date).ToString('yyyy-MM-dd hh:mm:ss'),$InformationItem
        if($ConsoleOut -eq $true){
            if( $InformationItem -like '*Error:*'){        write-host $logMessage -ForegroundColor Red }
            elseif( $InformationItem -like '*Warn:*'){      write-host $logMessage -ForegroundColor DarkYellow }
            elseif( $InformationItem -like '*Success:*'){   write-host $logMessage -ForegroundColor DarkGreen }
            else{                                           write-host $logMessage }
        }
    }
    Process{
        Try { $logMessage | Add-Content -Path $Global:SystemLog }
        Catch{ write-host $_.Exception.message }
    }
}

Function CertificateValidation {
add-type @"
    using System.Net;
    using System.Security.Cryptography.X509Certificates;
    public class TrustAllCertsPolicy : ICertificatePolicy {
        public bool CheckValidationResult(
            ServicePoint srvPoint, X509Certificate certificate,
            WebRequest request, int certificateProblem) {
            return true;
        }
    }
"@
$AllProtocols = [System.Net.SecurityProtocolType]'Ssl3,Tls,Tls11,Tls12'
[System.Net.ServicePointManager]::SecurityProtocol = $AllProtocols
[System.Net.ServicePointManager]::CertificatePolicy = New-Object TrustAllCertsPolicy
}

Function Get-ScriptDirectory {
    [CmdletBinding()]
    Param()
    Process{
        Try {
            if ($psise) { Split-Path $psise.CurrentFile.FullPath }
            else { $global:PSScriptRoot }
        }Catch{ Write-log "Error: $_.Exception.message" $true }
    }
}

function SendMail {
    [cmdletBinding()]
    param (
        [Parameter(Mandatory=$False, ValueFromPipeline=$True, ValueFromPipelineByPropertyName=$True)]
        [string]$MailBody,
        [String]$MailSubject=$Global:MailSubject,
        [String]$MailAttachments
    )
    PROCESS{
        Try {
            Write-Log "Info: smtpserver:$SMTPServer From:$($Global:MailFrom) To:$MailTo Subject:$MailSubject"
            if([string]::IsNullOrEmpty($MailAttachments)){
                if ($MailCc -and $MailCc.Count -gt 0) {
                    Send-MailMessage -smtpserver $SMTPServer -from $Global:MailFrom -to $MailTo -cc $MailCc -subject $MailSubject -body $MailBody -bodyashtml
                } else {
                    Send-MailMessage -smtpserver $SMTPServer -from $Global:MailFrom -to $MailTo -subject $MailSubject -body $MailBody -bodyashtml
                }
            }
            else{
                Send-MailMessage -smtpserver $SMTPServer -from $Global:MailFrom -to $MailTo -subject $MailSubject -body $MailBody -bodyashtml -Attachments $MailAttachments
            }
        }
        Catch { Write-Log "Error: $($_.Exception.Message)" $true }
    }
}

# ---- Email formatting helpers ----------
function Format-CvsTableHtml {
    param([string]$Fragment,[string]$Accent = '#1f2937',[switch]$CenterCells)

    if ([string]::IsNullOrWhiteSpace($Fragment) -or ($Fragment -notmatch '<td')) {
        return '<p style="margin:4px 0 10px;padding:7px 9px;background:#f9fafb;border:1px dashed #d1d5db;border-radius:4px;color:#6b7280;font-size:12px;font-family:Segoe UI,Arial,sans-serif;">None found.</p>'
    }

    $t = $Fragment
    $t = $t -replace '<table>',
        '<table cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;width:100%;margin:4px 0 10px;font-family:Segoe UI,Arial,sans-serif;font-size:12px;">'
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

function New-CvsReportSectionHtml {
    param([string]$Title,[string]$TableHtml,[string]$Accent = '#1f2937')
    return @"
            <div style="font-family:Segoe UI,Arial,sans-serif;font-size:12px;font-weight:700;color:$Accent;margin:8px 0 0;padding-bottom:4px;border-bottom:2px solid $Accent;">
              &#9679; $Title
            </div>
            $TableHtml
"@
}

function New-CvsReportHtml {
    param([string]$Title,[string]$Summary,[string]$Sections,[string]$FooterScriptName = 'cvs_vmware_ops_reports.ps1')
    $reportTime = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $summaryBlock = ''
    if (-not [string]::IsNullOrWhiteSpace($Summary)) {
$summaryBlock = @"
        <tr>
          <td style="padding:10px 18px 2px;font-family:Segoe UI,Arial,sans-serif;color:#374151;font-size:12px;line-height:1.35;">
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
          <td style="padding:4px 18px 2px;">
$Sections
          </td>
        </tr>
        <tr>
          <td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:9px 18px;font-family:Segoe UI,Arial,sans-serif;color:#6b7280;font-size:10px;line-height:1.3;">
            Automated report generated by $FooterScriptName via Ansible &bull; $reportTime
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

function Send-CvsVmwareReport {
    param([string]$Title,[string]$Summary,[string]$Sections,[string]$SubjectSuffix,[string]$ResultFileName)
    if ([string]::IsNullOrWhiteSpace($MailSubjectstring)) { $Global:MailSubject = "$Title | $SubjectSuffix" }
    else { $Global:MailSubject = "$($MailSubjectstring) | $SubjectSuffix" }
    [string]$body = New-CvsReportHtml -Title $Title -Summary $Summary -Sections $Sections -FooterScriptName 'cvs_vmware_ops_reports.ps1'
    try { $body | Out-File -Append -FilePath "$($Global:DebugDir)\$ResultFileName" -Encoding utf8 } catch {}
    if ($eMailReport -eq 'yes') { SendMail $body }
    return $body
}

# =============================================================================
#  VMware + state helpers
# =============================================================================
function Initialize-PowerCLI {
    Write-Log "Loading PowerCLI module..." $true

    if (!(Get-Module VMware.VimAutomation.Core)) {
        Import-Module VMware.VimAutomation.Core -ErrorAction Stop
    }

    try { Set-PowerCLIConfiguration -InvalidCertificateAction Ignore -Scope Session -Confirm:$false | Out-Null } catch { Write-Log "Warn: InvalidCertificateAction setting failed: $($_.Exception.Message)" $true }
    try { Set-PowerCLIConfiguration -DefaultVIServerMode Multiple -Scope Session -Confirm:$false | Out-Null } catch { Write-Log "Warn: DefaultVIServerMode setting failed: $($_.Exception.Message)" $true }

    if ($Global:DefaultVIServers.Count -gt 0) {
        Disconnect-VIServer * -Force -Confirm:$false
    }

    Write-Log "PowerCLI ready." $true
}

function Initialize-VCenterCredential {
    if ($script:vcCred) { return }

    if ([string]::IsNullOrEmpty($env:VC_USER) -or [string]::IsNullOrEmpty($env:VC_PASS)) {
        Write-Log "Error: VC_USER/VC_PASS not present in environment - vault creds not delivered by the task. Aborting." $true
        exit 1
    }

    $script:vcCred = [pscredential]::new(
        $env:VC_USER,
        (ConvertTo-SecureString $env:VC_PASS -AsPlainText -Force)
    )

    Write-Log "Credential built for user [$($script:vcCred.UserName)]." $true
}

function Connect-CvsVIServer {
    param([Parameter(Mandatory=$true)][string]$VCenter)

    Initialize-VCenterCredential
    Write-Log "  Connecting to $VCenter..." $true
    Connect-VIServer -Server $VCenter -Credential $script:vcCred -Force -WarningAction 0 -ErrorAction Stop | Out-Null
    Write-Log "  Connected to $VCenter." $true
}

function Test-VCenterReachable {
    param([string]$VCenter,[int]$Port=443,[int]$TimeoutMs=5000)
    $tcp = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $tcp.BeginConnect($VCenter,$Port,$null,$null)
        if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
        $tcp.EndConnect($iar); return $true
    } catch { return $false } finally { $tcp.Close() }
}

function Get-VCShortName { param([string]$VCenter) return ($VCenter.Split('.')[0]).ToUpper() }

function Get-CvsStateDir {
    $d = Join-Path $Global:DebugDir 'state'
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
    return $d
}
function Save-CvsState {
    param([string]$Name,$Data)
    try { $Data | ConvertTo-Json -Depth 8 | Out-File -FilePath (Join-Path (Get-CvsStateDir) $Name) -Encoding utf8 }
    catch { Write-Log "Warn: could not save state $Name : $($_.Exception.Message)" $true }
}
function Load-CvsState {
    param([string]$Name)
    $path = Join-Path (Get-CvsStateDir) $Name
    if (-not (Test-Path $path)) { return $null }
    try { return (Get-Content -Path $path -Raw | ConvertFrom-Json) } catch { return $null }
}

function Get-VmHostMap {
    $hostMap = @{}
    foreach ($h in (Get-View -ViewType HostSystem -Property Name)) { $hostMap[$h.MoRef.Value] = $h.Name }
    $map = @{}
    foreach ($v in (Get-View -ViewType VirtualMachine -Property Name,Runtime.Host)) {
        $hn = if ($v.Runtime.Host) { $hostMap[$v.Runtime.Host.Value] } else { '' }
        $map[$v.MoRef.Value] = @{ Name = $v.Name; Host = $hn }
    }
    return $map
}

# =============================================================================
#  Main dispatcher
# =============================================================================
function Main($Action){
    $scriptDir = Get-ScriptDirectory
    Write-Log "=== cvs_vmware_ops_reports start (Action=$Action) ===" $true

    switch($Action){

        # =====================================================================
        #  CHANGE TRACKING / ACCOUNTABILITY
        # =====================================================================
        'vmware_change_digest'{
            $LookbackDays = 7
            $created = @(); $removed = @(); $reconfig = @()

            Initialize-PowerCLI
            foreach ($vcenter in $vCenterList.split(",")) {
                $vcenter = $vcenter.trim()
                if (-not (Test-VCenterReachable $vcenter)) { Write-Log "Warn: $vcenter unreachable - skipping" $true; continue }
                Write-Log "vCenter: $vcenter" $true
                Connect-CvsVIServer -VCenter $vcenter
                $vcShort = Get-VCShortName $vcenter

                $evtMgr = Get-View (Get-View ServiceInstance).Content.EventManager
                $filter = New-Object VMware.Vim.EventFilterSpec
                $filter.EventTypeId = @('VmCreatedEvent','VmDeployedEvent','VmClonedEvent','VmRegisteredEvent','VmRemovedEvent','VmReconfiguredEvent')
                $filter.Time = New-Object VMware.Vim.EventFilterSpecByTime
                $filter.Time.BeginTime = (Get-Date).ToUniversalTime().AddDays(-$LookbackDays)
                $events = @()
                try { $events = $evtMgr.QueryEvents($filter) } catch { Write-Log "Warn: QueryEvents failed on $vcenter : $($_.Exception.Message)" $true }

                foreach ($e in $events) {
                    $etype = $e.GetType().Name
                    $vmName = try { $e.Vm.Name } catch { '' }
                    $user   = if ($e.UserName) { $e.UserName } else { '(system)' }
                    $when   = $e.CreatedTime.ToString('yyyy-MM-dd HH:mm')
                    if ($etype -eq 'VmReconfiguredEvent') {
                        $parts = @()
                        $cs = $e.ConfigSpec
                        if ($cs) {
                            if ($cs.MemoryMB)          { $parts += "mem=$([math]::Round($cs.MemoryMB/1024,1))GB" }
                            if ($cs.NumCPUs)           { $parts += "vCPU=$($cs.NumCPUs)" }
                            if ($cs.DeviceChange -and $cs.DeviceChange.Count) { $parts += "devChanges=$($cs.DeviceChange.Count)" }
                        }
                        $reconfig += [pscustomobject][ordered]@{ vCenter=$vcShort; When=$when; VM=$vmName; User=$user; Change=($parts -join ' ') }
                    }
                    elseif ($etype -eq 'VmRemovedEvent') {
                        $removed += [pscustomobject][ordered]@{ vCenter=$vcShort; When=$when; VM=$vmName; User=$user }
                    }
                    else {
                        $removedType = $etype -replace 'Event',''
                        $created += [pscustomobject][ordered]@{ vCenter=$vcShort; When=$when; VM=$vmName; User=$user; Type=$removedType }
                    }
                }
                if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$false }
            }
            if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$false }

            $fCreated  = $created  | Sort-Object When -Descending | ConvertTo-Html -Fragment
            $fRemoved  = $removed  | Sort-Object When -Descending | ConvertTo-Html -Fragment
            $fReconfig = $reconfig | Sort-Object When -Descending | ConvertTo-Html -Fragment

            $sections  = New-CvsReportSectionHtml -Title 'Created / cloned / registered' -TableHtml (Format-CvsTableHtml -Fragment ($fCreated -join "`n") -Accent '#047857') -Accent '#047857'
            $sections += New-CvsReportSectionHtml -Title 'Removed / deleted' -TableHtml (Format-CvsTableHtml -Fragment ($fRemoved -join "`n") -Accent '#b91c1c') -Accent '#b91c1c'
            $sections += New-CvsReportSectionHtml -Title 'Reconfigured (CPU / memory / devices)' -TableHtml (Format-CvsTableHtml -Fragment ($fReconfig -join "`n") -Accent '#0369a1') -Accent '#0369a1'

            $summary = "VM lifecycle and reconfigure events over the last $LookbackDays days, with the initiating account. Doubles as a lightweight audit artifact and catches unplanned CPU/memory grants before they distort capacity planning."
            $suffix  = "$($created.Count) new / $($removed.Count) removed / $($reconfig.Count) reconfigured"
            Send-CvsVmwareReport -Title 'VMware Change Digest' -Summary $summary -Sections $sections -SubjectSuffix $suffix -ResultFileName 'vmware_change_result.html' | Out-Null
        }

        'vmware_permission_drift'{
            $addedAll = @(); $removedAll = @(); $baselineNote = @()

            Initialize-PowerCLI
            foreach ($vcenter in $vCenterList.split(",")) {
                $vcenter = $vcenter.trim()
                if (-not (Test-VCenterReachable $vcenter)) { Write-Log "Warn: $vcenter unreachable - skipping" $true; continue }
                Write-Log "vCenter: $vcenter" $true
                Connect-CvsVIServer -VCenter $vcenter
                $vcShort = Get-VCShortName $vcenter

                $cur = @()
                foreach ($p in (Get-VIPermission)) {
                    $entity = try { $p.Entity.Name } catch { [string]$p.Entity }
                    $cur += [pscustomobject]@{
                        Key       = "$($p.Principal)|$($p.Role)|$entity|$($p.Propagate)"
                        Principal = [string]$p.Principal
                        Role      = [string]$p.Role
                        Entity    = [string]$entity
                        IsGroup   = [string]$p.IsGroup
                        Propagate = [string]$p.Propagate
                    }
                }

                $stateName = "perm_$vcShort.json"
                $prev = Load-CvsState $stateName
                if (-not $prev) {
                    $baselineNote += "[$vcShort] baseline established ($($cur.Count) assignments)"
                } else {
                    $prevKeys = @($prev | ForEach-Object { $_.Key })
                    $curKeys  = @($cur  | ForEach-Object { $_.Key })
                    foreach ($c in $cur)  { if ($prevKeys -notcontains $c.Key) { $addedAll   += ([pscustomobject][ordered]@{ vCenter=$vcShort; Principal=$c.Principal; Role=$c.Role; Entity=$c.Entity; IsGroup=$c.IsGroup; Propagate=$c.Propagate }) } }
                    foreach ($p in $prev) { if ($curKeys  -notcontains $p.Key) { $removedAll += ([pscustomobject][ordered]@{ vCenter=$vcShort; Principal=$p.Principal; Role=$p.Role; Entity=$p.Entity; IsGroup=$p.IsGroup; Propagate=$p.Propagate }) } }
                }
                Save-CvsState $stateName $cur
                if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$false }
            }
            if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$false }

            $fAdded   = $addedAll   | Sort-Object vCenter,Role,Principal | ConvertTo-Html -Fragment
            $fRemoved = $removedAll | Sort-Object vCenter,Role,Principal | ConvertTo-Html -Fragment
            $fAdded   = $fAdded   -replace 'Admin','<font color="#b91c1c">Admin</font>'

            $sections = ''
            if ($baselineNote.Count -gt 0) {
                $sections += "<p style='font-family:Segoe UI,Arial,sans-serif;font-size:12px;color:#6b7280;'>$([string]::Join('<br>', $baselineNote))</p>"
            }
            $sections += New-CvsReportSectionHtml -Title 'New permission grants' -TableHtml (Format-CvsTableHtml -Fragment ($fAdded -join "`n") -Accent '#b91c1c') -Accent '#b91c1c'
            $sections += New-CvsReportSectionHtml -Title 'Removed permission grants' -TableHtml (Format-CvsTableHtml -Fragment ($fRemoved -join "`n") -Accent '#0369a1') -Accent '#0369a1'

            $summary = "vCenter permission assignments compared to the previous snapshot. New admin grants, changed roles, or SSO group additions surface here instead of during an audit. First run per vCenter just records the baseline."
            $suffix  = "$($addedAll.Count) added / $($removedAll.Count) removed"
            Send-CvsVmwareReport -Title 'VMware Permission Drift' -Summary $summary -Sections $sections -SubjectSuffix $suffix -ResultFileName 'vmware_permdrift_result.html' | Out-Null
        }

        'vmware_host_config_drift'{
            $changesAll = @(); $baselineNote = @()

            Initialize-PowerCLI
            foreach ($vcenter in $vCenterList.split(",")) {
                $vcenter = $vcenter.trim()
                if (-not (Test-VCenterReachable $vcenter)) { Write-Log "Warn: $vcenter unreachable - skipping" $true; continue }
                Write-Log "vCenter: $vcenter" $true
                Connect-CvsVIServer -VCenter $vcenter
                $vcShort = Get-VCShortName $vcenter

                $cur = @()
                foreach ($h in (Get-VMHost)) {
                    $svc     = Get-VMHostService -VMHost $h
                    $ssh     = [string][bool]($svc | Where-Object { $_.Key -eq 'TSM-SSH' }).Running
                    $shell   = [string][bool]($svc | Where-Object { $_.Key -eq 'TSM' }).Running
                    $lock    = [string]$h.ExtensionData.Config.LockdownMode
                    $syslog  = try { [string](Get-AdvancedSetting -Entity $h -Name 'Syslog.global.logHost' -ErrorAction SilentlyContinue).Value } catch { '' }
                    $scratch = try { [string](Get-AdvancedSetting -Entity $h -Name 'ScratchConfig.CurrentScratchLocation' -ErrorAction SilentlyContinue).Value } catch { '' }
                    $ntp     = ((Get-VMHostNtpServer -VMHost $h) -join ',')
                    $fw      = try { [string]@(Get-VMHostFirewallException -VMHost $h | Where-Object { $_.Enabled }).Count } catch { '' }
                    $cur += [pscustomobject]@{ Host=$h.Name; SSH=$ssh; Shell=$shell; Lockdown=$lock; Syslog=$syslog; Scratch=$scratch; NTP=$ntp; FwEnabled=$fw }
                }

                $stateName = "hostcfg_$vcShort.json"
                $prev = Load-CvsState $stateName
                if (-not $prev) {
                    $baselineNote += "[$vcShort] baseline established ($($cur.Count) hosts)"
                } else {
                    $prevMap = @{}
                    foreach ($p in $prev) { $prevMap[$p.Host] = $p }
                    $fields = 'SSH','Shell','Lockdown','Syslog','Scratch','NTP','FwEnabled'
                    foreach ($c in $cur) {
                        $old = $prevMap[$c.Host]
                        if (-not $old) { $changesAll += ([pscustomobject][ordered]@{ vCenter=$vcShort; Host=$c.Host; Change='NEW HOST (no baseline)' }); continue }
                        foreach ($f in $fields) {
                            if ([string]$c.$f -ne [string]$old.$f) {
                                $changesAll += ([pscustomobject][ordered]@{ vCenter=$vcShort; Host=$c.Host; Change="$f : '$($old.$f)' -> '$($c.$f)'" })
                            }
                        }
                    }
                }
                Save-CvsState $stateName $cur
                if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$false }
            }
            if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$false }

            $frag = $changesAll | Sort-Object vCenter,Host | ConvertTo-Html -Fragment
            $sections = ''
            if ($baselineNote.Count -gt 0) {
                $sections += "<p style='font-family:Segoe UI,Arial,sans-serif;font-size:12px;color:#6b7280;'>$([string]::Join('<br>', $baselineNote))</p>"
            }
            $sections += New-CvsReportSectionHtml -Title 'Host configuration changes since last run' -TableHtml (Format-CvsTableHtml -Fragment ($frag -join "`n") -Accent '#b91c1c') -Accent '#b91c1c'

            $summary = "Per-host SSH/ESXi Shell state, lockdown mode, syslog target, scratch location, NTP source, and enabled-firewall-exception count, compared to the previous snapshot. A poor-man's host-profile compliance check &mdash; SSH enabled or lockdown disabled are STIG findings."
            $suffix  = "$($changesAll.Count) changes"
            Send-CvsVmwareReport -Title 'VMware Host Config Drift' -Summary $summary -Sections $sections -SubjectSuffix $suffix -ResultFileName 'vmware_hostcfgdrift_result.html' | Out-Null
        }

        # =====================================================================
        #  vMOTION / DRS HEALTH
        # =====================================================================
        'vmware_drs_rules'{
            $violated = @(); $disabled = @(); $manual = @()

            Initialize-PowerCLI
            foreach ($vcenter in $vCenterList.split(",")) {
                $vcenter = $vcenter.trim()
                if (-not (Test-VCenterReachable $vcenter)) { Write-Log "Warn: $vcenter unreachable - skipping" $true; continue }
                Write-Log "vCenter: $vcenter" $true
                Connect-CvsVIServer -VCenter $vcenter
                $vcShort = Get-VCShortName $vcenter
                $vmMap = Get-VmHostMap

                foreach ($cluster in (Get-Cluster)) {
                    foreach ($rule in (Get-DrsRule -Cluster $cluster -ErrorAction SilentlyContinue)) {
                        $vmNames  = @(); $vmHosts = @()
                        foreach ($vid in $rule.VMIds) {
                            $key = ($vid -replace '^VirtualMachine-','')
                            if ($vmMap.ContainsKey($key)) { $vmNames += $vmMap[$key].Name; $vmHosts += $vmMap[$key].Host }
                        }
                        if (-not $rule.Enabled) {
                            $disabled += [pscustomobject][ordered]@{ vCenter=$vcShort; Cluster=$cluster.Name; Rule=$rule.Name; Type=[string]$rule.Type; VMs=($vmNames -join ', ') }
                            continue
                        }
                        $distinctHosts = @($vmHosts | Where-Object { $_ } | Select-Object -Unique)
                        $isViolated = $false
                        if ($rule.Type -eq 'VMAntiAffinity' -and $vmHosts.Count -gt 1 -and $distinctHosts.Count -lt $vmHosts.Count) { $isViolated = $true }
                        if ($rule.Type -eq 'VMAffinity'     -and $distinctHosts.Count -gt 1) { $isViolated = $true }
                        if ($isViolated) {
                            $violated += [pscustomobject][ordered]@{ vCenter=$vcShort; Cluster=$cluster.Name; Rule=$rule.Name; Type=[string]$rule.Type; VMs=($vmNames -join ', '); Hosts=(($vmHosts | Where-Object {$_}) -join ', ') }
                        }
                    }

                    # VMs pinned to manual/partial DRS override
                    $drsVmCfg = $cluster.ExtensionData.ConfigurationEx.DrsVmConfig
                    if ($drsVmCfg) {
                        foreach ($o in $drsVmCfg) {
                            if ([string]$o.Behavior -in @('manual','partiallyAutomated')) {
                                $key = $o.Key.Value
                                $nm  = if ($vmMap.ContainsKey($key)) { $vmMap[$key].Name } else { $key }
                                $manual += [pscustomobject][ordered]@{ vCenter=$vcShort; Cluster=$cluster.Name; VM=$nm; DrsOverride=[string]$o.Behavior }
                            }
                        }
                    }
                }
                if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$false }
            }
            if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$false }

            $fV = $violated | Sort-Object vCenter,Cluster | ConvertTo-Html -Fragment
            $fD = $disabled | Sort-Object vCenter,Cluster | ConvertTo-Html -Fragment
            $fM = $manual   | Sort-Object vCenter,Cluster | ConvertTo-Html -Fragment

            $sections  = New-CvsReportSectionHtml -Title 'Currently VIOLATED rules' -TableHtml (Format-CvsTableHtml -Fragment ($fV -join "`n") -Accent '#b91c1c') -Accent '#b91c1c'
            $sections += New-CvsReportSectionHtml -Title 'Disabled rules' -TableHtml (Format-CvsTableHtml -Fragment ($fD -join "`n") -Accent '#c2410c') -Accent '#c2410c'
            $sections += New-CvsReportSectionHtml -Title 'VMs pinned to manual / partial DRS' -TableHtml (Format-CvsTableHtml -Fragment ($fM -join "`n") -Accent '#0369a1') -Accent '#0369a1'

            $summary = "DRS affinity/anti-affinity rules that are violated right now or disabled, plus VMs whose DRS automation is overridden to manual. A violated anti-affinity rule means a redundant pair may be on the same host at this moment."
            $suffix  = "$($violated.Count) violated / $($disabled.Count) disabled / $($manual.Count) manual"
            Send-CvsVmwareReport -Title 'VMware DRS Rule Health' -Summary $summary -Sections $sections -SubjectSuffix $suffix -ResultFileName 'vmware_drs_result.html' | Out-Null
        }

        'vmware_vmotion_blocked'{
            $allBlocked = @()

            Initialize-PowerCLI
            foreach ($vcenter in $vCenterList.split(",")) {
                $vcenter = $vcenter.trim()
                if (-not (Test-VCenterReachable $vcenter)) { Write-Log "Warn: $vcenter unreachable - skipping" $true; continue }
                Write-Log "vCenter: $vcenter" $true
                Connect-CvsVIServer -VCenter $vcenter
                $vcShort = Get-VCShortName $vcenter

                $dsMap = @{}
                foreach ($ds in (Get-View -ViewType Datastore -Property Name,Summary)) {
                    $dsMap[$ds.MoRef.Value] = @{ Name = $ds.Summary.Name; Local = (-not $ds.Summary.MultipleHostAccess) }
                }

                foreach ($vm in (Get-VM)) {
                    $reasons = @()
                    $cfg = $vm.ExtensionData.Config
                    if ($cfg.CpuAffinity) { $reasons += 'CPU affinity set' }
                    foreach ($dev in $cfg.Hardware.Device) {
                        if ($dev -is [VMware.Vim.VirtualPCIPassthrough]) { $reasons += 'PCI passthrough' }
                        elseif ($dev -is [VMware.Vim.VirtualCdrom] -and $dev.Connectable -and $dev.Connectable.Connected) {
                            if     ($dev.Backing -is [VMware.Vim.VirtualCdromIsoBackingInfo])         { $reasons += 'connected ISO' }
                            elseif ($dev.Backing -is [VMware.Vim.VirtualCdromAtapiBackingInfo])       { $reasons += 'host CD device' }
                            elseif ($dev.Backing -is [VMware.Vim.VirtualCdromRemoteAtapiBackingInfo]) { $reasons += 'client CD device' }
                        }
                    }
                    foreach ($dsRef in $vm.ExtensionData.Datastore) {
                        $entry = $dsMap[$dsRef.Value]
                        if ($entry -and $entry.Local) { $reasons += ("local datastore: " + $entry.Name) }
                    }
                    if ($reasons.Count -gt 0) {
                        $allBlocked += [pscustomobject][ordered]@{
                            vCenter=$vcShort; VM=$vm.Name; PowerState=[string]$vm.PowerState; Host=$vm.VMHost.Name; Blockers=(($reasons | Select-Object -Unique) -join '; ')
                        }
                    }
                }
                if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$false }
            }
            if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$false }

            $frag = $allBlocked | Sort-Object vCenter,Host,VM | ConvertTo-Html -Fragment
            $sections = New-CvsReportSectionHtml -Title 'VMs with vMotion / maintenance-mode blockers' -TableHtml (Format-CvsTableHtml -Fragment ($frag -join "`n") -Accent '#0369a1') -Accent '#0369a1'
            $summary = "VMs that cannot migrate, or would block a host entering maintenance mode: connected host CD devices, PCI passthrough, CPU affinity, or local-datastore residency. Run before patch night, not during it."
            $suffix  = "$($allBlocked.Count) VMs flagged"
            Send-CvsVmwareReport -Title 'VMware vMotion Blocker Report' -Summary $summary -Sections $sections -SubjectSuffix $suffix -ResultFileName 'vmware_vmotion_result.html' | Out-Null
        }

        # =====================================================================
        #  STORAGE BEYOND CAPACITY
        # =====================================================================
        'vmware_path_redundancy'{
            $allPaths = @()

            Initialize-PowerCLI
            foreach ($vcenter in $vCenterList.split(",")) {
                $vcenter = $vcenter.trim()
                if (-not (Test-VCenterReachable $vcenter)) { Write-Log "Warn: $vcenter unreachable - skipping" $true; continue }
                Write-Log "vCenter: $vcenter" $true
                Connect-CvsVIServer -VCenter $vcenter
                $vcShort = Get-VCShortName $vcenter

                foreach ($h in (Get-VMHost | Where-Object { $_.ConnectionState -eq 'Connected' })) {
                    $luns = Get-ScsiLun -VmHost $h -LunType disk -ErrorAction SilentlyContinue
                    foreach ($lun in $luns) {
                        $paths  = Get-ScsiLunPath -ScsiLun $lun -ErrorAction SilentlyContinue
                        $active = @($paths | Where-Object { $_.State -eq 'Active' }).Count
                        $dead   = @($paths | Where-Object { $_.State -eq 'Dead' }).Count
                        if ($dead -gt 0 -or $active -le 1) {
                            $allPaths += [pscustomobject][ordered]@{
                                vCenter=$vcShort; Host=$h.Name; LUN=$lun.CanonicalName; ActivePaths=$active; DeadPaths=$dead; TotalPaths=@($paths).Count
                                Note = if ($dead -gt 0) { 'dead path present' } else { 'single active path' }
                            }
                        }
                    }
                }
                if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$false }
            }
            if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$false }

            $frag = $allPaths | Sort-Object DeadPaths -Descending | ConvertTo-Html -Fragment
            $sections = New-CvsReportSectionHtml -Title 'LUNs with dead paths or a single active path' -TableHtml (Format-CvsTableHtml -Fragment ($frag -join "`n") -Accent '#b91c1c') -Accent '#b91c1c'
            $summary = "Per-host storage path health. A dead path or a LUN down to one active path is silent until the surviving path also fails. Note: this scans every disk LUN on every connected host and can run long on large fabrics."
            $suffix  = "$($allPaths.Count) LUNs at risk"
            Send-CvsVmwareReport -Title 'VMware Path Redundancy Report' -Summary $summary -Sections $sections -SubjectSuffix $suffix -ResultFileName 'vmware_paths_result.html' | Out-Null
        }

        'vmware_datastore_overcommit'{
            Set-Variable BYTES_IN_GB -option Constant -value ([int64]1073741824) -Visibility Private
            $CritPct = 150; $WarnPct = 120; $ElevPct = 100
            $allDs = @()

            Initialize-PowerCLI
            foreach ($vcenter in $vCenterList.split(",")) {
                $vcenter = $vcenter.trim()
                if (-not (Test-VCenterReachable $vcenter)) { Write-Log "Warn: $vcenter unreachable - skipping" $true; continue }
                Write-Log "vCenter: $vcenter" $true
                Connect-CvsVIServer -VCenter $vcenter
                $vcShort = Get-VCShortName $vcenter

                foreach ($ds in (Get-View -ViewType Datastore -Property Name,Summary)) {
                    $cap = $ds.Summary.Capacity
                    if ($cap -le 0) { continue }
                    $used        = $cap - $ds.Summary.FreeSpace
                    $provisioned = $used + $ds.Summary.Uncommitted
                    $overPct     = [math]::Round(($provisioned / $cap) * 100, 1)
                    if ($overPct -le $ElevPct) { continue }
                    $allDs += [pscustomobject][ordered]@{
                        vCenter=$vcShort; Datastore=$ds.Summary.Name; CapacityGB=[math]::Round($cap/$BYTES_IN_GB); ProvisionedGB=[math]::Round($provisioned/$BYTES_IN_GB); OvercommitPct=$overPct
                    }
                }
                if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$false }
            }
            if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$false }

            $crit = $allDs | Where-Object { $_.OvercommitPct -ge $CritPct } | Sort-Object OvercommitPct -Descending | ConvertTo-Html -Fragment
            $warn = $allDs | Where-Object { $_.OvercommitPct -ge $WarnPct -and $_.OvercommitPct -lt $CritPct } | Sort-Object OvercommitPct -Descending | ConvertTo-Html -Fragment
            $elev = $allDs | Where-Object { $_.OvercommitPct -gt $ElevPct -and $_.OvercommitPct -lt $WarnPct } | Sort-Object OvercommitPct -Descending | ConvertTo-Html -Fragment

            $sections  = New-CvsReportSectionHtml -Title "Critical &nbsp;&ndash;&nbsp; &ge; $CritPct% provisioned" -TableHtml (Format-CvsTableHtml -Fragment ($crit -join "`n") -Accent '#b91c1c') -Accent '#b91c1c'
            $sections += New-CvsReportSectionHtml -Title "Warning &nbsp;&ndash;&nbsp; $WarnPct% to $CritPct% provisioned" -TableHtml (Format-CvsTableHtml -Fragment ($warn -join "`n") -Accent '#c2410c') -Accent '#c2410c'
            $sections += New-CvsReportSectionHtml -Title "Elevated &nbsp;&ndash;&nbsp; $ElevPct% to $WarnPct% provisioned" -TableHtml (Format-CvsTableHtml -Fragment ($elev -join "`n") -Accent '#a16207') -Accent '#a16207'

            $summary = "Thin-provision overcommit per datastore: provisioned (used + uncommitted) versus physical capacity. Over 100% means thin disks can inflate past the datastore's real size; the datastores that <i>will</i> go hot, not the ones already hot."
            $suffix  = "$($allDs.Count) datastores overcommitted"
            Send-CvsVmwareReport -Title 'VMware Datastore Overcommit Report' -Summary $summary -Sections $sections -SubjectSuffix $suffix -ResultFileName 'vmware_overcommit_result.html' | Out-Null
        }

        'vmware_growth_outliers'{
            $TopN = 10
            $outliers = @(); $baselineNote = @()

            Initialize-PowerCLI
            foreach ($vcenter in $vCenterList.split(",")) {
                $vcenter = $vcenter.trim()
                if (-not (Test-VCenterReachable $vcenter)) { Write-Log "Warn: $vcenter unreachable - skipping" $true; continue }
                Write-Log "vCenter: $vcenter" $true
                Connect-CvsVIServer -VCenter $vcenter
                $vcShort = Get-VCShortName $vcenter

                $cur = @()
                foreach ($vm in (Get-VM)) { $cur += [pscustomobject]@{ VM=$vm.Name; CommittedGB=[math]::Round($vm.UsedSpaceGB,1) } }

                $stateName = "growth_$vcShort.json"
                $prev = Load-CvsState $stateName
                if (-not $prev -or -not $prev.VMs) {
                    $baselineNote += "[$vcShort] baseline established ($($cur.Count) VMs)"
                } else {
                    $prevDate = try { [datetime]$prev.Date } catch { (Get-Date).AddDays(-7) }
                    $days = [math]::Max(1, [math]::Round(((Get-Date) - $prevDate).TotalDays))
                    $prevMap = @{}
                    foreach ($p in $prev.VMs) { $prevMap[$p.VM] = [double]$p.CommittedGB }
                    foreach ($c in $cur) {
                        if ($prevMap.ContainsKey($c.VM)) {
                            $delta = [math]::Round($c.CommittedGB - $prevMap[$c.VM], 1)
                            if ($delta -gt 0) {
                                $outliers += [pscustomobject][ordered]@{
                                    vCenter=$vcShort; VM=$c.VM; PrevGB=$prevMap[$c.VM]; NowGB=$c.CommittedGB; DeltaGB=$delta; PerDayGB=[math]::Round($delta/$days,2)
                                }
                            }
                        }
                    }
                }
                Save-CvsState $stateName ([pscustomobject]@{ Date=(Get-Date).ToString('o'); VMs=$cur })
                if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$false }
            }
            if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$false }

            $top = $outliers | Sort-Object DeltaGB -Descending | Select-Object -First $TopN | ConvertTo-Html -Fragment
            $sections = ''
            if ($baselineNote.Count -gt 0) {
                $sections += "<p style='font-family:Segoe UI,Arial,sans-serif;font-size:12px;color:#6b7280;'>$([string]::Join('<br>', $baselineNote))</p>"
            }
            $sections += New-CvsReportSectionHtml -Title "Top $TopN committed-storage growth since last run" -TableHtml (Format-CvsTableHtml -Fragment ($top -join "`n") -Accent '#c2410c') -Accent '#c2410c'
            $summary = "Per-VM committed-storage change since the previous run, largest growth first. Catches the one VM with a runaway log or database partition eating a shared datastore before the capacity report goes red. Schedule weekly for a week-over-week view."
            $suffix  = "$(@($outliers).Count) VMs grew"
            Send-CvsVmwareReport -Title 'VMware VMDK Growth Outliers' -Summary $summary -Sections $sections -SubjectSuffix $suffix -ResultFileName 'vmware_growth_result.html' | Out-Null
        }

        # =====================================================================
        #  AVAILABILITY POSTURE
        # =====================================================================
        'vmware_ha_gaps'{
            $haOffClusters = @(); $vmDisabled = @(); $cfgIssues = @()

            Initialize-PowerCLI
            foreach ($vcenter in $vCenterList.split(",")) {
                $vcenter = $vcenter.trim()
                if (-not (Test-VCenterReachable $vcenter)) { Write-Log "Warn: $vcenter unreachable - skipping" $true; continue }
                Write-Log "vCenter: $vcenter" $true
                Connect-CvsVIServer -VCenter $vcenter
                $vcShort = Get-VCShortName $vcenter
                $vmMap = Get-VmHostMap

                foreach ($cluster in (Get-Cluster)) {
                    if (-not $cluster.HAEnabled) {
                        $haOffClusters += [pscustomobject][ordered]@{ vCenter=$vcShort; Cluster=$cluster.Name; DrsEnabled=[string]$cluster.DrsEnabled }
                    }
                    $dasVmCfg = $cluster.ExtensionData.ConfigurationEx.DasVmConfig
                    if ($dasVmCfg) {
                        foreach ($o in $dasVmCfg) {
                            $rp = try { [string]$o.DasSettings.RestartPriority } catch { '' }
                            if ($rp -eq 'disabled') {
                                $key = $o.Key.Value
                                $nm  = if ($vmMap.ContainsKey($key)) { $vmMap[$key].Name } else { $key }
                                $vmDisabled += [pscustomobject][ordered]@{ vCenter=$vcShort; Cluster=$cluster.Name; VM=$nm; RestartPriority='disabled' }
                            }
                        }
                    }
                    $issues = $cluster.ExtensionData.ConfigIssue
                    if ($issues) {
                        foreach ($iss in $issues) {
                            $cfgIssues += [pscustomobject][ordered]@{ vCenter=$vcShort; Cluster=$cluster.Name; Issue=$iss.GetType().Name; Detail=([string]$iss.FullFormattedMessage) }
                        }
                    }
                }
                if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$false }
            }
            if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$false }

            $fH = $haOffClusters | Sort-Object vCenter,Cluster | ConvertTo-Html -Fragment
            $fV = $vmDisabled    | Sort-Object vCenter,Cluster,VM | ConvertTo-Html -Fragment
            $fI = $cfgIssues     | Sort-Object vCenter,Cluster | ConvertTo-Html -Fragment

            $sections  = New-CvsReportSectionHtml -Title 'Clusters with HA disabled' -TableHtml (Format-CvsTableHtml -Fragment ($fH -join "`n") -Accent '#b91c1c') -Accent '#b91c1c'
            $sections += New-CvsReportSectionHtml -Title 'VMs with HA restart priority disabled' -TableHtml (Format-CvsTableHtml -Fragment ($fV -join "`n") -Accent '#c2410c') -Accent '#c2410c'
            $sections += New-CvsReportSectionHtml -Title 'Cluster HA/DRS config issues' -TableHtml (Format-CvsTableHtml -Fragment ($fI -join "`n") -Accent '#0369a1') -Accent '#0369a1'

            $summary = "Availability gaps: clusters running with HA off, individual VMs whose HA restart priority is set to Disabled (usually a 'temporary' change that was never reverted), and any cluster-level HA/DRS configuration issues vCenter is currently raising."
            $suffix  = "$($haOffClusters.Count) HA-off / $($vmDisabled.Count) VMs disabled / $($cfgIssues.Count) issues"
            Send-CvsVmwareReport -Title 'VMware HA Protection Gaps' -Summary $summary -Sections $sections -SubjectSuffix $suffix -ResultFileName 'vmware_ha_result.html' | Out-Null
        }

        'vmware_backup_staleness'{
            # Looks for a custom attribute whose NAME contains 'backup' with a parseable date value.
            $StaleDays = 3
            $stale = @(); $noMarker = @()

            Initialize-PowerCLI
            foreach ($vcenter in $vCenterList.split(",")) {
                $vcenter = $vcenter.trim()
                if (-not (Test-VCenterReachable $vcenter)) { Write-Log "Warn: $vcenter unreachable - skipping" $true; continue }
                Write-Log "vCenter: $vcenter" $true
                Connect-CvsVIServer -VCenter $vcenter
                $vcShort = Get-VCShortName $vcenter

                foreach ($vm in (Get-VM)) {
                    $ann = Get-Annotation -Entity $vm -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'backup' -and $_.Value }
                    $marker = $ann | Select-Object -First 1
                    if (-not $marker) {
                        $noMarker += [pscustomobject][ordered]@{ vCenter=$vcShort; VM=$vm.Name; PowerState=[string]$vm.PowerState }
                        continue
                    }
                    $dt = [datetime]::MinValue
                    $ok = [datetime]::TryParse([string]$marker.Value, [ref]$dt)
                    if ($ok) {
                        $age = ((Get-Date) - $dt).Days
                        if ($age -ge $StaleDays) {
                            $stale += [pscustomobject][ordered]@{ vCenter=$vcShort; VM=$vm.Name; Attribute=$marker.Name; LastBackup=$dt.ToString('yyyy-MM-dd'); AgeDays=$age }
                        }
                    } else {
                        $stale += [pscustomobject][ordered]@{ vCenter=$vcShort; VM=$vm.Name; Attribute=$marker.Name; LastBackup=[string]$marker.Value; AgeDays='unparsed' }
                    }
                }
                if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$false }
            }
            if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$false }

            $fStale = $stale    | Sort-Object AgeDays -Descending | ConvertTo-Html -Fragment
            $fNone  = $noMarker | Sort-Object vCenter,VM | ConvertTo-Html -Fragment

            $sections  = New-CvsReportSectionHtml -Title "Backup marker older than $StaleDays days" -TableHtml (Format-CvsTableHtml -Fragment ($fStale -join "`n") -Accent '#c2410c') -Accent '#c2410c'
            $sections += New-CvsReportSectionHtml -Title 'No backup marker at all' -TableHtml (Format-CvsTableHtml -Fragment ($fNone -join "`n") -Accent '#b91c1c') -Accent '#b91c1c'

            $summary = "Backup coverage inferred from a VM custom attribute whose name contains 'backup' (e.g. a Veeam 'last backup' attribute). Tune the attribute match and threshold to your backup product. The 'no marker at all' list is usually the one to act on."
            $suffix  = "$($stale.Count) stale / $($noMarker.Count) unprotected"
            Send-CvsVmwareReport -Title 'VMware Backup Staleness' -Summary $summary -Sections $sections -SubjectSuffix $suffix -ResultFileName 'vmware_backup_result.html' | Out-Null
        }

        # =====================================================================
        #  LICENSING / LIFECYCLE
        # =====================================================================
        'vmware_license_usage'{
            $ThresholdPct = 85
            $allLic = @()

            Initialize-PowerCLI
            foreach ($vcenter in $vCenterList.split(",")) {
                $vcenter = $vcenter.trim()
                if (-not (Test-VCenterReachable $vcenter)) { Write-Log "Warn: $vcenter unreachable - skipping" $true; continue }
                Write-Log "vCenter: $vcenter" $true
                Connect-CvsVIServer -VCenter $vcenter
                $vcShort = Get-VCShortName $vcenter

                $licMgr = Get-View (Get-View ServiceInstance).Content.LicenseManager
                foreach ($l in $licMgr.Licenses) {
                    if ([string]::IsNullOrEmpty($l.LicenseKey) -or $l.LicenseKey -eq '00000-00000-00000-00000-00000') { continue }
                    $total = [int]$l.Total
                    $used  = [int]$l.Used
                    $pct   = if ($total -gt 0) { [math]::Round(($used / $total) * 100, 1) } else { 0 }
                    $key   = [string]$l.LicenseKey
                    $mask  = if ($key.Length -gt 5) { '****-' + $key.Substring($key.Length - 5) } else { $key }
                    $allLic += [pscustomobject][ordered]@{
                        vCenter=$vcShort; Edition=$l.Name; Key=$mask; Used=$used; Total=$(if ($total -gt 0) { $total } else { 'unlimited' }); PercentUsed=$(if ($total -gt 0) { $pct } else { 0 })
                    }
                }
                if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$false }
            }
            if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$false }

            $over = $allLic | Where-Object { $_.Total -ne 'unlimited' -and [double]$_.PercentUsed -ge $ThresholdPct } | Sort-Object PercentUsed -Descending | ConvertTo-Html -Fragment
            $all  = $allLic | Sort-Object vCenter,Edition | ConvertTo-Html -Fragment

            $sections  = New-CvsReportSectionHtml -Title "At or above $ThresholdPct% consumed" -TableHtml (Format-CvsTableHtml -Fragment ($over -join "`n") -Accent '#b91c1c') -Accent '#b91c1c'
            $sections += New-CvsReportSectionHtml -Title 'All license keys' -TableHtml (Format-CvsTableHtml -Fragment ($all -join "`n") -Accent '#1f2937') -Accent '#1f2937'

            $summary = "Per-key license consumption versus entitlement. Boring until the day you can't add a host &mdash; anything at or above $ThresholdPct% is flagged so you can true-up before it blocks work."
            $suffix  = "$(@($allLic | Where-Object { $_.Total -ne 'unlimited' -and [double]$_.PercentUsed -ge $ThresholdPct }).Count) keys near limit"
            Send-CvsVmwareReport -Title 'VMware License Utilization' -Summary $summary -Sections $sections -SubjectSuffix $suffix -ResultFileName 'vmware_license_result.html' | Out-Null
        }

        'vmware_build_consistency'{
            $UptimeWarnDays = 180
            $allHosts = @()

            Initialize-PowerCLI
            foreach ($vcenter in $vCenterList.split(",")) {
                $vcenter = $vcenter.trim()
                if (-not (Test-VCenterReachable $vcenter)) { Write-Log "Warn: $vcenter unreachable - skipping" $true; continue }
                Write-Log "vCenter: $vcenter" $true
                Connect-CvsVIServer -VCenter $vcenter
                $vcShort = Get-VCShortName $vcenter

                foreach ($h in (Get-VMHost)) {
                    $boot = $h.ExtensionData.Summary.Runtime.BootTime
                    $up   = if ($boot) { [math]::Round(((Get-Date) - $boot).TotalDays) } else { $null }
                    $cluster = try { $h.Parent.Name } catch { '' }
                    $allHosts += [pscustomobject][ordered]@{
                        vCenter=$vcShort; Cluster=$cluster; Host=$h.Name; Version=[string]$h.Version; Build=[string]$h.Build; Connection=[string]$h.ConnectionState; UptimeDays=$up
                    }
                }
                if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$false }
            }
            if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$false }

            $mixed = $allHosts | Group-Object vCenter,Cluster | Where-Object { ($_.Group | Select-Object -ExpandProperty Build -Unique).Count -gt 1 } | ForEach-Object { $_.Name }
            $inconsistent = $allHosts | Where-Object { $mixed -contains ("$($_.vCenter), $($_.Cluster)") }

            $fMixed = $inconsistent | Sort-Object vCenter,Cluster,Build | ConvertTo-Html -Fragment
            $fAll   = $allHosts     | Sort-Object vCenter,Cluster,Host | ConvertTo-Html -Fragment

            $sections  = New-CvsReportSectionHtml -Title 'Clusters running mismatched ESXi builds' -TableHtml (Format-CvsTableHtml -Fragment ($fMixed -join "`n") -Accent '#b91c1c') -Accent '#b91c1c'
            $sections += New-CvsReportSectionHtml -Title 'All hosts (build inventory)' -TableHtml (Format-CvsTableHtml -Fragment ($fAll -join "`n") -Accent '#1f2937') -Accent '#1f2937'

            $summary = "Hosts within one cluster should run an identical ESXi build outside a patch window; anything in the first table means a host got missed."
            $suffix  = "$(@($inconsistent).Count) hosts on mismatched builds"
            Send-CvsVmwareReport -Title 'VMware ESXi Build Consistency' -Summary $summary -Sections $sections -SubjectSuffix $suffix -ResultFileName 'vmware_build_result.html' | Out-Null
        }

        # =====================================================================
        #  GUEST-LEVEL (via VMware Tools)
        # =====================================================================
        'vmware_guest_disk_free'{
            $CritPct = 5; $WarnPct = 15
            $allDisks = @()

            Initialize-PowerCLI
            foreach ($vcenter in $vCenterList.split(",")) {
                $vcenter = $vcenter.trim()
                if (-not (Test-VCenterReachable $vcenter)) { Write-Log "Warn: $vcenter unreachable - skipping" $true; continue }
                Write-Log "vCenter: $vcenter" $true
                Connect-CvsVIServer -VCenter $vcenter
                $vcShort = Get-VCShortName $vcenter

                foreach ($vm in (Get-VM | Where-Object { $_.PowerState -eq 'PoweredOn' })) {
                    foreach ($d in $vm.ExtensionData.Guest.Disk) {
                        if (-not $d.Capacity -or $d.Capacity -le 0) { continue }
                        $freePct = [math]::Round(($d.FreeSpace / $d.Capacity) * 100, 1)
                        $allDisks += [pscustomobject][ordered]@{
                            vCenter=$vcShort; VM=$vm.Name; Mount=$d.DiskPath; CapacityGB=[math]::Round($d.Capacity/1GB,1); FreeGB=[math]::Round($d.FreeSpace/1GB,1); FreePct=$freePct
                        }
                    }
                }
                if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$false }
            }
            if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$false }

            $crit = $allDisks | Where-Object { $_.FreePct -lt $CritPct } | Sort-Object FreePct | ConvertTo-Html -Fragment
            $warn = $allDisks | Where-Object { $_.FreePct -ge $CritPct -and $_.FreePct -lt $WarnPct } | Sort-Object FreePct | ConvertTo-Html -Fragment

            $sections  = New-CvsReportSectionHtml -Title "Critical &nbsp;&ndash;&nbsp; &lt; $CritPct% free" -TableHtml (Format-CvsTableHtml -Fragment ($crit -join "`n") -Accent '#b91c1c') -Accent '#b91c1c'
            $sections += New-CvsReportSectionHtml -Title "Warning &nbsp;&ndash;&nbsp; $CritPct% to $WarnPct% free" -TableHtml (Format-CvsTableHtml -Fragment ($warn -join "`n") -Accent '#c2410c') -Accent '#c2410c'

            $summary = "Guest partition free space via VMware Tools (powered-on VMs with Tools running). Catches filling guest volumes on any VM, including boxes with no monitoring agent. VMs without Tools running are not visible here."
            $suffix  = "$(@($allDisks | Where-Object { $_.FreePct -lt $WarnPct }).Count) volumes low"
            Send-CvsVmwareReport -Title 'VMware Guest Disk Free-Space Report' -Summary $summary -Sections $sections -SubjectSuffix $suffix -ResultFileName 'vmware_guestdisk_result.html' | Out-Null
        }

        'vmware_guest_os_eol'{
            $EolPatterns = @(
                'Windows XP','Windows Vista','Windows 7','Windows 8',
                'Windows Server 2003','Windows Server 2008','Windows Server 2012',
                'Red Hat Enterprise Linux 5','Red Hat Enterprise Linux 6','Red Hat Enterprise Linux 7',
                'CentOS 5','CentOS 6','CentOS 7','CentOS 8',
                'Ubuntu 14','Ubuntu 16','Ubuntu 18',
                'SUSE Linux Enterprise 11','Oracle Linux 5','Oracle Linux 6','Oracle Linux 7'
            )
            $eol = @(); $inventory = @{}

            Initialize-PowerCLI
            foreach ($vcenter in $vCenterList.split(",")) {
                $vcenter = $vcenter.trim()
                if (-not (Test-VCenterReachable $vcenter)) { Write-Log "Warn: $vcenter unreachable - skipping" $true; continue }
                Write-Log "vCenter: $vcenter" $true
                Connect-CvsVIServer -VCenter $vcenter
                $vcShort = Get-VCShortName $vcenter

                foreach ($vm in (Get-VM)) {
                    $os = [string]$vm.ExtensionData.Config.GuestFullName
                    if ([string]::IsNullOrWhiteSpace($os)) { $os = '(unknown)' }
                    if ($inventory.ContainsKey($os)) { $inventory[$os]++ } else { $inventory[$os] = 1 }
                    foreach ($pat in $EolPatterns) {
                        if ($os -like "*$pat*") {
                            $eol += [pscustomobject][ordered]@{ vCenter=$vcShort; VM=$vm.Name; GuestOS=$os; PowerState=[string]$vm.PowerState }
                            break
                        }
                    }
                }
                if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$false }
            }
            if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$false }

            $invObjs = $inventory.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object { [pscustomobject][ordered]@{ GuestOS=$_.Key; Count=$_.Value } }
            $fEol = $eol     | Sort-Object GuestOS,VM | ConvertTo-Html -Fragment
            $fInv = $invObjs | ConvertTo-Html -Fragment

            $sections  = New-CvsReportSectionHtml -Title 'VMs running EOL / EOS guest operating systems' -TableHtml (Format-CvsTableHtml -Fragment ($fEol -join "`n") -Accent '#b91c1c') -Accent '#b91c1c'
            $sections += New-CvsReportSectionHtml -Title 'Guest OS inventory (all)' -TableHtml (Format-CvsTableHtml -Fragment ($fInv -join "`n") -Accent '#1f2937') -Accent '#1f2937'

            $summary = "VMs whose configured guest OS matches a known end-of-life / end-of-support pattern &mdash; ammunition for decommission conversations and directly relevant to RMF posture. Edit the pattern list at the top of this action to match your accreditation baseline."
            $suffix  = "$($eol.Count) EOL VMs"
            Send-CvsVmwareReport -Title 'VMware Guest OS EOL Exposure' -Summary $summary -Sections $sections -SubjectSuffix $suffix -ResultFileName 'vmware_eol_result.html' | Out-Null
        }

        default {
            Write-Log "Error: unknown or missing -Action '$Action'." $true
        }

    }

    Write-Log "=== cvs_vmware_ops_reports end (Action=$Action) ===" $true
}

InitializeVariables
CertificateValidation
Main $Action
