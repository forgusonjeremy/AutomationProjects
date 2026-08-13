[CmdletBinding()]
param(
    [string]$Action,                 # accepted for playbook compatibility; not used (dedicated script)
    [string]$eMailReport = 'no',
    [string]$SMTPServer,
    [string]$MailToString,
    [string]$MailCcString,
    [string]$MailSubjectstring,
    [string]$vCenterList,
    [int]$TaskLookbackHours = 24,
    [int]$EventLookbackHours = 24,
    [int]$MaxEventSamples = 5000,
    [string]$IncludeAcknowledgedAlarms = 'yes',
    [string]$IncludeTriggeredEvents = 'yes',
    [string]$EventKeywordRegex = '(?i)(alarm|triggered|failed|failure|error|warning|critical|degraded|not responding|disconnected|lost|timeout|timed out|consolidat|snapshot)'
)

$script:ReportName = 'cvs_daily_alarm_event_rollup report'
$script:LogFileName = 'cvs_daily_alarm_event_rollup.log'

# ---- Standalone framework shims (not sourcing cvs_functions.ps1) -------------
$DebugDir = Join-Path $PSScriptRoot 'debug'
if (-not (Test-Path $DebugDir)) { New-Item -ItemType Directory -Path $DebugDir -Force | Out-Null }
$LogFile = Join-Path $DebugDir $script:LogFileName

function Write-Log {
    param([string]$Message)
    $line = ('{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message)
    $line | Out-File -FilePath $LogFile -Append -Encoding utf8
    Write-Host $line
}

function Format-CvsTableHtml {
    param(
        [string]$Fragment,
        [string]$Accent,
        [string]$EmptyText = 'None in this range.'
    )

    if ([string]::IsNullOrWhiteSpace($Fragment) -or ($Fragment -notmatch '<td')) {
        return ('<p style="margin:6px 0 20px;padding:10px 12px;background:#f9fafb;border:1px dashed #d1d5db;border-radius:4px;color:#6b7280;font-size:13px;font-family:Segoe UI,Arial,sans-serif;">' + $EmptyText + '</p>')
    }

    $t = $Fragment
    $t = $t -replace '<table>','<table cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;width:100%;margin:6px 0 20px;font-family:Segoe UI,Arial,sans-serif;font-size:13px;">'
    $t = $t -replace '<th>',('<th align="left" bgcolor="' + $Accent + '" style="background:' + $Accent + ';color:#ffffff;text-align:left;padding:9px 11px;font-weight:600;font-size:12px;white-space:nowrap;border:1px solid ' + $Accent + ';">')
    $t = $t -replace '<td>','<td style="padding:7px 11px;border:1px solid #e5e7eb;color:#111827;background:#ffffff">'
    $t = $t -replace '(<td style="[^"]+?)(">)(\s*[\d.,]+\s*)(</td>)','$1;text-align:right$2$3$4'
    $script:__zebraRow = 0
    $t = [regex]::Replace($t, '<tr>(?=\s*<td)', {
        param($m)
        $script:__zebraRow++
        if ($script:__zebraRow % 2 -eq 0) { '<tr style="background:#f9fafb">' } else { '<tr>' }
    })
    return $t
}

function Convert-RowsToStyledHtml {
    param(
        [array]$Rows,
        [string]$Accent,
        [string]$EmptyText = 'None in this range.'
    )
    if (($null -eq $Rows) -or ($Rows.Count -eq 0)) {
        return Format-CvsTableHtml -Fragment '' -Accent $Accent -EmptyText $EmptyText
    }
    $fragment = $Rows | ConvertTo-Html -Fragment
    return Format-CvsTableHtml -Fragment ($fragment -join "`n") -Accent $Accent -EmptyText $EmptyText
}

function Get-ShortVcName {
    param([string]$vCenter)
    if ([string]::IsNullOrWhiteSpace($vCenter)) { return '' }
    return ($vCenter.Trim().Split('.')[0])
}

function Test-VcenterTcp443 {
    param([string]$Server)
    $tcp = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $tcp.BeginConnect($Server, 443, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne(5000)) {
            Write-Log "  $Server unreachable on 443 (5s timeout) - skipping"
            return $false
        }
        $tcp.EndConnect($iar)
        return $true
    } catch {
        Write-Log "  $Server TCP 443 test failed: $($_.Exception.Message) - skipping"
        return $false
    } finally {
        $tcp.Close()
    }
}

function Get-SeverityRank {
    param([string]$Severity)
    switch -Regex ($Severity) {
        'red|critical|error' { return 4 }
        'yellow|warning'     { return 3 }
        'gray|unknown'       { return 2 }
        'green|normal'       { return 1 }
        default              { return 0 }
    }
}

function Get-BoolFromYesNo {
    param([string]$Value)
    return ($Value -match '(?i)^(y|yes|true|1)$')
}

function Resolve-AlarmName {
    param($AlarmMoRef)
    if ($null -eq $AlarmMoRef) { return '' }
    $key = $AlarmMoRef.Value
    if ($script:AlarmNameCache.ContainsKey($key)) { return $script:AlarmNameCache[$key] }
    try {
        $alarmView = Get-View -Id $AlarmMoRef -Property Info.Name -ErrorAction Stop
        $script:AlarmNameCache[$key] = $alarmView.Info.Name
    } catch {
        $script:AlarmNameCache[$key] = $key
    }
    return $script:AlarmNameCache[$key]
}

function Resolve-EntityName {
    param($EntityMoRef)
    if ($null -eq $EntityMoRef) { return '' }
    $key = ('{0}-{1}' -f $EntityMoRef.Type, $EntityMoRef.Value)
    if ($script:EntityNameCache.ContainsKey($key)) { return $script:EntityNameCache[$key] }
    try {
        $entityView = Get-View -Id $EntityMoRef -Property Name -ErrorAction Stop
        $script:EntityNameCache[$key] = $entityView.Name
    } catch {
        $script:EntityNameCache[$key] = $key
    }
    return $script:EntityNameCache[$key]
}

function Get-TriggeredAlarmRows {
    param(
        [string]$vCenterShortName,
        [bool]$IncludeAcknowledged
    )

    $entityTypes = @(
        'Datacenter',
        'ClusterComputeResource',
        'ComputeResource',
        'HostSystem',
        'VirtualMachine',
        'Datastore',
        'ResourcePool',
        'Folder',
        'Network',
        'VmwareDistributedVirtualSwitch',
        'DistributedVirtualSwitch',
        'DistributedVirtualPortgroup'
    )

    $dedupe = @{}

    foreach ($viewType in $entityTypes) {
        try {
            Write-Log "  Scanning triggered alarms on $viewType objects..."
            [array]$entities = Get-View -ViewType $viewType -Property Name,TriggeredAlarmState -ErrorAction SilentlyContinue
            foreach ($entity in $entities) {
                if (($null -eq $entity.TriggeredAlarmState) -or (@($entity.TriggeredAlarmState).Count -eq 0)) { continue }

                foreach ($state in @($entity.TriggeredAlarmState)) {
                    if (($state.Acknowledged -eq $true) -and (-not $IncludeAcknowledged)) { continue }

                    $alarmName = Resolve-AlarmName -AlarmMoRef $state.Alarm
                    $entityName = if ([string]::IsNullOrWhiteSpace($entity.Name)) { Resolve-EntityName -EntityMoRef $state.Entity } else { $entity.Name }
                    $severity = if ($state.OverallStatus) { $state.OverallStatus.ToString() } else { 'unknown' }
                    $triggerTime = if ($state.Time) { [datetime]$state.Time } else { $null }
                    $ackTime = if ($state.AcknowledgedTime) { [datetime]$state.AcknowledgedTime } else { $null }
                    $dedupeKey = ('{0}|{1}|{2}|{3}' -f $vCenterShortName, $state.Entity.Value, $state.Alarm.Value, $severity)

                    $row = [pscustomobject][ordered]@{
                        'vCenter'       = $vCenterShortName
                        'Severity'      = $severity
                        'Alarm'         = $alarmName
                        'Entity'        = $entityName
                        'EntityType'    = $viewType
                        'TriggeredTime' = if ($triggerTime) { $triggerTime.ToString('yyyy-MM-dd HH:mm:ss') } else { '' }
                        'Acknowledged'  = if ($state.Acknowledged) { 'Yes' } else { 'No' }
                        'AckBy'         = if ($state.AcknowledgedByUser) { $state.AcknowledgedByUser } else { '' }
                        'AckTime'       = if ($ackTime) { $ackTime.ToString('yyyy-MM-dd HH:mm:ss') } else { '' }
                        '_SeverityRank' = Get-SeverityRank $severity
                        '_TriggeredDt'  = $triggerTime
                    }

                    if (-not $dedupe.ContainsKey($dedupeKey)) {
                        $dedupe[$dedupeKey] = $row
                    } else {
                        $existing = $dedupe[$dedupeKey]
                        if (($row._SeverityRank -gt $existing._SeverityRank) -or (($row._SeverityRank -eq $existing._SeverityRank) -and ($row._TriggeredDt -gt $existing._TriggeredDt))) {
                            $dedupe[$dedupeKey] = $row
                        }
                    }
                }
            }
        } catch {
            Write-Log "    Alarm scan failed for $viewType : $($_.Exception.Message)"
        }
    }

    return @($dedupe.Values)
}

function Get-TaskDescription {
    param($Info)
    if ($Info.Description -and $Info.Description.Message) { return $Info.Description.Message }
    if ($Info.DescriptionId) { return $Info.DescriptionId }
    if ($Info.Name) { return $Info.Name }
    return 'Unknown task'
}

function Get-TaskErrorText {
    param($Info)
    if ($Info.Error -and $Info.Error.LocalizedMessage) { return $Info.Error.LocalizedMessage }
    if ($Info.Error -and $Info.Error.FaultMessage -and @($Info.Error.FaultMessage).Count -gt 0) {
        return ((@($Info.Error.FaultMessage) | ForEach-Object { $_.Message }) -join '; ')
    }
    return ''
}

function Get-RecentFailedTaskRows {
    param(
        [string]$vCenterShortName,
        [datetime]$Cutoff
    )

    [array]$rawRows = @()

    try {
        $serviceInstance = Get-View ServiceInstance -ErrorAction Stop
        $taskMgr = Get-View -Id $serviceInstance.Content.TaskManager -Property RecentTask -ErrorAction Stop
        if (($null -eq $taskMgr.RecentTask) -or (@($taskMgr.RecentTask).Count -eq 0)) { return @() }

        Write-Log "  Reading recent tasks from TaskManager..."
        foreach ($taskRef in @($taskMgr.RecentTask)) {
            try {
                $task = Get-View -Id $taskRef -Property Info -ErrorAction SilentlyContinue
                if ($null -eq $task) { continue }
                $info = $task.Info
                if ($null -eq $info) { continue }
                $state = if ($info.State) { $info.State.ToString() } else { '' }
                if ($state -notmatch '^(?i:error)$') { continue }

                $startTime = if ($info.StartTime) { [datetime]$info.StartTime } else { $null }
                $completeTime = if ($info.CompleteTime) { [datetime]$info.CompleteTime } else { $null }
                $compareTime = if ($completeTime) { $completeTime } elseif ($startTime) { $startTime } else { $null }
                if (($null -ne $compareTime) -and ($compareTime -lt $Cutoff)) { continue }

                $taskName = Get-TaskDescription -Info $info
                $errorText = Get-TaskErrorText -Info $info
                $entityName = if ($info.EntityName) { $info.EntityName } else { '' }
                $userName = ''
                try { if ($info.Reason -and $info.Reason.UserName) { $userName = $info.Reason.UserName } } catch { $userName = '' }

                $rawRows += [pscustomobject][ordered]@{
                    'vCenter'      = $vCenterShortName
                    'Task'         = $taskName
                    'Entity'       = $entityName
                    'User'         = $userName
                    'Error'        = $errorText
                    'StartTime'    = if ($startTime) { $startTime.ToString('yyyy-MM-dd HH:mm:ss') } else { '' }
                    'CompleteTime' = if ($completeTime) { $completeTime.ToString('yyyy-MM-dd HH:mm:ss') } else { '' }
                    '_SortTime'    = $compareTime
                    '_DedupeKey'   = ('{0}|{1}|{2}|{3}' -f $vCenterShortName, $taskName, $entityName, $errorText)
                }
            } catch {
                Write-Log "    Failed reading task view: $($_.Exception.Message)"
            }
        }
    } catch {
        Write-Log "  TaskManager query failed: $($_.Exception.Message)"
    }

    [array]$deduped = @()
    foreach ($group in ($rawRows | Group-Object -Property _DedupeKey)) {
        $items = @($group.Group)
        $firstItem = $items | Sort-Object -Property _SortTime | Select-Object -First 1
        $lastItem = $items | Sort-Object -Property _SortTime -Descending | Select-Object -First 1
        $users = (($items | Where-Object { -not [string]::IsNullOrWhiteSpace($_.User) } | Select-Object -ExpandProperty User -Unique) -join ', ')
        $deduped += [pscustomobject][ordered]@{
            'vCenter'   = $firstItem.vCenter
            'Count'     = $items.Count
            'Task'      = $firstItem.Task
            'Entity'    = $firstItem.Entity
            'Users'     = $users
            'FirstSeen' = if ($firstItem._SortTime) { ([datetime]$firstItem._SortTime).ToString('yyyy-MM-dd HH:mm:ss') } else { '' }
            'LastSeen'  = if ($lastItem._SortTime) { ([datetime]$lastItem._SortTime).ToString('yyyy-MM-dd HH:mm:ss') } else { '' }
            'Error'     = $firstItem.Error
        }
    }

    return @($deduped | Sort-Object -Property LastSeen -Descending)
}

function Get-EventEntityName {
    param($Event)
    try { if ($Event.Vm -and $Event.Vm.Name) { return $Event.Vm.Name } } catch {}
    try { if ($Event.Host -and $Event.Host.Name) { return $Event.Host.Name } } catch {}
    try { if ($Event.Ds -and $Event.Ds.Name) { return $Event.Ds.Name } } catch {}
    try { if ($Event.Net -and $Event.Net.Name) { return $Event.Net.Name } } catch {}
    try { if ($Event.ComputeResource -and $Event.ComputeResource.Name) { return $Event.ComputeResource.Name } } catch {}
    try { if ($Event.Datacenter -and $Event.Datacenter.Name) { return $Event.Datacenter.Name } } catch {}
    return ''
}

function Get-EventSeverityFromMessage {
    param([string]$TypeName, [string]$Message)
    $s = ($TypeName + ' ' + $Message)
    if ($s -match '(?i)(critical|red|error|failed|failure|not responding|disconnected|lost|timeout|timed out)') { return 'Error' }
    if ($s -match '(?i)(warning|yellow|alarm|triggered|degraded|consolidat|snapshot)') { return 'Warning' }
    return 'Info'
}

function Get-TriggeredEventRows {
    param(
        [string]$vCenterShortName,
        [datetime]$Cutoff,
        [int]$MaxSamples,
        [string]$KeywordRegex
    )

    [array]$rawRows = @()

    try {
        Write-Log "  Reading VI events since $($Cutoff.ToString('yyyy-MM-dd HH:mm:ss')) with MaxSamples=$MaxSamples..."
        [array]$events = Get-VIEvent -Start $Cutoff -MaxSamples $MaxSamples -ErrorAction SilentlyContinue
        foreach ($event in $events) {
            $typeName = $event.GetType().Name
            $message = if ($event.FullFormattedMessage) { $event.FullFormattedMessage } else { '' }
            if (($typeName -notmatch '(?i)(Alarm|Failed|Error|Warning|Timeout|Timedout)') -and ($message -notmatch $KeywordRegex)) { continue }

            $created = if ($event.CreatedTime) { [datetime]$event.CreatedTime } else { $null }
            $entityName = Get-EventEntityName -Event $event
            $severity = Get-EventSeverityFromMessage -TypeName $typeName -Message $message
            $userName = if ($event.UserName) { $event.UserName } else { '' }
            $dedupeMessage = $message
            if ($dedupeMessage.Length -gt 250) { $dedupeMessage = $dedupeMessage.Substring(0,250) }

            $rawRows += [pscustomobject][ordered]@{
                'vCenter'    = $vCenterShortName
                'Severity'   = $severity
                'EventType'  = $typeName
                'Entity'     = $entityName
                'User'       = $userName
                'Created'    = if ($created) { $created.ToString('yyyy-MM-dd HH:mm:ss') } else { '' }
                'Message'    = $message
                '_SortTime'  = $created
                '_DedupeKey' = ('{0}|{1}|{2}|{3}' -f $vCenterShortName, $severity, $typeName, $dedupeMessage)
            }
        }
    } catch {
        Write-Log "  VI event query failed: $($_.Exception.Message)"
    }

    [array]$deduped = @()
    foreach ($group in ($rawRows | Group-Object -Property _DedupeKey)) {
        $items = @($group.Group)
        $firstItem = $items | Sort-Object -Property _SortTime | Select-Object -First 1
        $lastItem = $items | Sort-Object -Property _SortTime -Descending | Select-Object -First 1
        $entities = (($items | Where-Object { -not [string]::IsNullOrWhiteSpace($_.Entity) } | Select-Object -ExpandProperty Entity -Unique | Select-Object -First 8) -join ', ')
        $users = (($items | Where-Object { -not [string]::IsNullOrWhiteSpace($_.User) } | Select-Object -ExpandProperty User -Unique | Select-Object -First 8) -join ', ')
        $deduped += [pscustomobject][ordered]@{
            'vCenter'   = $firstItem.vCenter
            'Severity'  = $firstItem.Severity
            'Count'     = $items.Count
            'EventType' = $firstItem.EventType
            'Entities'  = $entities
            'Users'     = $users
            'FirstSeen' = if ($firstItem._SortTime) { ([datetime]$firstItem._SortTime).ToString('yyyy-MM-dd HH:mm:ss') } else { '' }
            'LastSeen'  = if ($lastItem._SortTime) { ([datetime]$lastItem._SortTime).ToString('yyyy-MM-dd HH:mm:ss') } else { '' }
            'Message'   = $firstItem.Message
        }
    }

    return @($deduped | Sort-Object @{Expression={ if ($_.Severity -eq 'Error') { 2 } elseif ($_.Severity -eq 'Warning') { 1 } else { 0 } }; Descending=$true}, @{Expression='LastSeen'; Descending=$true})
}

$MailFrom = 'user5@dom3.example'
[array]$allAlarmRows = @()
[array]$allTaskRows = @()
[array]$allEventRows = @()
$script:AlarmNameCache = @{}
$script:EntityNameCache = @{}

$now = Get-Date
$taskCutoff = $now.AddHours(-1 * $TaskLookbackHours)
$eventCutoff = $now.AddHours(-1 * $EventLookbackHours)
$includeAck = Get-BoolFromYesNo $IncludeAcknowledgedAlarms
$includeEvents = Get-BoolFromYesNo $IncludeTriggeredEvents

Write-Log "=== $script:ReportName start (Action=$Action) ==="
Write-Log "Thresholds: TaskLookbackHours=$TaskLookbackHours EventLookbackHours=$EventLookbackHours MaxEventSamples=$MaxEventSamples IncludeAcknowledgedAlarms=$IncludeAcknowledgedAlarms IncludeTriggeredEvents=$IncludeTriggeredEvents"

if ([string]::IsNullOrEmpty($env:VC_USER) -or [string]::IsNullOrEmpty($env:VC_PASS)) {
    Write-Log "ERROR: VC_USER/VC_PASS not present in environment - vault creds not delivered by the task. Aborting."
    exit 1
}
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
    if (-not (Test-VcenterTcp443 -Server $vcenter)) { continue }

    try {
        Write-Log "  Connecting to $vcenter..."
        Connect-VIServer -Server $vcenter -Credential $vcCred -Force -WarningAction 0 -ErrorAction Stop | Out-Null
        Write-Log "  Connected. Gathering active alarms, failed tasks, and triggered events."

        $allAlarmRows += Get-TriggeredAlarmRows -vCenterShortName $vcShort -IncludeAcknowledged $includeAck
        $allTaskRows += Get-RecentFailedTaskRows -vCenterShortName $vcShort -Cutoff $taskCutoff
        if ($includeEvents) {
            $allEventRows += Get-TriggeredEventRows -vCenterShortName $vcShort -Cutoff $eventCutoff -MaxSamples $MaxEventSamples -KeywordRegex $EventKeywordRegex
        }
    } catch {
        Write-Log "  ERROR processing ${vcenter}: $($_.Exception.Message)"
    } finally {
        if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$False }
    }
}

if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$False }

# Remove internal helper columns before reporting/exporting.
$alarmReportRows = @($allAlarmRows | Sort-Object @{Expression='_SeverityRank'; Descending=$true}, @{Expression='Acknowledged'; Descending=$false}, @{Expression='_TriggeredDt'; Descending=$true} | Select-Object vCenter,Severity,Alarm,Entity,EntityType,TriggeredTime,Acknowledged,AckBy,AckTime)
$unackedCriticalAlarms = @($alarmReportRows | Where-Object { $_.Acknowledged -eq 'No' -and ($_.Severity -match '(?i)red|critical|error') })
$unackedWarningAlarms = @($alarmReportRows | Where-Object { $_.Acknowledged -eq 'No' -and ($_.Severity -notmatch '(?i)red|critical|error') })
$ackAlarms = @($alarmReportRows | Where-Object { $_.Acknowledged -eq 'Yes' })
$taskReportRows = @($allTaskRows | Sort-Object -Property LastSeen -Descending | Select-Object vCenter,Count,Task,Entity,Users,FirstSeen,LastSeen,Error)
$eventReportRows = @($allEventRows | Sort-Object @{Expression={ if ($_.Severity -eq 'Error') { 2 } elseif ($_.Severity -eq 'Warning') { 1 } else { 0 } }; Descending=$true}, @{Expression='LastSeen'; Descending=$true} | Select-Object vCenter,Severity,Count,EventType,Entities,Users,FirstSeen,LastSeen,Message)

Write-Log "Collection complete. ActiveAlarms=$($alarmReportRows.Count) FailedTaskGroups=$($taskReportRows.Count) TriggeredEventGroups=$($eventReportRows.Count)"

$csvAlarmFile = Join-Path $DebugDir 'daily_active_alarm_rollup.csv'
$csvTaskFile = Join-Path $DebugDir 'daily_failed_task_rollup.csv'
$csvEventFile = Join-Path $DebugDir 'daily_triggered_event_rollup.csv'
$alarmReportRows | Export-Csv -NoTypeInformation -Path $csvAlarmFile -Encoding utf8
$taskReportRows | Export-Csv -NoTypeInformation -Path $csvTaskFile -Encoding utf8
$eventReportRows | Export-Csv -NoTypeInformation -Path $csvEventFile -Encoding utf8
Write-Log "CSV written: $csvAlarmFile"
Write-Log "CSV written: $csvTaskFile"
Write-Log "CSV written: $csvEventFile"

$tblUnackedCritical = Convert-RowsToStyledHtml -Rows $unackedCriticalAlarms -Accent '#b91c1c' -EmptyText 'No unacknowledged red/critical active alarms were found.'
$tblUnackedWarning  = Convert-RowsToStyledHtml -Rows $unackedWarningAlarms  -Accent '#c2410c' -EmptyText 'No unacknowledged warning/other active alarms were found.'
$tblAckAlarms       = Convert-RowsToStyledHtml -Rows $ackAlarms           -Accent '#4b5563' -EmptyText 'No acknowledged active alarms were found.'
$tblTasks           = Convert-RowsToStyledHtml -Rows $taskReportRows     -Accent '#7f1d1d' -EmptyText "No failed tasks were found in the last $TaskLookbackHours hours."
$tblEvents          = Convert-RowsToStyledHtml -Rows $eventReportRows    -Accent '#92400e' -EmptyText "No matching warning/error/triggered events were found in the last $EventLookbackHours hours."

$reportTime = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$alert_title = "$($unackedCriticalAlarms.Count) critical alarms | $($alarmReportRows.Count) active alarms | $($taskReportRows.Count) failed task groups | $($eventReportRows.Count) event groups"

$body = @"
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;-webkit-text-size-adjust:100%;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="1100" cellpadding="0" cellspacing="0" style="max-width:1100px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      <tr><td style="background:#1f2937;padding:20px 28px;font-family:Segoe UI,Arial,sans-serif;color:#ffffff;font-size:19px;font-weight:700;">Daily vCenter Alarm / Triggered-Event Rollup</td></tr>
      <tr><td style="padding:18px 28px 4px;font-family:Segoe UI,Arial,sans-serif;color:#374151;font-size:13px;line-height:1.5;">
        This daily digest lists deduped <b>active vCenter alarms</b>, recent <b>failed tasks</b>, and matching <b>warning/error/triggered events</b> so issues do not get buried in the vCenter Events tab. Failed tasks look back <b>$TaskLookbackHours hours</b>; triggered events look back <b>$EventLookbackHours hours</b> with a maximum of <b>$MaxEventSamples</b> samples per vCenter.
      </td></tr>
      <tr><td style="padding:8px 28px 4px;">
        <div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:700;color:#b91c1c;margin:14px 0 0;padding-bottom:6px;border-bottom:2px solid #b91c1c;">&#9679; Unacknowledged critical/red active alarms</div>
        $tblUnackedCritical

        <div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:700;color:#c2410c;margin:14px 0 0;padding-bottom:6px;border-bottom:2px solid #c2410c;">&#9679; Unacknowledged warning/other active alarms</div>
        $tblUnackedWarning

        <div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:700;color:#7f1d1d;margin:14px 0 0;padding-bottom:6px;border-bottom:2px solid #7f1d1d;">&#9679; Failed task rollup &nbsp;&ndash;&nbsp; last $TaskLookbackHours hours</div>
        $tblTasks

        <div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:700;color:#92400e;margin:14px 0 0;padding-bottom:6px;border-bottom:2px solid #92400e;">&#9679; Triggered warning/error event rollup &nbsp;&ndash;&nbsp; last $EventLookbackHours hours</div>
        $tblEvents

        <div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:700;color:#4b5563;margin:14px 0 0;padding-bottom:6px;border-bottom:2px solid #4b5563;">&#9679; Acknowledged active alarms still present</div>
        $tblAckAlarms
      </td></tr>
      <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 28px;font-family:Segoe UI,Arial,sans-serif;color:#6b7280;font-size:11px;line-height:1.5;">
        Automated report generated by cvs_daily_alarm_event_rollup.ps1 via Ansible &bull; $reportTime &bull; Active alarms: $($alarmReportRows.Count) &bull; Failed task groups: $($taskReportRows.Count) &bull; Triggered event groups: $($eventReportRows.Count)
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>
"@

$resultFile = Join-Path $DebugDir 'result.html'
$body | Out-File -FilePath $resultFile -Encoding utf8
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

Write-Log "=== $script:ReportName end ==="
