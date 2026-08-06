<#
.SYNOPSIS
    Renders sample service account expiration reports, without a lab.

.DESCRIPTION
    Runs the REAL GenerateReportServiceAccountExpiration - loaded by AST out of the
    live cvs_functions.ps1 - against synthetic accounts, and writes the resulting HTML
    next to this script. Open any of them in a browser to see what the customer
    receives, and to review wording and layout before a lab run.

    No Active Directory, SMTP, PowerShell host or vRO appliance is involved. Nothing is
    emailed: SendMail is stubbed.

    NOTE ON OUTLOOK: these files are rendered for a BROWSER. Outlook uses the Word
    engine, which is why every style in the report is inline. Layout in Outlook can
    still differ - confirming that is a lab-validation step, not something this script
    can answer.

.PARAMETER ScriptPath
    Path to the cvs_functions.ps1 to render from.

.EXAMPLE
    .\New-SampleReport.ps1
#>
[CmdletBinding()]
param(
    [string] $ScriptPath = "e:\GitHub-LocalRepos\AutomationProjects\Ansible to Orchestrator Transition\InProgress\psscript\files\cvs_functions.ps1"
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $ScriptPath)) {
    Write-Host "FATAL: script not found: $ScriptPath" -ForegroundColor Red
    exit 1
}

# ── Load the real functions, by AST ──────────────────────────────────────────
$parseErrors = $null; $tokens = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($ScriptPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) {
    Write-Host "FATAL: $ScriptPath does not parse - fix it before rendering samples:" -ForegroundColor Red
    $parseErrors | ForEach-Object { Write-Host ("  line {0}: {1}" -f $_.Extent.StartLineNumber, $_.Message) -ForegroundColor Red }
    exit 1
}
foreach ($n in @('ConvertFrom-ADFileTime','Get-AccountExpiryState','Sort-ServiceAccountRows',
                 'Get-ServiceAccountSectionNote','Format-ServiceAccountTable','Format-HtmlTable',
                 'Remove-DuplicateAccounts','Get-ADFailureCategory','GenerateReportServiceAccountExpiration')) {
    $fn = $ast.FindAll({ param($x)
        $x -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq $n }, $true)
    if ($fn.Count -eq 0) { Write-Host "FATAL: function '$n' not found - the sample would not match the shipping report." -ForegroundColor Red; exit 1 }
    . ([scriptblock]::Create($fn[0].Extent.Text))
}

# ── Stubs ────────────────────────────────────────────────────────────────────
function Write-Log { param($InformationItem, $Echo) }
$script:Body = $null
function SendMail { param($MailBody, $MailSubject, $MailAttachments) $script:Body = $MailBody }
$Global:DebugDir          = Join-Path $PSScriptRoot 'Debug'
$Global:Today             = Get-Date
$Global:DuplicateAccounts = @()
$eMailReport              = 'yes'

$now = Get-Date
function New-Acct {
    param($Sam, $Name, $Expires, $PwdAgeDays, $Enabled = $true, $Locked = $false,
          $Domain = 'corp.local', $OU = 'OU=Service Accounts,DC=corp,DC=local', $Desc = '')
    $pw = if ($null -eq $PwdAgeDays) { 0 } else { $now.AddDays(-$PwdAgeDays).ToFileTime() }
    [PSCustomObject]@{
        SamAccountName = $Sam; DisplayName = $Name; Office = 'Platform Services'
        Enabled = $Enabled; LockedOut = $Locked
        AccountExpirationDate = $Expires; pwdLastSet = $pw
        WhenCreated = $now.AddYears(-3); Description = $Desc
        SourceDomain = $Domain; SourceOU = $OU
    }
}

function Save-Sample {
    param([string]$File, [string]$Html, [string]$What)
    $path = Join-Path $PSScriptRoot $File
    $Html | Out-File -FilePath $path -Encoding UTF8
    Write-Host ("  {0,-34} {1}" -f $File, $What) -ForegroundColor Gray
}

$map = [PSCustomObject]@{}
$map | Add-Member -NotePropertyName 'corp.local'  -NotePropertyValue @('OU=Service Accounts,DC=corp,DC=local')
$map | Add-Member -NotePropertyName 'other.local' -NotePropertyValue @('OU=Svc,DC=other,DC=local','OU=Retired,DC=other,DC=local')

$accounts = @(
    New-Acct 'svc-backup'    'Backup Service'      $now.AddDays(-21)  410 -Desc 'Veeam proxy - OWNER: Platform team'
    New-Acct 'svc-legacyetl' 'Legacy ETL'          $now.AddDays(-2)   180 -Enabled $false -Desc 'decommissioned 2025?'
    New-Acct 'svc-sqlagent'  'SQL Agent'           $now.AddDays(4)     95 -Desc 'SQL Server Agent - PROD'
    New-Acct 'svc-scanner'   'Vuln Scanner'        $now.AddDays(17)   240 -Desc 'authenticated scanning'
    New-Acct 'svc-iis'       'IIS App Pool'        $now.AddDays(28)    60 -Desc 'app pool identity'
    New-Acct 'svc-monitor'   'Monitoring Collector' $null             $null -Desc 'no expiry, password NEVER SET'
    New-Acct 'svc-archive'   'Archive Mover'       $now.AddDays(240)   30 -Desc ''
    New-Acct 'svc-report'    'Reporting Reader'    $null              120 -Desc 'read-only reporting'
    New-Acct 'svc-relay'     'SMTP Relay'          $now.AddDays(9)    730 -Locked $true -Domain 'other.local' -OU 'OU=Svc,DC=other,DC=local' -Desc 'LOCKED OUT'
    New-Acct 'svc-oldjob'    'Nightly Job'         $now.AddDays(-95)  900 -Domain 'other.local' -OU 'OU=Svc,DC=other,DC=local' -Desc 'still referenced by task scheduler?'
    New-Acct 'svc-fileshare' 'File Share'          $null               45 -Domain 'other.local' -OU 'OU=Svc,DC=other,DC=local' -Desc ''
)

Write-Host ""
Write-Host "Rendering samples from $ScriptPath" -ForegroundColor Cyan
Write-Host ""

# ── 1. Clean run ─────────────────────────────────────────────────────────────
$Global:DuplicateAccounts = @()
$script:Body = $null
GenerateReportServiceAccountExpiration $accounts $map @() @() 30
Save-Sample 'Sample-Report-Clean.html' $script:Body 'every OU read; expired and expiring sections populated'

# ── 2. Incomplete run ────────────────────────────────────────────────────────
$failures = @(
    [PSCustomObject]@{ Domain='other.local'; OU='OU=Retired,DC=other,DC=local'; Category='Unreachable'
                       Reason='The server is not operational'
                       Guidance='The domain controller could not be contacted. This is an availability problem, not an OU-list problem - it may clear on its own. Check DNS, network path and DC health.'
                       ExceptionType='ADServerDownException' }
    [PSCustomObject]@{ Domain='corp.local'; OU='OU=Typo Accounts,DC=corp,DC=local'; Category='Scope error'
                       Reason='A referral was returned from the server'
                       Guidance='The OU distinguishedName is wrong, or does not exist in this domain. A referral means the server answered and said this naming context is not its own. Correct the OU list - retrying will not help.'
                       ExceptionType='ADReferralException' }
)
$mapF = [PSCustomObject]@{}
$mapF | Add-Member -NotePropertyName 'corp.local'  -NotePropertyValue @('OU=Service Accounts,DC=corp,DC=local','OU=Typo Accounts,DC=corp,DC=local')
$mapF | Add-Member -NotePropertyName 'other.local' -NotePropertyValue @('OU=Svc,DC=other,DC=local','OU=Retired,DC=other,DC=local')
$Global:DuplicateAccounts = @()
$script:Body = $null
GenerateReportServiceAccountExpiration $accounts $mapF $failures @() 30
Save-Sample 'Sample-Report-Incomplete.html' $script:Body 'two OUs unreadable - the [INCOMPLETE] path, failures classified'

# ── 3. Overlapping OU list ───────────────────────────────────────────────────
$dupAccounts = @(
    New-Acct 'svc-nested'  'Nested Account'  $now.AddDays(11) 300 -OU 'OU=Service Accounts,DC=corp,DC=local' -Desc 'returned by BOTH searches'
    New-Acct 'svc-nested'  'Nested Account'  $now.AddDays(11) 300 -OU 'OU=Tier1,OU=Service Accounts,DC=corp,DC=local' -Desc 'returned by BOTH searches'
    New-Acct 'svc-plain'   'Parent Only'     $now.AddDays(60)  20 -OU 'OU=Service Accounts,DC=corp,DC=local'
)
$mapD = [PSCustomObject]@{}
$mapD | Add-Member -NotePropertyName 'corp.local' -NotePropertyValue @('OU=Service Accounts,DC=corp,DC=local','OU=Tier1,OU=Service Accounts,DC=corp,DC=local')
$Global:DuplicateAccounts = @()
$script:Body = $null
GenerateReportServiceAccountExpiration $dupAccounts $mapD @() $null 30
Save-Sample 'Sample-Report-Duplicates.html' $script:Body 'a parent OU and its sub-OU - collapsed to one entry, with the notice'

# ── 4. Nothing to do ─────────────────────────────────────────────────────────
$Global:DuplicateAccounts = @()
$script:Body = $null
GenerateReportServiceAccountExpiration @(
    New-Acct 'svc-fine1' 'Healthy One' $now.AddDays(300) 15
    New-Acct 'svc-fine2' 'Healthy Two' $null             40
) $map @() @() 30
Save-Sample 'Sample-Report-NoFindings.html' $script:Body 'the quiet case - what a clean month looks like'

Write-Host ""
Write-Host "Open any of the above in a browser." -ForegroundColor Green
Write-Host "The report the script itself writes on the PS host is Debug\ServiceAccountExpiration_result.html" -ForegroundColor DarkGray
Write-Host ""
