[CmdletBinding()]
param(
    [string]$Action,                
    [string]$eMailReport = 'no',
    [string]$SMTPServer,
    [string]$MailToString,
    [string]$MailCcString,
    [string]$MailSubjectstring,
    [string]$vCenterList,
    [decimal]$MinimumDiskGB = 1,
    [string]$DatastoreNameRegex = '.*',
    [int]$EventSearchBackDays = 365,
    [int]$EventMaxSamples = 100000
)

$script:ReportName = 'cvs_orphaned_vmdks datastore reclaim report'
$script:LogFileName = 'cvs_orphaned_vmdks.log'

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

# ---- Email formatting helper (presentation only) ----------------------------
function Format-CvsTableHtml {
    param([string]$Fragment,[string]$Accent,[string]$EmptyText = 'None in this range.')
    if ([string]::IsNullOrWhiteSpace($Fragment) -or ($Fragment -notmatch '<td')) {
        return ('<p style="margin:6px 0 20px;padding:10px 12px;background:#f9fafb;border:1px dashed #d1d5db;border-radius:4px;color:#6b7280;font-size:13px;font-family:Segoe UI,Arial,sans-serif;">' + $EmptyText + '</p>')
    }
    $t = $Fragment
    $t = $t -replace '<table>','<table cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;width:100%;margin:6px 0 20px;font-family:Segoe UI,Arial,sans-serif;font-size:13px;">'
    $t = $t -replace '<th>',('<th align="left" bgcolor="' + $Accent + '" style="background:' + $Accent + ';color:#ffffff;text-align:left;padding:9px 11px;font-weight:600;font-size:12px;white-space:nowrap;border:1px solid ' + $Accent + ';">')
    $t = $t -replace '<td>','<td style="padding:7px 11px;border:1px solid #e5e7eb;color:#111827;background:#ffffff">'
    $t = $t -replace '(<td style="[^"]+?)(">)(\s*[\d.,]+\s*)(</td>)','$1;text-align:right$2$3$4'
    $script:__zebraRow = 0
    $t = [regex]::Replace($t, '<tr>(?=\s*<td)', { param($m) $script:__zebraRow++; if ($script:__zebraRow % 2 -eq 0) { '<tr style="background:#f9fafb">' } else { '<tr>' } })
    return $t
}

function Convert-RowsToStyledHtml {
    param([array]$Rows,[string]$Accent,[string]$EmptyText = 'None in this range.')
    if (($null -eq $Rows) -or ($Rows.Count -eq 0)) { return Format-CvsTableHtml -Fragment '' -Accent $Accent -EmptyText $EmptyText }
    $fragment = $Rows | ConvertTo-Html -Fragment
    return Format-CvsTableHtml -Fragment ($fragment -join "`n") -Accent $Accent -EmptyText $EmptyText
}


function Convert-RowsToCompactHtml {
    param([array]$Rows,[string]$Accent,[string]$EmptyText = 'None in this range.')
    if (($null -eq $Rows) -or ($Rows.Count -eq 0)) {
        return ('<p style="display:inline-block;margin:2px 0 6px;padding:4px 6px;background:#f9fafb;border:1px dashed #d1d5db;border-radius:4px;color:#6b7280;font-size:12px;font-family:Segoe UI,Arial,sans-serif;line-height:1.15;">' + $EmptyText + '</p>')
    }
    $fragment = $Rows | ConvertTo-Html -Fragment
    $t = ($fragment -join "`n")
    $t = $t -replace '<table>','<table cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;width:auto;margin:2px 0 6px;font-family:Segoe UI,Arial,sans-serif;font-size:12px;line-height:1.15;mso-table-lspace:0pt;mso-table-rspace:0pt;">'
    $t = $t -replace '<th>',('<th align="left" bgcolor="' + $Accent + '" style="background:' + $Accent + ';color:#ffffff;text-align:left;padding:4px 6px;font-weight:600;font-size:11px;white-space:nowrap;border:1px solid ' + $Accent + ';">')
    $t = $t -replace '<td>','<td style="padding:4px 6px;border:1px solid #e5e7eb;color:#111827;background:#ffffff;line-height:1.15;white-space:nowrap;">'
    $t = $t -replace '(<td style="[^"]+?)(">)(\s*[\d.,]+\s*)(</td>)','$1;text-align:right$2$3$4'
    return $t
}

function Get-ShortVcName { param([string]$vCenter) if ([string]::IsNullOrWhiteSpace($vCenter)) { return '' } return ($vCenter.Trim().Split('.')[0]) }

function Test-VcenterTcp443 {
    param([string]$Server)
    $tcp = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $tcp.BeginConnect($Server, 443, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne(5000)) { Write-Log "  $Server unreachable on 443 (5s timeout) - skipping"; return $false }
        $tcp.EndConnect($iar); return $true
    } catch { Write-Log "  $Server TCP 443 test failed: $($_.Exception.Message) - skipping"; return $false }
    finally { $tcp.Close() }
}

function Wait-VimTaskResult {
    param($TaskMoRef)
    $taskView = Get-View $TaskMoRef
    while ($taskView.Info.State -eq 'running' -or $taskView.Info.State -eq 'queued') {
        Start-Sleep -Seconds 2
        $taskView.UpdateViewData('Info.State','Info.Error','Info.Result')
    }
    if ($taskView.Info.State -eq 'error') { throw $taskView.Info.Error.LocalizedMessage }
    return $taskView.Info.Result
}

function Get-VmdkPartsFromVmPath {
    param([string]$FullPath)
    if ($FullPath -notmatch '^\[(?<ds>[^\]]+)\]\s*(?<rel>.+)$') { return $null }
    $dsName = $matches.ds.Trim()
    $rel = ($matches.rel -replace '\\','/').TrimStart('/')
    $fileName = Split-Path $rel -Leaf
    $folder = ($rel.Substring(0, [Math]::Max(0, $rel.Length - $fileName.Length))).TrimEnd('/')
    return [pscustomobject]@{ Datastore = $dsName; Folder = $folder; FileName = $fileName; RelativePath = $rel }
}

function Get-VmdkBaseName {
    param([string]$FileName)
    $base = $FileName -replace '(?i)\.vmdk$',''
    $base = $base -replace '(?i)-flat$',''
    $base = $base -replace '(?i)-ctk$',''
    $base = $base -replace '(?i)-delta$',''
    $base = $base -replace '(?i)-sesparse$',''
    return $base
}

function Get-VmdkKey {
    param([string]$Datastore,[string]$Folder,[string]$FileName)
    $base = Get-VmdkBaseName -FileName $FileName
    $folderNorm = (($Folder -replace '\\','/').Trim('/')).ToLowerInvariant()
    $baseNorm = $base.ToLowerInvariant()
    if ($folderNorm) { return ("{0}|{1}/{2}" -f $Datastore.ToLowerInvariant(),$folderNorm,$baseNorm) }
    return ("{0}|{1}" -f $Datastore.ToLowerInvariant(),$baseNorm)
}

function Get-VmdkEventAction {
    param([string]$Message,[string]$EventType)

    if ([string]::IsNullOrWhiteSpace($Message)) { return $EventType }
    switch -Regex ($Message) {
        '(?i)deployed from template'        { return 'Deployed from template' }
        '(?i)cloned virtual machine|clone'  { return 'VM cloned' }
        '(?i)created virtual machine'       { return 'VM created' }
        '(?i)created virtual disk|create.*virtual disk' { return 'Virtual disk created' }
        '(?i)added.*hard disk|added.*disk'  { return 'Hard disk added' }
        '(?i)reconfigured virtual machine'  { return 'VM reconfigured' }
        '(?i)relocated virtual machine|storage vmotion|migrated' { return 'VM relocated/migrated' }
        '(?i)removed virtual machine'       { return 'VM removed from inventory' }
        '(?i)deleted virtual machine'       { return 'VM deleted' }
        default                            { return $EventType }
    }
}

function Get-VmdkEventUserSource {
    param([string]$UserName)

    if ([string]::IsNullOrWhiteSpace($UserName)) { return 'Unknown' }
    if ($UserName -match '(?i)(^svc|\\svc|service|ansible|vra|vro|backup|veeam|commvault|netbackup|rubrik|cohesity|avamar|automation|administrator@vsphere\.local)') {
        return 'Service/Automation account'
    }
    return 'User account'
}

function Get-VmdkEventVmName {
    param($Event,[string]$Folder,[string]$DiskRoot)

    try {
        if ($Event.Vm -and -not [string]::IsNullOrWhiteSpace($Event.Vm.Name)) { return $Event.Vm.Name }
    } catch { }

    if (-not [string]::IsNullOrWhiteSpace($Folder)) {
        $folderLeaf = Split-Path (($Folder -replace '\\','/').Trim('/')) -Leaf
        if (-not [string]::IsNullOrWhiteSpace($folderLeaf)) { return $folderLeaf }
    }

    if (-not [string]::IsNullOrWhiteSpace($DiskRoot)) { return ($DiskRoot -replace '(_\d+)$','') }
    return ''
}

function Find-VmdkCreationEvent {
    param(
        [array]$Events,
        [string]$DiskRoot,
        [string]$Folder,
        [array]$FileNames,
        [datetime]$LastModified
    )

    $emptyResult = [pscustomobject][ordered]@{
        CreatedByUser       = 'Unknown'
        CreatedEventTime    = ''
        CreatedAction       = 'Unknown'
        CreatedEventMessage = 'No matching vCenter event found within retention window'
        CreatedEventAgeDays = ''
        CreatedBySource     = 'Unknown'
        MatchedEventType    = 'Unknown'
        MatchedVMName       = if (-not [string]::IsNullOrWhiteSpace($Folder)) { Split-Path (($Folder -replace '\\','/').Trim('/')) -Leaf } else { '' }
        MatchedVMFolder     = $Folder
        Confidence          = 'No event found'
        OwnerLookupNotes    = 'No matching vCenter task/event was found. vCenter event retention may not go back far enough.'
    }

    if (($null -eq $Events) -or ($Events.Count -eq 0)) { return $emptyResult }

    $terms = New-Object 'System.Collections.Generic.List[string]'
    foreach ($name in @($FileNames)) {
        if (-not [string]::IsNullOrWhiteSpace($name)) {
            [void]$terms.Add($name)
            [void]$terms.Add(($name -replace '(?i)-flat\.vmdk$','.vmdk'))
            [void]$terms.Add(($name -replace '(?i)-delta\.vmdk$','.vmdk'))
            [void]$terms.Add(($name -replace '(?i)-sesparse\.vmdk$','.vmdk'))
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($DiskRoot)) { [void]$terms.Add($DiskRoot) }
    if (-not [string]::IsNullOrWhiteSpace($Folder)) {
        [void]$terms.Add($Folder)
        $folderLeaf = Split-Path (($Folder -replace '\\','/').Trim('/')) -Leaf
        if (-not [string]::IsNullOrWhiteSpace($folderLeaf)) { [void]$terms.Add($folderLeaf) }
    }

    $terms = @($terms | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
    if ($terms.Count -eq 0) { return $emptyResult }

    $creationPattern = '(?i)(created virtual disk|create.*virtual disk|added.*hard disk|added.*disk|reconfigured virtual machine|created virtual machine|cloned virtual machine|deployed from template|relocated virtual machine|storage vmotion|migrated|removed virtual machine|deleted virtual machine)'

    $matches = foreach ($event in @($Events)) {
        $msg = [string]$event.FullFormattedMessage
        if ([string]::IsNullOrWhiteSpace($msg)) { continue }

        $matchedTerm = $null
        foreach ($term in $terms) {
            if ($msg -match [regex]::Escape($term)) { $matchedTerm = $term; break }
        }
        if ($matchedTerm) {
            $exactFileMatch = $false
            foreach ($fileName in @($FileNames)) {
                if (-not [string]::IsNullOrWhiteSpace($fileName) -and $msg -match [regex]::Escape($fileName)) {
                    $exactFileMatch = $true
                    break
                }
            }

            [pscustomobject]@{
                Event          = $event
                Message        = $msg
                MatchedTerm    = $matchedTerm
                ExactFileMatch = $exactFileMatch
                IsCreateLike   = ($msg -match $creationPattern)
            }
        }
    }

    $matches = @($matches)
    if ($matches.Count -eq 0) { return $emptyResult }

    $selected = $matches |
        Sort-Object @{Expression='ExactFileMatch';Descending=$true},
                    @{Expression='IsCreateLike';Descending=$true},
                    @{Expression={ $_.Event.CreatedTime };Descending=$true} |
        Select-Object -First 1

    $matchedEvent = $selected.Event
    $eventType = $matchedEvent.GetType().Name
    $eventTime = $matchedEvent.CreatedTime
    $eventAgeDays = ''
    if ($eventTime) { $eventAgeDays = [int]((Get-Date) - $eventTime).TotalDays }

    $confidence = if ($selected.ExactFileMatch -and $selected.IsCreateLike) {
        'Exact event match'
    } elseif ($selected.ExactFileMatch) {
        'Exact file name event match'
    } elseif ($selected.IsCreateLike) {
        'Folder/name creation event match'
    } else {
        'Folder/name event match'
    }

    return [pscustomobject][ordered]@{
        CreatedByUser       = if ([string]::IsNullOrWhiteSpace($matchedEvent.UserName)) { 'Unknown' } else { $matchedEvent.UserName }
        CreatedEventTime    = if ($eventTime) { $eventTime.ToString('yyyy-MM-dd HH:mm:ss') } else { '' }
        CreatedAction       = Get-VmdkEventAction -Message $selected.Message -EventType $eventType
        CreatedEventMessage = ($selected.Message -replace '\s+',' ').Trim()
        CreatedEventAgeDays = $eventAgeDays
        CreatedBySource     = Get-VmdkEventUserSource -UserName $matchedEvent.UserName
        MatchedEventType    = $eventType
        MatchedVMName       = Get-VmdkEventVmName -Event $matchedEvent -Folder $Folder -DiskRoot $DiskRoot
        MatchedVMFolder     = $Folder
        Confidence          = $confidence
        OwnerLookupNotes    = "Matched on term [$($selected.MatchedTerm)]. Event search window: last $EventSearchBackDays days."
    }
}

$MailFrom = $env:COMPUTERNAME + 'user6@dom3.example'
Set-Variable BYTES_IN_GB -Option Constant -Value ([int64]1073741824) -Visibility Private
[array]$allResults = @()

Write-Log "=== $script:ReportName start (Action=$Action) ==="

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
    Write-Log "vCenter: $vcenter"
    if (-not (Test-VcenterTcp443 -Server $vcenter)) { continue }

    try {
        Write-Log "  Connecting to $vcenter..."
        Connect-VIServer -Server $vcenter -Credential $vcCred -Force -WarningAction 0 -ErrorAction Stop | Out-Null
        Write-Log "  Connected. Loading vCenter events for VMDK owner lookup."
        [array]$vmdkLookupEvents = @()
        try {
            $eventStart = (Get-Date).AddDays(-1 * [Math]::Abs($EventSearchBackDays))
            $vmdkLookupEvents = @(Get-VIEvent -Start $eventStart -MaxSamples $EventMaxSamples -ErrorAction Stop | Where-Object {
                $_.FullFormattedMessage -match '(?i)(virtual disk|hard disk|vmdk|created virtual machine|cloned virtual machine|deployed from template|reconfigured virtual machine|relocated virtual machine|storage vmotion|migrated|removed virtual machine|deleted virtual machine)'
            })
            Write-Log "  Loaded $($vmdkLookupEvents.Count) candidate vCenter events from the last $EventSearchBackDays days."
        } catch {
            Write-Log "  WARN: Unable to load vCenter events for owner lookup: $($_.Exception.Message). Owner fields will show Unknown."
            $vmdkLookupEvents = @()
        }

        Write-Log "  Building registered VM VMDK inventory from LayoutEx."

        $registeredKeys = New-Object 'System.Collections.Generic.HashSet[string]'
        $vmViews = Get-View -ViewType VirtualMachine -Property Name,LayoutEx.File
        foreach ($vmView in $vmViews) {
            foreach ($vmFile in @($vmView.LayoutEx.File)) {
                if ($null -eq $vmFile -or [string]::IsNullOrWhiteSpace($vmFile.Name)) { continue }
                if ($vmFile.Name -notmatch '(?i)\.vmdk$') { continue }
                $parts = Get-VmdkPartsFromVmPath -FullPath $vmFile.Name
                if ($null -eq $parts) { continue }
                [void]$registeredKeys.Add((Get-VmdkKey -Datastore $parts.Datastore -Folder $parts.Folder -FileName $parts.FileName))
            }
        }
        Write-Log "  Registered VMDK key count: $($registeredKeys.Count)"

        $datastores = Get-View -ViewType Datastore -Property Name,Summary,Browser | Where-Object {
            $_.Summary.Accessible -eq $true -and $_.Name -match $DatastoreNameRegex
        }
        Write-Log "  Datastores to scan: $($datastores.Count)"

        foreach ($ds in $datastores) {
            Write-Log "    Scanning datastore [$($ds.Name)] for VMDKs..."
            try {
                $browser = Get-View $ds.Browser
                $spec = New-Object VMware.Vim.HostDatastoreBrowserSearchSpec
                $spec.MatchPattern = @('*.vmdk')
                $spec.Details = New-Object VMware.Vim.FileQueryFlags
                $spec.Details.FileSize = $true
                $spec.Details.FileType = $true
                $spec.Details.Modification = $true

                $taskMoRef = $browser.SearchDatastoreSubFolders_Task("[$($ds.Name)]", $spec)
                $searchResults = Wait-VimTaskResult -TaskMoRef $taskMoRef

                $fileRows = @()
                foreach ($folderResult in @($searchResults)) {
                    $folderPath = (($folderResult.FolderPath -replace '^\[[^\]]+\]\s*','') -replace '\\','/').Trim('/')
                    foreach ($file in @($folderResult.File)) {
                        if ($file.Path -notmatch '(?i)\.vmdk$') { continue }
                        $key = Get-VmdkKey -Datastore $ds.Name -Folder $folderPath -FileName $file.Path
                        $fileRows += [pscustomobject]@{
                            Key          = $key
                            Datastore    = $ds.Name
                            Folder       = $folderPath
                            FileName     = $file.Path
                            SizeBytes    = [int64]$file.FileSize
                            Modified     = $file.Modification
                            IsDescriptor = ($file.Path -notmatch '(?i)(-flat|-delta|-sesparse|-ctk)\.vmdk$')
                        }
                    }
                }

                $orphanGroups = $fileRows | Where-Object { -not $registeredKeys.Contains($_.Key) } | Group-Object Key
                foreach ($grp in $orphanGroups) {
                    $files = @($grp.Group)
                    $descriptor = $files | Where-Object { $_.IsDescriptor } | Select-Object -First 1
                    $first = if ($descriptor) { $descriptor } else { $files | Select-Object -First 1 }
                    $sizeGB = [Math]::Round((($files | Measure-Object -Property SizeBytes -Sum).Sum / $BYTES_IN_GB), 2)
                    if ($sizeGB -lt $MinimumDiskGB) { continue }
                    $lastModified = ($files | Sort-Object Modified -Descending | Select-Object -First 1).Modified
                    $fileList = (($files | Sort-Object FileName | Select-Object -ExpandProperty FileName) -join ', ')
                    $diskRoot = Get-VmdkBaseName -FileName $first.FileName
                    $ownerLookup = Find-VmdkCreationEvent `
                        -Events $vmdkLookupEvents `
                        -DiskRoot $diskRoot `
                        -Folder $first.Folder `
                        -FileNames @($files | Select-Object -ExpandProperty FileName) `
                        -LastModified $lastModified

                    $allResults += [pscustomobject][ordered]@{
                        'vCenter'             = Get-ShortVcName $vcenter
                        'Datastore'           = $first.Datastore
                        'Folder'              = $first.Folder
                        'DiskRoot'            = $diskRoot
                        'ReclaimableGB'       = $sizeGB
                        'LastModified'        = if ($lastModified) { $lastModified.ToString('yyyy-MM-dd HH:mm:ss') } else { '' }
                        'CreatedByUser'       = $ownerLookup.CreatedByUser
                        'CreatedEventTime'    = $ownerLookup.CreatedEventTime
                        'CreatedAction'       = $ownerLookup.CreatedAction
                        'CreatedEventMessage' = $ownerLookup.CreatedEventMessage
                        'CreatedEventAgeDays' = $ownerLookup.CreatedEventAgeDays
                        'CreatedBySource'     = $ownerLookup.CreatedBySource
                        'MatchedEventType'    = $ownerLookup.MatchedEventType
                        'MatchedVMName'       = $ownerLookup.MatchedVMName
                        'MatchedVMFolder'     = $ownerLookup.MatchedVMFolder
                        'Confidence'          = $ownerLookup.Confidence
                        'OwnerLookupNotes'    = $ownerLookup.OwnerLookupNotes
                        'Files'               = $fileList
                    }
                }
            } catch {
                Write-Log "    ERROR scanning datastore [$($ds.Name)]: $($_.Exception.Message)"
            }
        }
    } catch {
        Write-Log "  ERROR processing $vcenter : $($_.Exception.Message)"
    } finally {
        if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$False }
    }
}

if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$False }
Write-Log "Collection complete. $($allResults.Count) orphaned VMDK groups matched."

$sorted = @($allResults | Sort-Object -Property ReclaimableGB -Descending)
$vmdkCount = $sorted.Count
$totalGB = 0
if ($vmdkCount -gt 0) {
    $totalGB = [Math]::Round((($sorted | Measure-Object -Property ReclaimableGB -Sum).Sum), 2)
}

$summaryByVcenter = @(
    $sorted | Group-Object -Property vCenter | ForEach-Object {
        $vcRows = @($_.Group)
        $vcTotalGB = 0
        if ($vcRows.Count -gt 0) {
            $vcTotalGB = [Math]::Round((($vcRows | Measure-Object -Property ReclaimableGB -Sum).Sum), 2)
        }
        [pscustomobject][ordered]@{
            'vCenter'       = $_.Name
            'VMDKs'         = $vcRows.Count
            'ReclaimableGB' = $vcTotalGB
        }
    } | Sort-Object -Property ReclaimableGB -Descending
)

$alert_title = "$vmdkCount orphaned VMDKs | $totalGB GB reclaimable"
$tblVcenterSummary = Convert-RowsToCompactHtml -Rows $summaryByVcenter -Accent '#1f2937' -EmptyText 'No orphaned VMDKs above the configured minimum size were found.'
$tblOrphaned = Convert-RowsToStyledHtml -Rows $sorted -Accent '#b91c1c' -EmptyText 'No orphaned VMDKs above the configured minimum size were found.'
$reportTime = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

$body = @"
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;-webkit-text-size-adjust:100%;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;">
  <tr><td align="center" style="padding:8px 6px;">
    <table role="presentation" width="960" cellpadding="0" cellspacing="0" style="max-width:960px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      <tr><td style="background:#1f2937;padding:12px 18px;font-family:Segoe UI,Arial,sans-serif;color:#ffffff;font-size:18px;font-weight:700;">Orphaned VMDK Reclaim Report</td></tr>
      <tr><td style="padding:8px 18px 2px;font-family:Segoe UI,Arial,sans-serif;color:#374151;font-size:12px;line-height:1.35;">
        Compares datastore VMDK files to registered VM layout inventory. Lists unattached VMDK groups at least <b>$MinimumDiskGB GB</b>. Owner fields are inferred from vCenter task/event history for the last <b>$EventSearchBackDays days</b>. Review before deleting.
      </td></tr>
      <tr><td style="padding:2px 18px 0;">
        <div style="display:inline-block;font-family:Segoe UI,Arial,sans-serif;font-size:12px;font-weight:700;color:#1f2937;margin:2px 0 2px;padding:0 0 2px;border-bottom:1px solid #1f2937;line-height:1.1;">Summary by vCenter</div>
        $tblVcenterSummary
      </td></tr>
      <tr><td style="padding:2px 18px 4px;">
        <div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:700;color:#b91c1c;margin:6px 0 0;padding-bottom:4px;border-bottom:2px solid #b91c1c;">&#9679; Pure reclaimable storage candidates</div>
        $tblOrphaned
      </td></tr>
      <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:8px 18px;font-family:Segoe UI,Arial,sans-serif;color:#6b7280;font-size:11px;line-height:1.3;">
        Automated report generated by cvs_orphaned_vmdks.ps1 via Ansible &bull; $reportTime &bull; Total reclaimable: $totalGB GB
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>
"@

$resultFile = Join-Path $DebugDir 'result.html'
$body | Out-File -FilePath $resultFile -Encoding utf8
$csvFile = Join-Path $DebugDir 'orphaned_vmdks.csv'
$sorted | Export-Csv -NoTypeInformation -Path $csvFile -Encoding utf8
Write-Log "Report written: $resultFile ($alert_title)"
Write-Log "CSV written: $csvFile"

if ($eMailReport -eq 'yes') {
    $mailParams = @{ SmtpServer = $SMTPServer; From = $MailFrom; To = ($MailToString -split ',').Trim(); Subject = "$MailSubjectstring | $alert_title"; Body = $body; BodyAsHtml = $true }
    if ($MailCcString) { $mailParams.Cc = ($MailCcString -split ',').Trim() }
    Send-MailMessage @mailParams
    Write-Log "Email sent to $MailToString"
}

Write-Log "=== $script:ReportName end ==="