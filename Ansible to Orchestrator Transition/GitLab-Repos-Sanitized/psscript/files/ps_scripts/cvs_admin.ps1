[CmdletBinding()]
param (
    [Parameter(Mandatory=$false)]
    [ValidateSet('Get-AllAdmin-Accounts')]
    [string]$Action = 'Get-AllAdmin-Accounts',

    [Parameter(Mandatory=$false)]
    [string]$DomainOUsFile,

    [Parameter(Mandatory=$false)]
    [string]$DomainOUs,

    [Parameter(Mandatory=$false)]
    [string]$DefaultCredentialKey,

    [Parameter(Mandatory=$false)]
    [ValidateSet('yes','no')]
    [string]$IncludeDisabled = 'yes',

    [Parameter(Mandatory=$false)]
    [ValidateSet('yes','no')]
    [string]$eMailReport = 'yes',

    [Parameter(Mandatory=$false)]
    [string]$SMTPServer,

    [Parameter(Mandatory=$false)]
    [string]$MailToString,

    [Parameter(Mandatory=$false)]
    [string]$MailCcString,

    [Parameter(Mandatory=$false)]
    [string]$MailSubjectstring = 'Ansible-Report: Admin PKI Card Status',

    [Parameter(Mandatory=$false)]
    [string]$ReportTitle = 'Admin Account PKI Report',

    [Parameter(Mandatory=$false)]
    [ValidateSet('yes','no')]
    [string]$FailOnQueryError = 'no'
)

$ErrorActionPreference = 'Stop'

function Initialize-Report {
    $Global:DebugDir  = Join-Path $PSScriptRoot 'debug'
    if (-not (Test-Path $Global:DebugDir)) { New-Item -ItemType Directory -Path $Global:DebugDir -Force | Out-Null }
    $Global:LogFile   = Join-Path $Global:DebugDir 'run.log'
    $Global:Today     = Get-Date
    $Global:MailFrom  = $env:COMPUTERNAME + 'user6@dom3.example'
}

function Write-Log {
    param(
        [Parameter(Mandatory=$true)][string]$Message,
        [ValidateSet('Info','Warn','Error','Success')][string]$Level = 'Info'
    )
    $line = '{0}  {1}: {2}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $Level.ToUpper(), $Message
    switch ($Level) {
        'Error'   { Write-Host $line -ForegroundColor Red }
        'Warn'    { Write-Host $line -ForegroundColor Yellow }
        'Success' { Write-Host $line -ForegroundColor Green }
        default   { Write-Host $line }
    }
    if ($Global:LogFile) { $line | Add-Content -Path $Global:LogFile -ErrorAction SilentlyContinue }
}

function Get-DomainOuMap {
    $json = $null
    if ($DomainOUsFile) {
        if (-not (Test-Path $DomainOUsFile)) { throw "DomainOUsFile not found: $DomainOUsFile" }
        $json = Get-Content -Raw -Path $DomainOUsFile
    }
    elseif ($DomainOUs) { $json = $DomainOUs }

    if ([string]::IsNullOrWhiteSpace($json)) { throw 'No domain/OU map supplied (-DomainOUsFile or -DomainOUs).' }

    $obj = ConvertFrom-Json $json
    $map = [ordered]@{}

    foreach ($p in $obj.PSObject.Properties) {
        $value = $p.Value
        $rawOus   = @()
        $rawDepts = @()
        $credKey  = $null

        if ($value -isnot [array] -and $value.PSObject.Properties.Name -contains 'ous') {
            $rawOus   = @($value.ous)
            $rawDepts = @($value.departments)
            $credKey  = $value.credential
        }
        else {
            $rawOus = @($value)
        }

        $ous   = @($rawOus   | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object { $_.Trim() })
        $depts = @($rawDepts | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object { $_.Trim() })

        if ($ous.Count -gt 0) {
            $map[$p.Name] = [pscustomobject]@{
                OUs           = $ous
                Departments   = $depts
                CredentialKey = $credKey
            }
        }
    }

    if ($map.Keys.Count -eq 0) { throw 'Domain/OU map parsed but contained no OUs.' }
    return $map
}

$Global:CredCache = @{}

function Get-DomainCredential {
    param([string]$Key)

    if ([string]::IsNullOrWhiteSpace($Key)) { return $null }

    $k = ($Key.ToUpper() -replace '[^A-Z0-9]', '_')
    if ($Global:CredCache.ContainsKey($k)) { return $Global:CredCache[$k] }

    $user = [Environment]::GetEnvironmentVariable("AD_CRED_${k}_USER")
    $pass = [Environment]::GetEnvironmentVariable("AD_CRED_${k}_PASS")

    if ([string]::IsNullOrWhiteSpace($user) -or [string]::IsNullOrWhiteSpace($pass)) {
        throw "Credential '$Key' requested but AD_CRED_${k}_USER / AD_CRED_${k}_PASS are not set in the environment."
    }

    $cred = New-Object System.Management.Automation.PSCredential($user, (ConvertTo-SecureString $pass -AsPlainText -Force))
    $Global:CredCache[$k] = $cred
    Write-Log "Credential '$Key' resolved as $user"
    return $cred
}

function Get-AdminAccounts {
    param([Parameter(Mandatory=$true)]$Map)

    $props    = 'SamAccountName','UserPrincipalName','SmartcardLogonRequired','DisplayName','Department','Enabled','WhenCreated','Description'
    $accounts = @()
    $errors   = @()

    foreach ($domain in $Map.Keys) {
        $depts = @($Map[$domain].Departments)
        if ($depts.Count -gt 0) { Write-Log "$domain department filter: $($depts -join ', ')" }

        $credKey = $Map[$domain].CredentialKey
        if ([string]::IsNullOrWhiteSpace($credKey)) { $credKey = $DefaultCredentialKey }

        $cred = $null
        try { $cred = Get-DomainCredential -Key $credKey }
        catch {
            Write-Log "$domain - $($_.Exception.Message)" 'Error'
            $errors += [pscustomobject]@{ Domain = $domain; OU = '(all)'; Error = $_.Exception.Message }
            continue
        }

        foreach ($ou in $Map[$domain].OUs) {
            try {
                Write-Log "Querying $domain :: $ou"

                $query = @{
                    Server      = $domain
                    Filter      = '*'
                    SearchBase  = $ou
                    SearchScope = 'Subtree'
                    Properties  = $props
                    ErrorAction = 'Stop'
                }
                if ($cred) { $query.Credential = $cred }

                $users = @(Get-ADUser @query)
                $found = $users.Count

                if ($IncludeDisabled -eq 'no') { $users = @($users | Where-Object { $_.Enabled -eq $true }) }

                if ($depts.Count -gt 0) {
                    $users = @($users | Where-Object {
                        $d = $_.Department
                        if ([string]::IsNullOrWhiteSpace($d)) { return $false }
                        foreach ($f in $depts) { if ($d.Trim() -like $f) { return $true } }
                        return $false
                    })
                    Write-Log "Found $found account(s) in $ou - $($users.Count) matched the department filter"
                }
                else {
                    Write-Log "Found $($users.Count) account(s) in $ou"
                }

                $accounts += $users | Select-Object `
                    @{N='Domain';E={ $domain.Split('.')[0].ToUpper() }},
                    SamAccountName, UserPrincipalName, SmartcardLogonRequired,
                    DisplayName, Department, Enabled, WhenCreated, Description
            }
            catch {
                Write-Log "$domain :: $ou - $($_.Exception.Message)" 'Error'
                $errors += [pscustomobject]@{
                    Domain = $domain
                    OU     = $ou
                    Error  = $_.Exception.Message
                }
            }
        }
    }

    # De-duplicate accounts that fall under more than one search base
    $accounts = @($accounts | Sort-Object Domain, SamAccountName -Unique)

    return [pscustomobject]@{ Accounts = $accounts; Errors = $errors }
}

function Format-CvsTableHtml {
    param(
        [string]$Fragment,
        [string]$Accent = '#1f2937',
        [switch]$CenterCells
    )

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
        $t = $t -replace '(<td style="[^"]+?)(">)(\s*[\d.,]+\s*)(</td>)',
            '$1;text-align:right$2$3$4'
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
    param(
        [string]$Title,
        [string]$TableHtml,
        [string]$Accent = '#1f2937'
    )

    return @"
            <div style="font-family:Segoe UI,Arial,sans-serif;font-size:12px;font-weight:700;color:$Accent;margin:8px 0 0;padding-bottom:4px;border-bottom:2px solid $Accent;">
              &#9679; $Title
            </div>
            $TableHtml
"@
}

function New-CvsReportHtml {
    param(
        [string]$Title,
        [string]$Summary,
        [string]$Sections,
        [string]$FooterScriptName = 'cvs_admin.ps1'
    )

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

function New-OuFootnoteHtml {
    param($Map)

    $html = '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:#6b7280;margin:10px 0 4px;padding-top:8px;border-top:1px solid #e5e7eb;"><b>OUs queried:</b><ul style="margin:4px 0 0;padding-left:16px;">'
    foreach ($domain in $Map.Keys) {
        $depts = @($Map[$domain].Departments)
        $label = if ($depts.Count -gt 0) { "$domain &nbsp;&ndash;&nbsp; Department in ($($depts -join ', '))" } else { $domain }
        $html += "<li><b>$label</b><ul style=`"margin:2px 0 4px;padding-left:16px;`">"
        foreach ($ou in $Map[$domain].OUs) { $html += "<li>$ou</li>" }
        $html += '</ul></li>'
    }
    $html += '</ul></div>'
    return $html
}

function New-PkiReport {
    param($Compliant, $NonCompliant, $Errors, $Map)

    $cols = 'Domain','SamAccountName','UserPrincipalName','DisplayName','Department','Enabled','WhenCreated','Description'

    $rawNon = @($NonCompliant | Sort-Object Domain, SamAccountName | ConvertTo-Html -Property $cols -Fragment)
    $rawCom = @($Compliant    | Sort-Object Domain, SamAccountName | ConvertTo-Html -Property $cols -Fragment)

    $rawNon = $rawNon -replace 'WhenCreated','CreatedOn' -replace '<td>False</td>','<td><font color="red">False</font></td>'
    $rawCom = $rawCom -replace 'WhenCreated','CreatedOn' -replace '<td>False</td>','<td><font color="red">False</font></td>'

    $tblNon = Format-CvsTableHtml -Fragment ($rawNon -join "`n") -Accent '#b91c1c'
    $tblCom = Format-CvsTableHtml -Fragment ($rawCom -join "`n") -Accent '#1f2937'

    $sections  = New-CvsReportSectionHtml -Title "Non-Compliant &nbsp;&ndash;&nbsp; smartcard logon NOT enabled ($($NonCompliant.Count))" -TableHtml $tblNon -Accent '#b91c1c'
    $sections += New-CvsReportSectionHtml -Title "Compliant &nbsp;&ndash;&nbsp; smartcard logon enabled ($($Compliant.Count))" -TableHtml $tblCom -Accent '#1f2937'

    if ($Errors.Count -gt 0) {
        $rawErr = @($Errors | ConvertTo-Html -Property Domain, OU, Error -Fragment)
        $tblErr = Format-CvsTableHtml -Fragment ($rawErr -join "`n") -Accent '#c2410c'
        $sections += New-CvsReportSectionHtml -Title "Query Errors ($($Errors.Count)) &nbsp;&ndash;&nbsp; results below are incomplete" -TableHtml $tblErr -Accent '#c2410c'
    }

    $sections += New-OuFootnoteHtml -Map $Map

    $total = $Compliant.Count + $NonCompliant.Count
    $pct   = if ($total -gt 0) { [math]::Round(($Compliant.Count / $total) * 100, 1) } else { 0 }
    $scope = if ($IncludeDisabled -eq 'no') { 'Enabled accounts only.' } else { 'Enabled and disabled accounts included.' }

    $summary = "<b>$($Compliant.Count)</b> of <b>$total</b> admin accounts (<b>$pct%</b>) require smartcard logon across <b>$($Map.Keys.Count)</b> domain(s). <b>$($NonCompliant.Count)</b> account(s) are non-compliant. $scope"

    return New-CvsReportHtml -Title $ReportTitle -Summary $summary -Sections $sections
}

function Send-Report {
    param([string]$Body, [string]$Subject)

    if ([string]::IsNullOrWhiteSpace($SMTPServer)) { Write-Log 'SMTPServer not supplied - report not sent.' 'Warn'; return }

    $to = @()
    $cc = @()
    if ($MailToString) { $to = @($MailToString.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
    if ($MailCcString) { $cc = @($MailCcString.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }

    if ($to.Count -eq 0) { Write-Log 'MailToString is empty - report not sent.' 'Error'; return }

    $params = @{
        SmtpServer = $SMTPServer
        From       = $Global:MailFrom
        To         = $to
        Subject    = $Subject
        Body       = $Body
        BodyAsHtml = $true
        Encoding   = [System.Text.Encoding]::UTF8
    }
    if ($cc.Count -gt 0) { $params.Cc = $cc }

    try {
        Send-MailMessage @params
        Write-Log "Report sent to $($to -join ', ')" 'Success'
    }
    catch { Write-Log "Send-MailMessage failed - $($_.Exception.Message)" 'Error' }
}

Initialize-Report
Write-Log "Action: $Action  IncludeDisabled: $IncludeDisabled  eMailReport: $eMailReport"

try   { Import-Module ActiveDirectory -ErrorAction Stop }
catch { Write-Log "ActiveDirectory module unavailable - $($_.Exception.Message)" 'Error'; exit 2 }

try   { $map = Get-DomainOuMap }
catch { Write-Log $_.Exception.Message 'Error'; exit 2 }

$data         = Get-AdminAccounts -Map $map
$compliant    = @($data.Accounts | Where-Object { $_.SmartcardLogonRequired -eq $true })
$nonCompliant = @($data.Accounts | Where-Object { $_.SmartcardLogonRequired -ne $true })

Write-Log "Total: $($data.Accounts.Count)  Compliant: $($compliant.Count)  Non-Compliant: $($nonCompliant.Count)  Query errors: $($data.Errors.Count)"

$subject = "$MailSubjectstring ( $($nonCompliant.Count) Non-Compliance - $($compliant.Count) Compliance )"
$body    = New-PkiReport -Compliant $compliant -NonCompliant $nonCompliant -Errors $data.Errors -Map $map

$body | Out-File -FilePath (Join-Path $Global:DebugDir 'PKI_result.html') -Encoding utf8
$data.Accounts | Export-Csv -Path (Join-Path $Global:DebugDir 'PKI_result.csv') -NoTypeInformation -Encoding UTF8

if ($eMailReport -eq 'yes') { Send-Report -Body $body -Subject $subject }
else { Write-Log 'eMailReport is not yes - skipping mail.' 'Warn' }

if ($FailOnQueryError -eq 'yes' -and $data.Errors.Count -gt 0) {
    Write-Log "Exiting non-zero: $($data.Errors.Count) OU query error(s)." 'Error'
    exit 1
}

Write-Log 'Complete.' 'Success'
exit 0