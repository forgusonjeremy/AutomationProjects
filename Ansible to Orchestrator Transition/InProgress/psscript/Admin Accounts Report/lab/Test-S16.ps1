# Smoke test for the S-16 additions to cvs_functions.ps1.
# Extracts Resolve-DomainOUsMap and GenerateReportPKI-v2 from the script by AST and
# exercises them with fake data, so no AD / SMTP is required.

$src = "E:\GitHub-LocalRepos\AutomationProjects\Ansible to Orchestrator Transition\InProgress\psscript\files\cvs_functions.ps1"

$errors = $null; $tokens = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($src, [ref]$tokens, [ref]$errors)
if ($errors -and $errors.Count -gt 0) { throw "parse errors in source" }

$want = @('Resolve-DomainOUsMap','Get-ListOfUsers-MultiDomain','GenerateReportPKI-v2','Format-HtmlTable','Format-PKIAccountTable','Remove-DuplicateAccounts','Get-ADFailureCategory')
$defs = $ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) |
        Where-Object { $want -contains $_.Name }

foreach ($d in $defs) { . ([scriptblock]::Create($d.Extent.Text)) }

# --- stubs -------------------------------------------------------------------
$Global:DebugDir = Join-Path $PSScriptRoot 'Debug'
$Global:MailSubject = ''
$script:sentBody = $null
function Write-Log { param($InformationItem, $ConsoleOut) Write-Host "    LOG> $InformationItem" }
function SendMail  { param($MailBody, $MailSubject, $MailAttachments) $script:sentBody = $MailBody; Write-Host "    MAIL> body length $($MailBody.Length)" }
$eMailReport = 'yes'

$Error.Clear()
$pass = 0; $fail = 0
function Check($name, $cond) {
    if ($cond) { Write-Host "  PASS  $name" -ForegroundColor Green; $script:pass++ }
    else       { Write-Host "  FAIL  $name" -ForegroundColor Red;   $script:fail++ }
}

# ── T1: inline JSON (the vRO path) — the v2 fork's defect ────────────────────
Write-Host "`nT1 inline JSON via -Json"
$json = '{"domain1.corp.local":["OU=Admin Accounts,OU=Servers,DC=domain1,DC=corp,DC=local","OU=Admin Accounts,OU=Workstations,DC=domain1,DC=corp,DC=local"],"domain2.corp.local":["OU=Admin Accounts,OU=Servers,DC=domain2,DC=corp,DC=local"]}'
$m1 = Resolve-DomainOUsMap -Json $json
Check "map is not null"                 ($null -ne $m1)
Check "2 domains resolved"              (@($m1.PSObject.Properties.Name).Count -eq 2)
Check "domain1 has 2 OUs"               (@($m1.'domain1.corp.local').Count -eq 2)
Check "domain2 has 1 OU"                (@($m1.'domain2.corp.local').Count -eq 1)

# ── T2: JSON file (the legacy Ansible path) ─────────────────────────────────
Write-Host "`nT2 JSON file via -Path"
$tmp = Join-Path $PSScriptRoot 'domain_ous.json'
$json | Set-Content -Path $tmp -Encoding UTF8
$m2 = Resolve-DomainOUsMap -Path $tmp
Check "file map matches inline map"     (@($m2.PSObject.Properties.Name).Count -eq 2)

# ── T3: precedence + empty + malformed + missing file ───────────────────────
Write-Host "`nT3 guards"
$m3 = Resolve-DomainOUsMap -Json '{"ignored.local":["OU=x"]}' -Path $tmp
Check "file wins over inline"           (@($m3.PSObject.Properties.Name) -contains 'domain1.corp.local')
Check "empty input -> null"             ($null -eq (Resolve-DomainOUsMap -Json '   '))
$threw = $false; try { Resolve-DomainOUsMap -Json '{not valid json' } catch { $threw = $true }
Check "malformed JSON throws"           $threw
$threw = $false; try { Resolve-DomainOUsMap -Path 'Z:\nope\missing.json' } catch { $threw = $true }
Check "missing file throws"             $threw

# ── T4: multi-domain query with a null map returns empty, not junk ──────────
Write-Host "`nT4 null-map guard"
Check "null map -> empty result"        (@(Get-ListOfUsers-MultiDomain -DomainOUsMap $null -SC $true).Count -eq 0)

# ── T5: report rendering ────────────────────────────────────────────────────
Write-Host "`nT5 report — structure, per-domain sections, colouring"
# Note domain3 is IN SCOPE (m1s) but returns NO accounts, and domain4 exists only in
# the failure set — both must still appear in the report.
$m1s = Resolve-DomainOUsMap -Json ('{"domain1.corp.local":["OU=Admin Accounts,OU=Servers,DC=domain1,DC=corp,DC=local","OU=Admin Accounts,OU=Workstations,DC=domain1,DC=corp,DC=local"],' +
                                   '"domain2.corp.local":["OU=Admin Accounts,OU=Servers,DC=domain2,DC=corp,DC=local"],' +
                                   '"domain3.corp.local":["OU=Admin Accounts,OU=Servers,DC=domain3,DC=corp,DC=local"]}')
$fake = @(
    [pscustomobject]@{ SamAccountName='ADM.alpha'; UserPrincipalName='ADM.alpha@domain1.corp.local'; smartcardlogonrequired=$true;  displayName='Alpha A'; whenCreated=(Get-Date '2024-01-05'); description='tier1'; Enabled=$true;  SourceDomain='domain1.corp.local'; SourceOU='OU=Admin Accounts,OU=Servers,DC=domain1,DC=corp,DC=local' }
    [pscustomobject]@{ SamAccountName='ADM.bravo'; UserPrincipalName='ADM.bravo@domain1.corp.local'; smartcardlogonrequired=$false; displayName='Bravo B'; whenCreated=(Get-Date '2024-02-05'); description='tier2'; Enabled=$true;  SourceDomain='domain1.corp.local'; SourceOU='OU=Admin Accounts,OU=Servers,DC=domain1,DC=corp,DC=local' }
    [pscustomobject]@{ SamAccountName='ADM.chuck'; UserPrincipalName='ADM.chuck@domain2.corp.local'; smartcardlogonrequired=$false; displayName='Chuck C'; whenCreated=(Get-Date '2024-03-05'); description='stale';  Enabled=$false; SourceDomain='domain2.corp.local'; SourceOU='OU=Admin Accounts,OU=Servers,DC=domain2,DC=corp,DC=local' }
)
GenerateReportPKI-v2 $fake $m1s @()
$b = $script:sentBody
Check "report was produced"              (-not [string]::IsNullOrWhiteSpace($b))
Check "exec summary present"             ($b -match 'Accounts in scope')
Check "overall total = 3"                ($b -match '(?s)Accounts in scope.*?>3<')
Check "compliance rate shown"            ($b -match 'Compliance rate')
Check "by-domain summary present"        ($b -match 'By domain')
Check "detail heading present"           ($b -match 'Account detail by domain')
Check "domain1 has its own section"      ($b -match '<h4[^>]*>domain1\.corp\.local</h4>')
Check "domain2 has its own section"      ($b -match '<h4[^>]*>domain2\.corp\.local</h4>')
Check "in-scope but empty domain shown"  ($b -match '<h4[^>]*>domain3\.corp\.local</h4>')
Check "empty domain explained"           ($b -match 'No accounts were returned')
Check "domain1 status Action required"   ($b -match 'Action required')
Check "friendly column headers"          ($b -match 'Smart card enforced' -and $b -match 'Account state')
Check "raw property names not shown"     ($b -notmatch '<th[^>]*>SmartCardEnabled</th>')
Check "non-compliant shown red"          ($b -match '<font color="#C00000"><b>False</b></font>')
Check "compliant True NOT reddened"      ($b -notmatch '<font color="#C00000"><b>True</b></font>')
Check "disabled shown gray"              ($b -match '<font color="#808080">Disabled</font>')
Check "Enabled not miscoloured"          ($b -notmatch 'color="#808080">Enabled<')
Check "styles are INLINE for Outlook"    ($b -match '<table style="border-collapse' -and $b -match '<td style="border')
Check "no clean-run INCOMPLETE banner"   ($b -notmatch 'THIS REPORT IS INCOMPLETE')
Check "scope footnote present"           ($b -match 'Scope - OUs queried')
Check "footnote lists an OU DN"          ($b -match 'OU=Admin Accounts,OU=Workstations')
Check "report file written"              (Test-Path (Join-Path $Global:DebugDir 'PKI_result.html'))

# overwrite (not append) check
$len1 = (Get-Item (Join-Path $Global:DebugDir 'PKI_result.html')).Length
GenerateReportPKI-v2 $fake $m1s @()
$len2 = (Get-Item (Join-Path $Global:DebugDir 'PKI_result.html')).Length
Check "report overwrites, not appends"   ($len2 -eq $len1)

# ── T6: query failures must be VISIBLE ON THE REPORT ────────────────────────
Write-Host "`nT6 failures surfaced on the report"
# Duplicated pair = the two sweeps (SC true / SC false) hitting the same dead OU.
$fails = @(
    [pscustomobject]@{ Domain='domain2.corp.local'; OU='OU=Admin Accounts,OU=Servers,DC=domain2,DC=corp,DC=local'; Reason='The server is not operational' }
    [pscustomobject]@{ Domain='domain2.corp.local'; OU='OU=Admin Accounts,OU=Servers,DC=domain2,DC=corp,DC=local'; Reason='The server is not operational' }
    [pscustomobject]@{ Domain='domain3.corp.local'; OU='OU=Admin Accounts,OU=Servers,DC=domain3,DC=corp,DC=local'; Reason='Directory object not found' }
)
GenerateReportPKI-v2 $fake $m1s $fails
$bf = $script:sentBody
Check "INCOMPLETE banner shown"          ($bf -match 'THIS REPORT IS INCOMPLETE')
Check "banner warns counts understated"  ($bf -match 'understated')
Check "duplicate failures collapsed"     ($bf -match '2 organisational unit\(s\)')
Check "failure reason surfaced"          ($bf -match 'The server is not operational')
Check "second failure reason surfaced"   ($bf -match 'Directory object not found')
Check "domain summary marks INCOMPLETE"  ($bf -match 'INCOMPLETE &#8212; see alert above')
Check "per-domain partial-list warning"  ($bf -match 'PARTIAL list')
Check "scope footnote flags NOT READ"    ($bf -match 'NOT READ')
# Isolate domain1's own section rather than regexing across section boundaries —
# a lazy .*? will happily run into the NEXT domain's warning and give a false result.
$sections = ($bf -split '<h4[^>]*>') | Where-Object { $_ -match '^domain\d\.corp\.local</h4>' }
$d1Section = @($sections | Where-Object { $_ -like 'domain1.corp.local</h4>*' })[0]
$d2Section = @($sections | Where-Object { $_ -like 'domain2.corp.local</h4>*' })[0]
Check "clean domain1 has no warning"     ($d1Section -notmatch 'PARTIAL list')
Check "failed domain2 HAS the warning"   ($d2Section -match 'PARTIAL list')

# ── T7: null map guard ──────────────────────────────────────────────────────
Write-Host "`nT7 null-map guard"
GenerateReportPKI-v2 $fake $null @()
Check "null map -> scope-unknown note"   ($script:sentBody -match 'report scope unknown')
Check "null map still sections domains"  ($script:sentBody -match '<h4[^>]*>domain1\.corp\.local</h4>')

# ── T9: S-21 — the OU map is the ONLY way to scope this action ──────────────
# S-18's legacy -DomainName/-OUPath fallback was REMOVED once it was confirmed that
# Orchestrator uses a PowerShell host separate from the Ansible templates in both dev
# and production. These tests assert the fallback is genuinely gone, so it cannot
# creep back as a silent alternate path that narrows the report's scope.
Write-Host "`nT9 S-21 no legacy fallback — scope comes only from the OU map"

# Read the SHIPPING switch-case source and assert on it directly. A behavioural test
# alone would not notice the fallback being reintroduced, because a reinstated
# fallback only fires on inputs a passing test never supplies.
$mainSrc = [regex]::Match((Get-Content $src -Raw), '(?s)''Get-AllAdmin-Accounts''\{.*?\n        \}').Value
Check "case source located"                (-not [string]::IsNullOrWhiteSpace($mainSrc))
Check "no OUPath promotion in this action" ($mainSrc -notmatch '\$DomainOUsMap\s*=\s*\[PSCustomObject\]@\{\s*\$DomainName')
Check "no legacy-mode branch remains"      ($mainSrc -notmatch 'LEGACY single-domain mode')
Check "null map is an unconditional throw" ($mainSrc -match 'throw "Get-AllAdmin-Accounts requires a domain/OU map')
Check "throw text names only the two args" ($mainSrc -match 'requires a domain/OU map via -DomainOUs or -DomainOUsFile\."')
Check "no scope -> error mentions no legacy pair" ($mainSrc -notmatch 'or the legacy -DomainName')

# The PARAMETERS must remain — Get-ServiceAccountExpiration still uses them via
# Get-ListOfUsers, so removing them would break a live action.
$full = Get-Content $src -Raw
Check "-OUPath parameter still declared"   ($full -match '\[string\]\$OUPath')
Check "-OUPath still used by Get-ListOfUsers" ($full -match '-searchBase \$OUPath')

# Behavioural: with no map, resolution yields null and the action must fail — there is
# no second chance regardless of what -DomainName/-OUPath happen to hold.
Check "no map -> Resolve returns null"     ($null -eq (Resolve-DomainOUsMap -Json '' -Path ''))

# ── T11: S-19 per-OU sub-sectioning ─────────────────────────────────────────
Write-Host "`nT11 S-19 sub-section by OU within a domain"
$ouMap = Resolve-DomainOUsMap -Json ('{"multi.corp.local":["OU=Servers,OU=Admin,DC=multi,DC=corp,DC=local","OU=Workstations,OU=Admin,DC=multi,DC=corp,DC=local","OU=Empty,OU=Admin,DC=multi,DC=corp,DC=local"],' +
                                     '"single.corp.local":["OU=Only,DC=single,DC=corp,DC=local"]}')
function New-Row($sam,$dom,$ou,$sc){
    [pscustomobject]@{ SamAccountName=$sam; UserPrincipalName="$sam@$dom"; smartcardlogonrequired=$sc
                       displayName=$sam; whenCreated=(Get-Date '2024-01-01'); description='x'; Enabled=$true
                       SourceDomain=$dom; SourceOU=$ou }
}
$srvOU = 'OU=Servers,OU=Admin,DC=multi,DC=corp,DC=local'
$wksOU = 'OU=Workstations,OU=Admin,DC=multi,DC=corp,DC=local'
$multi = @(
    New-Row 'a.srv'  'multi.corp.local'  $srvOU $true
    New-Row 'b.srv'  'multi.corp.local'  $srvOU $false
    New-Row 'c.wks'  'multi.corp.local'  $wksOU $false
    New-Row 'd.only' 'single.corp.local' 'OU=Only,DC=single,DC=corp,DC=local' $true
)
GenerateReportPKI-v2 $multi $ouMap @()
$bo = $script:sentBody
Check "multi-OU domain sub-sections"      ($bo -match [regex]::Escape($srvOU) -and $bo -match [regex]::Escape($wksOU))
Check "domain header still present"       ($bo -match '<h4[^>]*>multi\.corp\.local</h4>')
Check "domain line counts across OUs"     ($bo -match '3 account\(s\) across 3 OUs')
Check "in-scope OU with no accounts shown"($bo -match [regex]::Escape('OU=Empty,OU=Admin,DC=multi,DC=corp,DC=local'))
Check "empty OU explained"                ($bo -match 'No accounts found in this OU')
Check "per-OU counts rendered"            ($bo -match '2 account\(s\), 1 not enforcing')
Check "single-OU domain NOT sub-sectioned" ($bo -notmatch [regex]::Escape('OU=Only,DC=single,DC=corp,DC=local') + '</p>')
Check "OU order follows the scope map"    ($bo.IndexOf($srvOU) -lt $bo.IndexOf($wksOU))
Check "accounts land in the right OU"     ($bo.IndexOf('b.srv') -lt $bo.IndexOf($wksOU) -and $bo.IndexOf('c.wks') -gt $bo.IndexOf($wksOU))
# A dead OU inside a multi-OU domain is labelled at the OU, not just the domain.
GenerateReportPKI-v2 $multi $ouMap @(
    [pscustomobject]@{ Domain='multi.corp.local'; OU=$wksOU; Reason='The server is not operational' }
)
Check "dead OU flagged in its sub-section" ($script:sentBody -match 'This OU could not be read')

# ── T12: S-19 de-duplication (nested OUs, recursive subtree scope) ──────────
Write-Host "`nT12 S-19 de-duplication — each account reported ONCE"
# Subtree scope is RECURSIVE, so listing a parent OU and its child returns the
# child's accounts twice. Simulate that outcome.
$nestMap = Resolve-DomainOUsMap -Json ('{"dup.corp.local":["OU=Admin,DC=dup,DC=corp,DC=local","OU=Servers,OU=Admin,DC=dup,DC=corp,DC=local"]}')
$parentOU = 'OU=Admin,DC=dup,DC=corp,DC=local'
$childOU  = 'OU=Servers,OU=Admin,DC=dup,DC=corp,DC=local'
$dups = @(
    New-Row 'shared.acct' 'dup.corp.local' $parentOU $false   # found by the parent search
    New-Row 'shared.acct' 'dup.corp.local' $childOU  $false   # and again by the child search
    New-Row 'unique.acct' 'dup.corp.local' $parentOU $true
)

# --- the helper itself -------------------------------------------------------
$Global:DuplicateAccounts = @()
$deduped = @(Remove-DuplicateAccounts -Accounts $dups)
Check "duplicate collapsed to one entry"  ($deduped.Count -eq 2)
Check "shared account kept exactly once"  (@($deduped | Where-Object { $_.SamAccountName -eq 'shared.acct' }).Count -eq 1)
Check "unique account untouched"          (@($deduped | Where-Object { $_.SamAccountName -eq 'unique.acct' }).Count -eq 1)
Check "kept the DEEPEST (most specific) OU" (@($deduped | Where-Object { $_.SamAccountName -eq 'shared.acct' })[0].SourceOU -eq $childOU)
Check "duplicate recorded for the report" ($Global:DuplicateAccounts.Count -eq 1)
Check "record names the kept OU"          ($Global:DuplicateAccounts[0].'Counted under' -eq $childOU)
Check "record counts times returned"      ($Global:DuplicateAccounts[0].'Times returned' -eq 2)
# Idempotent: running it again changes nothing and records nothing new.
$again = @(Remove-DuplicateAccounts -Accounts $deduped)
Check "idempotent - second pass is a no-op" ($again.Count -eq 2 -and $Global:DuplicateAccounts.Count -eq 1)

# --- the report --------------------------------------------------------------
$Global:DuplicateAccounts = @()
GenerateReportPKI-v2 $dups $nestMap @() $null
$bd = $script:sentBody
Check "account appears only ONCE in report" (([regex]::Matches($bd,'shared\.acct@')).Count -eq 1)
Check "overlap notice shown"              ($bd -match 'overlapping OU list')
Check "notice says totals are correct"    ($bd -match 'totals are correct' -and $bd -match 'counted once')
Check "NOT worded as inflated"            ($bd -notmatch 'INFLATED')
Check "exec total counts 2, not 3"        ($bd -match '(?s)Accounts in scope.*?>2<')
# The OUs must appear INSIDE the notice, not merely somewhere on the page — every OU
# in scope is listed in the footnote, so a page-wide match would prove nothing.
$dupBanner = ($bd -split 'overlapping OU list')[1]
$dupBanner = ($dupBanner -split 'Summary</h3>')[0]
Check "notice lists both source OUs"      ($dupBanner -match [regex]::Escape($parentOU) -and $dupBanner -match [regex]::Escape($childOU))
Check "notice shows times returned"       ($dupBanner -match '<td[^>]*>2</td>')
# Scope to the DETAIL area: the account name also appears in the overlap notice above,
# so a whole-page IndexOf would find that first and prove nothing about placement.
# Map order is [parentOU, childOU], so the child sub-section comes second.
$detail = ($bd -split 'Account detail by domain')[1]
$detail = ($detail -split 'Scope - OUs queried')[0]
Check "deduped account sits under child OU" ($detail.IndexOf('shared.acct@') -gt $detail.IndexOf($childOU))
Check "non-duplicated account under parent" ($detail.IndexOf('unique.acct@') -lt $detail.IndexOf($childOU))
Check "detail lists the account just once"  (([regex]::Matches($detail,'shared\.acct@')).Count -eq 1)
# No duplicates -> no notice at all.
$Global:DuplicateAccounts = @()
GenerateReportPKI-v2 @($multi) $ouMap @() $null
Check "clean data shows no overlap notice" ($script:sentBody -notmatch 'overlapping OU list')

# ── T13: S-20 failure classification ────────────────────────────────────────
Write-Host "`nT13 S-20 failure classification"
function Get-TestCategory($msg, $type='') { (Get-ADFailureCategory -ExceptionType $type -Message $msg).Category }

# The condition that prompted this: a referral means the server ANSWERED and said the
# naming context is not its own — a targeting problem, not an availability problem.
Check "referral -> Scope error"           ((Get-TestCategory 'A referral was returned from the server') -eq 'Scope error')
Check "no such object -> Scope error"     ((Get-TestCategory 'There is no such object on the server') -eq 'Scope error')
Check "object not found -> Scope error"   ((Get-TestCategory 'Directory object not found') -eq 'Scope error')
Check "bad DN syntax -> Scope error"      ((Get-TestCategory 'The distinguished name has an invalid DN syntax') -eq 'Scope error')
# ...and is NOT confused with the DC being down, which is the whole point.
Check "not operational -> Unreachable"    ((Get-TestCategory 'The server is not operational') -eq 'Unreachable')
Check "RPC unavailable -> Unreachable"    ((Get-TestCategory 'The RPC server is unavailable') -eq 'Unreachable')
Check "timeout -> Unreachable"            ((Get-TestCategory 'The operation timed out') -eq 'Unreachable')
Check "access denied -> Access denied"    ((Get-TestCategory 'Access is denied') -eq 'Access denied')
Check "insufficient rights -> Access denied" ((Get-TestCategory 'Insufficient access rights to perform the operation') -eq 'Access denied')
Check "logon failure -> Authentication"   ((Get-TestCategory 'Logon failure: unknown user name or bad password') -eq 'Authentication')
Check "referral beats unreachable order"  ((Get-TestCategory 'A referral was returned from the server') -ne 'Unreachable')

# Unknown text must NOT be confidently mislabelled.
Check "unknown message -> Unclassified"   ((Get-TestCategory 'Something nobody has seen before') -eq 'Unclassified')
Check "empty message -> Unclassified"     ((Get-TestCategory '') -eq 'Unclassified')
# Type name is a corroborating hint only, used when the message says nothing useful.
Check "type hint used when msg is opaque" ((Get-TestCategory 'unrecognised text' 'ADServerDownException') -eq 'Unreachable')
Check "message wins over type hint"       ((Get-TestCategory 'A referral was returned from the server' 'ADServerDownException') -eq 'Scope error')
Check "unknown type falls through"        ((Get-TestCategory 'unrecognised text' 'SomeFutureException') -eq 'Unclassified')
Check "every category carries guidance"   (@('A referral was returned from the server','The server is not operational','Access is denied','Logon failure','zzz' |
                                              ForEach-Object { (Get-ADFailureCategory -Message $_).Guidance } |
                                              Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count -eq 0)

# --- rendered on the report --------------------------------------------------
$clsFails = @(
    [pscustomobject]@{ Domain='multi.corp.local'; OU=$wksOU; Category='Scope error'; Reason='A referral was returned from the server'; Guidance='Correct the OU list - retrying will not help.'; ExceptionType='ADReferralException' }
    [pscustomobject]@{ Domain='single.corp.local'; OU='OU=Only,DC=single,DC=corp,DC=local'; Category='Unreachable'; Reason='The server is not operational'; Guidance='Check DNS, network path and DC health.'; ExceptionType='ADServerDownException' }
)
GenerateReportPKI-v2 $multi $ouMap $clsFails $null
$bc = $script:sentBody
Check "report shows Problem column"       ($bc -match '<th[^>]*>Problem</th>')
Check "report shows What to do column"    ($bc -match 'What to do')
Check "scope error rendered + coloured"   ($bc -match '<font color="#C00000"><b>Scope error</b></font>')
Check "unreachable rendered + coloured"   ($bc -match '<font color="#B26B00"><b>Unreachable</b></font>')
Check "guidance text surfaced"            ($bc -match 'retrying will not help')
Check "category breakdown in banner"      ($bc -match '1 scope error' -and $bc -match '1 unreachable')
Check "per-OU note names the category"    ($bc -match 'This OU could not be read: <b>Scope error</b>')

# Legacy failure records (no Category/Guidance) must still render, not blank out.
$legacyFails = @(
    [pscustomobject]@{ Domain='multi.corp.local'; OU=$wksOU; Reason='Some older failure record' }
)
GenerateReportPKI-v2 $multi $ouMap $legacyFails $null
Check "records w/o Category -> Unclassified" ($script:sentBody -match '<font color="#666666">Unclassified</font>')
Check "records w/o Guidance get a fallback"  ($script:sentBody -match 'Read the detail and the workflow transcript')

# ── T10: no SILENT errors (must run LAST — it sweeps $Error) ────────────────
# A non-terminating error (e.g. a parameter that will not bind) does not stop the
# script and does not fail any assertion above — it just makes content quietly
# disappear. That is exactly how the Format-HtmlTable [string]/Object[] binding bug
# hid: every styled table evaluated to nothing while the report still looked valid.
# The expected errors are the deliberate throws in T3, which are caught there.
Write-Host "`nT10 no unexpected non-terminating errors"
$unexpected = @($Error | Where-Object {
    $_.CategoryInfo.Category -ne 'OperationStopped' -and
    $_.Exception.Message -notmatch 'not valid JSON|DomainOUsFile not found|Conversion from JSON failed'
})
if ($unexpected.Count -gt 0) {
    Write-Host "    Unexpected errors:" -ForegroundColor Yellow
    $unexpected | Select-Object -First 5 | ForEach-Object { Write-Host "      $($_.Exception.Message)" -ForegroundColor Yellow }
}
Check "no unexpected errors raised"      ($unexpected.Count -eq 0)

Write-Host "`n=========================="
Write-Host "PASS: $pass   FAIL: $fail"
if ($fail -gt 0) { exit 1 }



