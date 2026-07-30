<#
.SYNOPSIS
    Renders a sample Admin Accounts Report from synthetic data, for design review.

.DESCRIPTION
    Loads the REAL GenerateReportPKI-v2 out of cvs_functions.ps1 and feeds it
    fabricated accounts, so what you see is exactly what the production report will
    look like — no Active Directory, SMTP or Orchestrator required.

    Two files are produced next to this script:
      Sample-Report-Clean.html       every OU queried successfully
      Sample-Report-Incomplete.html  two OUs unreadable — shows the alert path

    Open them in a browser to review layout. Note the production report is emailed
    and read in OUTLOOK, which ignores most <style> blocks — that is why every table
    is styled inline. A browser is a good proxy for content, an imperfect one for
    final spacing.

.EXAMPLE
    .\New-SampleReport.ps1
#>
[CmdletBinding()]
param()

Set-Location $PSScriptRoot
$src = Join-Path (Resolve-Path '..\..\files') 'cvs_functions.ps1'
if (-not (Test-Path $src)) { throw "cannot find cvs_functions.ps1 at $src" }

$errors = $null; $tokens = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($src, [ref]$tokens, [ref]$errors)
if ($errors -and $errors.Count -gt 0) { throw "parse errors in $src" }

$want = @('Resolve-DomainOUsMap','GenerateReportPKI-v2','Format-HtmlTable','Format-PKIAccountTable','Remove-DuplicateAccounts','Get-ADFailureCategory')
$found = @()
$ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) |
    Where-Object { $want -contains $_.Name } |
    ForEach-Object { . ([scriptblock]::Create($_.Extent.Text)); $found += $_.Name }

# A helper that fails to load does NOT stop the report being produced - the call just
# raises a non-terminating error and that section renders empty, which is exactly how
# the Format-HtmlTable binding defect hid. Fail loudly instead of writing a sample
# that is quietly missing its tables.
$missing = @($want | Where-Object { $found -notcontains $_ })
if ($missing.Count -gt 0) {
    throw "Could not load these function(s) from cvs_functions.ps1: $($missing -join ', '). The sample would render with missing sections."
}
$Error.Clear()

# --- stubs: capture the body instead of mailing it ---------------------------
$Global:DebugDir = Join-Path $PSScriptRoot 'Debug'
$script:body = $null
function Write-Log { param($InformationItem, $ConsoleOut) }
function SendMail  { param($MailBody, $MailSubject, $MailAttachments) $script:body = $MailBody }
$eMailReport = 'yes'

# --- synthetic scope: 4 domains ----------------------------------------------
$map = Resolve-DomainOUsMap -Json (@'
{
 "corp.example.local":   ["OU=Admin Accounts,OU=Servers,DC=corp,DC=example,DC=local",
                          "OU=Admin Accounts,OU=Workstations,DC=corp,DC=example,DC=local"],
 "eu.example.local":     ["OU=Admin Accounts,OU=Servers,DC=eu,DC=example,DC=local",
                          "OU=Admin Accounts,OU=Workstations,DC=eu,DC=example,DC=local"],
 "apac.example.local":   ["OU=Admin Accounts,OU=Servers,DC=apac,DC=example,DC=local"],
 "legacy.example.local": ["OU=Admin Accounts,OU=Servers,DC=legacy,DC=example,DC=local"]
}
'@)

function New-Acct($sam,$name,$dom,$ouKind,$sc,$enabled,$created,$desc) {
    # $ouKind is 'Servers' or 'Workstations' — accounts are attributed to the OU whose
    # search returned them, which is what the report sub-sections on.
    [pscustomobject]@{
        SamAccountName = $sam; displayName = $name
        UserPrincipalName = "$sam@$dom"
        smartcardlogonrequired = $sc; Enabled = $enabled
        whenCreated = (Get-Date $created); description = $desc
        SourceDomain = $dom
        SourceOU = "OU=Admin Accounts,OU=$ouKind,DC=$($dom.Split('.')[0]),DC=example,DC=local"
    }
}

$accounts = @(
    # corp — two OUs, mostly compliant, one gap in each
    New-Acct 'adm.jhalloway' 'Halloway, Jordan'  'corp.example.local' 'Servers'      $true  $true  '2021-03-14' 'Tier 0 - Domain Admin'
    New-Acct 'adm.rkeswick'  'Keswick, Robin'    'corp.example.local' 'Servers'      $true  $true  '2022-07-02' 'Tier 1 - Server Admin'
    New-Acct 'svc.backup01'  'Backup Service'    'corp.example.local' 'Servers'      $false $true  '2019-05-30' 'Service account - exempted?'
    New-Acct 'adm.mfairlie'  'Fairlie, Morgan'   'corp.example.local' 'Workstations' $true  $true  '2023-01-19' 'Tier 2 - Workstation Admin'
    New-Acct 'adm.tokonkwo'  'Okonkwo, Tobi'     'corp.example.local' 'Workstations' $true  $true  '2023-11-08' 'Tier 2 - Workstation Admin'
    # eu — a clear problem area, concentrated in Workstations
    New-Acct 'adm.lbianchi'  'Bianchi, Luca'     'eu.example.local'   'Servers'      $true  $true  '2022-02-11' 'Tier 1 - Server Admin'
    New-Acct 'adm.spetrova'  'Petrova, Sofia'    'eu.example.local'   'Servers'      $false $true  '2020-09-23' 'Tier 1 - Server Admin'
    New-Acct 'adm.hvandijk'  'van Dijk, Hendrik' 'eu.example.local'   'Workstations' $false $true  '2021-06-17' 'Tier 2 - Workstation Admin'
    New-Acct 'adm.oleaving'  'Leaving, Oscar'    'eu.example.local'   'Workstations' $false $false '2018-04-05' 'LEAVER - pending deletion'
    # apac — single OU in scope, fully compliant (shows the un-sub-sectioned form)
    New-Acct 'adm.ynakamura' 'Nakamura, Yuki'    'apac.example.local' 'Servers'      $true  $true  '2023-08-21' 'Tier 1 - Server Admin'
    New-Acct 'adm.wchen'     'Chen, Wei'         'apac.example.local' 'Servers'      $true  $true  '2024-02-14' 'Tier 1 - Server Admin'
)

# --- 1. clean run -------------------------------------------------------------
GenerateReportPKI-v2 $accounts $map @()
$script:body | Out-File -FilePath (Join-Path $PSScriptRoot 'Sample-Report-Clean.html') -Encoding UTF8
Write-Host "wrote Sample-Report-Clean.html" -ForegroundColor Green

# --- 2. incomplete run (the path that matters most) --------------------------
# legacy.* is entirely unreadable, and one of eu's two OUs failed. Recorded twice
# each, because the sweep runs once per smart-card state.
# Built through the real classifier (S-20) so the sample shows exactly what the
# production report will say — two DIFFERENT kinds of problem, deliberately:
#   legacy.* is unreachable  -> availability, may clear on its own
#   eu.*     got a referral  -> targeting, deterministic, someone must fix the OU list
function New-Failure($dom,$ou,$msg,$type) {
    $c = Get-ADFailureCategory -ExceptionType $type -Message $msg
    [pscustomobject]@{ Domain=$dom; OU=$ou; Category=$c.Category; Reason=$msg; Guidance=$c.Guidance; ExceptionType=$type }
}
$legacyOU = 'OU=Admin Accounts,OU=Servers,DC=legacy,DC=example,DC=local'
$euWksOU  = 'OU=Admin Accounts,OU=Workstations,DC=eu,DC=example,DC=local'
$failures = @(
    New-Failure 'legacy.example.local' $legacyOU 'The server is not operational'          'ADServerDownException'
    New-Failure 'legacy.example.local' $legacyOU 'The server is not operational'          'ADServerDownException'
    New-Failure 'eu.example.local'     $euWksOU  'A referral was returned from the server' 'ADReferralException'
    New-Failure 'eu.example.local'     $euWksOU  'A referral was returned from the server' 'ADReferralException'
)
GenerateReportPKI-v2 $accounts $map $failures
$script:body | Out-File -FilePath (Join-Path $PSScriptRoot 'Sample-Report-Incomplete.html') -Encoding UTF8
Write-Host "wrote Sample-Report-Incomplete.html" -ForegroundColor Green

# --- 3. overlapping OU list (duplicate detection) -----------------------------
# Searches run at SUBTREE (fully recursive) scope, so listing an OU *and* one of its
# sub-OUs returns the deeper accounts twice. Shows the duplicate alert.
$nestedMap = Resolve-DomainOUsMap -Json (@'
{
 "corp.example.local": ["OU=Admin Accounts,DC=corp,DC=example,DC=local",
                        "OU=Admin Accounts,OU=Servers,DC=corp,DC=example,DC=local"]
}
'@)
$parentOU = 'OU=Admin Accounts,DC=corp,DC=example,DC=local'
$dupAccounts = @(
    $accounts | Where-Object { $_.SourceDomain -eq 'corp.example.local' -and $_.SourceOU -like '*OU=Servers*' }
) + @(
    # the same three accounts, also returned by the parent OU's recursive search
    $accounts | Where-Object { $_.SourceDomain -eq 'corp.example.local' -and $_.SourceOU -like '*OU=Servers*' } |
        ForEach-Object {
            $c = $_.PSObject.Copy(); $c.SourceOU = $parentOU; $c
        }
)
GenerateReportPKI-v2 $dupAccounts $nestedMap @()
$script:body | Out-File -FilePath (Join-Path $PSScriptRoot 'Sample-Report-Duplicates.html') -Encoding UTF8
Write-Host "wrote Sample-Report-Duplicates.html" -ForegroundColor Green

Remove-Item -Recurse -Force $Global:DebugDir -ErrorAction SilentlyContinue

# Same reasoning as the load guard above: a non-terminating error during rendering
# removes content without failing anything. Surface it rather than shipping a sample
# with a hole in it.
if ($Error.Count -gt 0) {
    Write-Host "`nWARNING - $($Error.Count) error(s) occurred while rendering; the samples may be incomplete:" -ForegroundColor Red
    $Error | Select-Object -First 5 | ForEach-Object { Write-Host "   $($_.Exception.Message)" -ForegroundColor Red }
    exit 1
}

Write-Host "`nOpen any of the files in a browser to review the layout." -ForegroundColor Cyan


