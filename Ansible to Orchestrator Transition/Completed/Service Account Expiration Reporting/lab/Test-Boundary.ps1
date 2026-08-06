<#
.SYNOPSIS
    Cross-language boundary test: JS-JSON -> PowerShell single-quote -> ConvertFrom-Json.

.DESCRIPTION
    Takes the invocation string the vRO action ACTUALLY EMITS, executes it against a
    stub carrying the REAL Resolve-DomainOUsMap spliced in from cvs_functions.ps1, and
    confirms the reconstructed domain/OU map is byte-identical to what went in.

    THIS IS THE TEST THAT MATTERS MOST for scope integrity. The report's scope crosses
    three quoting regimes on its way to Active Directory, and a bug anywhere in that
    chain corrupts an OU DN silently: a corrupted DN does not throw, it simply searches
    somewhere else or nowhere, and an OU that returns nothing looks exactly like an OU
    whose accounts are all healthy. For an expiration report the consequence is an
    account expiring with nobody warned.

    Also asserts that -ExpiringWithinDays binds as a number-like string, since the
    window reaches PowerShell as text and is parsed there.

.PARAMETER ScriptPath
    Path to the cvs_functions.ps1 to splice the real resolver out of.

.NOTES
    Run gen-awkward.js and test-action.js FIRST - they write the fixtures this executes.
#>
[CmdletBinding()]
param(
    [string] $ScriptPath = "e:\GitHub-LocalRepos\AutomationProjects\Ansible to Orchestrator Transition\InProgress\psscript\files\cvs_functions.ps1"
)

$scratch = $PSScriptRoot

if (-not (Test-Path -LiteralPath $ScriptPath)) {
    Write-Host "FATAL: script under test not found: $ScriptPath" -ForegroundColor Red
    exit 1
}
foreach ($fixture in @('invocation.txt','invocation-awkward.txt','invocation-quotes.txt')) {
    if (-not (Test-Path (Join-Path $scratch $fixture))) {
        Write-Host "FATAL: fixture '$fixture' missing - run 'node .\test-action.js' and 'node .\gen-awkward.js' first." -ForegroundColor Red
        exit 1
    }
}

# --- stub script: same relevant params as cvs_functions.ps1, prints what it received --
$stub = Join-Path $scratch 'stub_cvs.ps1'
@'
[CmdletBinding()]
param (
    [string]$Action,
    [string]$eMailReport='yes',
    [string]$SMTPServer,
    [string]$MailToString = 'admin@vcf.lab',
    [string]$MailCcString = 'admin@vcf.lab',
    [string]$MailSubjectstring,
    [string]$DomainOUs,
    [string]$DomainOUsFile,
    [string]$ExpiringWithinDays = '30'
)
function Write-Log { param($InformationItem,$ConsoleOut) }
__RESOLVER__
$map = Resolve-DomainOUsMap -Json $DomainOUs -Path $DomainOUsFile
Write-Output "ACTION=$Action"
Write-Output "TO=$MailToString"
Write-Output "CC=$MailCcString"
Write-Output "SUBJ=$MailSubjectstring"
Write-Output "SMTP=$SMTPServer"
Write-Output "EMAIL=$eMailReport"
Write-Output "WINDOW=$ExpiringWithinDays"
foreach ($d in @($map.PSObject.Properties.Name)) {
    foreach ($ou in @($map.$d)) { Write-Output "OU=$d|$ou" }
}
'@ | Set-Content -Path $stub -Encoding UTF8

# splice the REAL Resolve-DomainOUsMap in, so we test the SHIPPING parser rather than a
# copy of it that could drift
$errors=$null;$tokens=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($ScriptPath,[ref]$tokens,[ref]$errors)
$resolverAst = @($ast.FindAll({$args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst]},$true) |
    Where-Object { $_.Name -eq 'Resolve-DomainOUsMap' })
if ($resolverAst.Count -eq 0) {
    Write-Host "FATAL: Resolve-DomainOUsMap not found in $ScriptPath." -ForegroundColor Red
    exit 1
}
(Get-Content $stub -Raw).Replace('__RESOLVER__',$resolverAst[0].Extent.Text) | Set-Content -Path $stub -Encoding UTF8

$pass=0;$fail=0
function Check($name,$cond){ if($cond){Write-Host "  PASS  $name" -ForegroundColor Green;$script:pass++}else{Write-Host "  FAIL  $name" -ForegroundColor Red;$script:fail++} }

function Invoke-Boundary($invocation) {
    # swap the placeholder script path for the stub, keeping EVERYTHING ELSE verbatim -
    # the arguments under test must not be touched
    $cmd = $invocation -replace '(?s)^& "[^"]*"', ('& "' + $stub + '"')
    $cmd = $cmd -replace '\s\*>&1 \| Out-String -Width 4096$',''   # keep raw lines for assertions
    return (Invoke-Expression $cmd)
}

# ── B1: the production scope, straight from the action's own output ───────────
Write-Host "`nB1 production scope through the real invocation string"
$inv = Get-Content (Join-Path $scratch 'invocation.txt') -Raw
$out = @(Invoke-Boundary $inv)
$ouLines = @($out | Where-Object { $_ -like 'OU=*' })
Check "invocation parsed & executed"      ($out.Count -gt 0)
Check "Action bound correctly"            (($out | Where-Object {$_ -like 'ACTION=*'}) -eq 'ACTION=Get-ServiceAccountExpiration')
Check "the OU is reconstructed"           ($ouLines.Count -eq 1)
Check "OU DN intact end to end"           ($ouLines -contains 'OU=corp.local|OU=Service Accounts,DC=corp,DC=local')
Check "mailTo bound"                      (($out | Where-Object {$_ -like 'TO=*'}) -eq 'TO=security@corp.local,infadmins@corp.local')
Check "mailCc bound"                      (($out | Where-Object {$_ -like 'CC=*'}) -eq 'CC=monitoring@corp.local')
Check "subject bound"                     (($out | Where-Object {$_ -like 'SUBJ=*'}) -eq 'SUBJ=Service Account Expiration Report')
Check "smtp bound"                        (($out | Where-Object {$_ -like 'SMTP=*'}) -eq 'SMTP=mailrelay.corp.local')
Check "eMailReport bound"                 (($out | Where-Object {$_ -like 'EMAIL=*'}) -eq 'EMAIL=yes')
Check "window bound as '30'"              (($out | Where-Object {$_ -like 'WINDOW=*'}) -eq 'WINDOW=30')

# ── B2: awkward DNs — the escaping chain under stress ─────────────────────────
Write-Host "`nB2 awkward DNs survive JS-JSON -> PS-quote -> ConvertFrom-Json"
$awkInv = Get-Content (Join-Path $scratch 'invocation-awkward.txt') -Raw
$awkOut = @(Invoke-Boundary $awkInv) | Where-Object { $_ -like 'OU=*' }
$expected = @(
    "OU=d.corp.local|OU=O'Brien Service,DC=d,DC=corp,DC=local"
    'OU=d.corp.local|OU=Team "Alpha",DC=d,DC=corp,DC=local'
    'OU=d.corp.local|OU=Back\Slash,DC=d,DC=corp,DC=local'
    'OU=d.corp.local|OU=Comma\, Escaped,DC=d,DC=corp,DC=local'
    'OU=d.corp.local|OU=Dollar$Var,DC=d,DC=corp,DC=local'
)
foreach ($e in $expected) {
    Check ("survives: " + $e.Substring(15, [Math]::Min(26, $e.Length-15))) ($awkOut -contains $e)
}
# The one that would fail SILENTLY and searchably-wrongly: PowerShell expanding $Var
# inside the DN would leave a valid-looking but different search base.
Check "no PowerShell variable expansion"  ($awkOut -notcontains 'OU=d.corp.local|OU=Dollar,DC=d,DC=corp,DC=local')
Check "all 5 survived"                    ($awkOut.Count -eq 5)

# ── B3: apostrophes in the MAIL arguments, not just the DNs ───────────────────
Write-Host "`nB3 apostrophes in subject and recipient survive PS single-quoting"
$qInv = Get-Content (Join-Path $scratch 'invocation-quotes.txt') -Raw
$qOut = @(Invoke-Boundary $qInv)
Check "subject with two apostrophes"      (($qOut | Where-Object {$_ -like 'SUBJ=*'}) -eq "SUBJ=Corp's Service Account Expiry: don't ignore")
Check "recipient with an apostrophe"      (($qOut | Where-Object {$_ -like 'TO=*'})   -eq "TO=o'brien@corp.local")
Check "non-default window binds"          (($qOut | Where-Object {$_ -like 'WINDOW=*'}) -eq 'WINDOW=45')

Write-Host "`n=========================="
Write-Host "PASS: $pass   FAIL: $fail"
if ($fail -gt 0) { exit 1 }
