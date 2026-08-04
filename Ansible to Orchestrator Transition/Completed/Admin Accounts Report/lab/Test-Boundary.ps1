# Cross-language boundary test: take the invocation string the vRO action actually
# emits, execute it against a stub that mirrors the real param block, and confirm the
# domain/OU map reconstructed by Resolve-DomainOUsMap is byte-identical to the input.
# This is what validates the JS-JSON -> PowerShell-single-quote -> ConvertFrom-Json chain.

$scratch = $PSScriptRoot
$real    = "E:\GitHub-LocalRepos\AutomationProjects\Ansible to Orchestrator Transition\InProgress\psscript\files\cvs_functions.ps1"

# --- stub script: same relevant params as cvs_functions.ps1, prints the parsed map --
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
    [string]$DomainOUsFile
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
foreach ($d in @($map.PSObject.Properties.Name)) {
    foreach ($ou in @($map.$d)) { Write-Output "OU=$d|$ou" }
}
'@ | Set-Content -Path $stub -Encoding UTF8

# splice the REAL Resolve-DomainOUsMap in, so we test the shipping parser
$errors=$null;$tokens=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($real,[ref]$tokens,[ref]$errors)
$resolver=($ast.FindAll({$args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst]},$true) |
    Where-Object { $_.Name -eq 'Resolve-DomainOUsMap' }).Extent.Text
(Get-Content $stub -Raw).Replace('__RESOLVER__',$resolver) | Set-Content -Path $stub -Encoding UTF8

$pass=0;$fail=0
function Check($name,$cond){ if($cond){Write-Host "  PASS  $name" -ForegroundColor Green;$script:pass++}else{Write-Host "  FAIL  $name" -ForegroundColor Red;$script:fail++} }

function Invoke-Boundary($invocation) {
    # swap the placeholder script path for the stub, keeping everything else verbatim
    $cmd = $invocation -replace '(?s)^& "[^"]*"', ('& "' + $stub + '"')
    $cmd = $cmd -replace '\s\*>&1 \| Out-String -Width 4096$',''   # keep raw lines for assertions
    return (Invoke-Expression $cmd)
}

# ── B1: the production 7x2 scope, straight from the action's own output ────────
Write-Host "`nB1 production scope (7 domains x 2 OUs) through the real invocation string"
$inv = Get-Content (Join-Path $scratch 'invocation.txt') -Raw
$out = @(Invoke-Boundary $inv)
$ouLines = @($out | Where-Object { $_ -like 'OU=*' })
Check "invocation parsed & executed"      ($out.Count -gt 0)
Check "Action bound correctly"            (($out | Where-Object {$_ -like 'ACTION=*'}) -eq 'ACTION=Get-AllAdmin-Accounts')
Check "14 OUs reconstructed"              ($ouLines.Count -eq 14)
Check "domain4 servers OU intact"         ($ouLines -contains 'OU=domain4.corp.local|OU=Admin Accounts,OU=Servers,DC=domain4,DC=corp,DC=local')
Check "domain7 workstations OU intact"    ($ouLines -contains 'OU=domain7.corp.local|OU=Admin Accounts,OU=Workstations,DC=domain7,DC=corp,DC=local')
Check "mailTo bound"                      (($out | Where-Object {$_ -like 'TO=*'}) -eq 'TO=user1@corp.local,user2@corp.local')
Check "mailCc bound"                      (($out | Where-Object {$_ -like 'CC=*'}) -eq 'CC=user5@corp.local')
Check "subject bound (spaces+colon)"      (($out | Where-Object {$_ -like 'SUBJ=*'}) -eq 'SUBJ=Report: Admin PKI Card Status')
Check "smtp bound"                        (($out | Where-Object {$_ -like 'SMTP=*'}) -eq 'SMTP=smtp.corp.local')
Check "eMailReport bound"                 (($out | Where-Object {$_ -like 'EMAIL=*'}) -eq 'EMAIL=yes')

# ── B2: awkward DNs — the escaping chain under stress ─────────────────────────
Write-Host "`nB2 awkward DNs survive JS-JSON -> PS-quote -> ConvertFrom-Json"
$awkInv = Get-Content (Join-Path $scratch 'invocation-awkward.txt') -Raw
$awkOut = @(Invoke-Boundary $awkInv) | Where-Object { $_ -like 'OU=*' }
$expected = @(
    "OU=d.corp.local|OU=O'Brien Admins,DC=d,DC=corp,DC=local"
    'OU=d.corp.local|OU=Team "Alpha",DC=d,DC=corp,DC=local'
    'OU=d.corp.local|OU=Back\Slash,DC=d,DC=corp,DC=local'
    'OU=d.corp.local|OU=Comma\, Escaped,DC=d,DC=corp,DC=local'
    'OU=d.corp.local|OU=Dollar$Var,DC=d,DC=corp,DC=local'
)
foreach ($e in $expected) {
    Check ("survives: " + $e.Substring(15, [Math]::Min(26, $e.Length-15))) ($awkOut -contains $e)
}
Check "no PowerShell variable expansion"  ($awkOut -notcontains 'OU=d.corp.local|OU=Dollar,DC=d,DC=corp,DC=local')

Write-Host "`n=========================="
Write-Host "PASS: $pass   FAIL: $fail"
if ($fail -gt 0) { exit 1 }
