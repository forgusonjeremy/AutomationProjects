<#
.SYNOPSIS
    Offline regression tests for the S-22 / S-23 changes to cvs_functions.ps1.

.DESCRIPTION
    Covers the service account expiration report end to end EXCEPT the Get-ADUser
    calls themselves: expiry classification, the FILETIME sentinel handling, table
    ordering, report structure, failure surfacing, de-duplication, and the guards in
    the Get-ServiceAccountExpiration action case.

    NO Active Directory, SMTP, PowerShell host or vRO appliance is required - Write-Log
    and SendMail are stubbed and the account data is synthetic.

    The functions under test are loaded OUT OF THE LIVE cvs_functions.ps1 BY AST rather
    than copied here, so this suite cannot drift from the shipping code. If a function
    is renamed or removed, the suite fails loudly instead of silently testing nothing.

    TWO KINDS OF TEST LIVE HERE, deliberately:

      BEHAVIOURAL - run the function, assert on what it produced.
      SOURCE      - assert against the shipping switch-case TEXT.

    The source assertions exist because the action case cannot be executed offline (it
    needs a directory), and because a behavioural test cannot catch a regression that
    only fires on inputs a passing test never supplies. The prime example is the
    omitted -SC argument that caused defect S-22/1: re-adding `-SC $false` to the sweep
    would silently narrow the report again, and every behavioural test here would still
    pass. So the absence of that argument is asserted against the source itself.

.PARAMETER ScriptPath
    Path to the cvs_functions.ps1 under test. Defaults to the InProgress working copy.
    UPDATE THIS DEFAULT when the script is promoted to
    Completed\_Shared References\psscript\files\.

.EXAMPLE
    .\Test-S22.ps1
#>
[CmdletBinding()]
param(
    [string] $ScriptPath = "e:\GitHub-LocalRepos\AutomationProjects\Ansible to Orchestrator Transition\InProgress\psscript\files\cvs_functions.ps1"
)

$ErrorActionPreference = 'Continue'

if (-not (Test-Path -LiteralPath $ScriptPath)) {
    Write-Host "FATAL: script under test not found: $ScriptPath" -ForegroundColor Red
    exit 1
}

# ── Load the functions under test, by AST ────────────────────────────────────
$parseErrors = $null; $tokens = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($ScriptPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) {
    Write-Host "FATAL: $ScriptPath does not parse:" -ForegroundColor Red
    $parseErrors | ForEach-Object { Write-Host ("  line {0}: {1}" -f $_.Extent.StartLineNumber, $_.Message) -ForegroundColor Red }
    exit 1
}

$needed = @(
    'ConvertFrom-ADFileTime','Get-AccountExpiryState','Sort-ServiceAccountRows',
    'Get-ServiceAccountSectionNote','Format-ServiceAccountTable',
    'GenerateReportServiceAccountExpiration',
    # shared helpers introduced by the Admin Accounts Report deliverable (S-16 … S-20)
    'Format-HtmlTable','Remove-DuplicateAccounts','Get-ADFailureCategory'
)
foreach ($n in $needed) {
    $fn = $ast.FindAll({ param($x)
        $x -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq $n }, $true)
    if ($fn.Count -eq 0) {
        Write-Host "FATAL: function '$n' not found in $ScriptPath - the suite is testing a stale contract." -ForegroundColor Red
        exit 1
    }
    . ([scriptblock]::Create($fn[0].Extent.Text))
}

# The shipping text of the Get-ServiceAccountExpiration switch case, for the SOURCE
# assertions in section 8.
$mainAst = $ast.FindAll({ param($x)
    $x -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq 'Main' }, $true)[0]
$switchAst = $mainAst.FindAll({ param($x)
    $x -is [System.Management.Automation.Language.SwitchStatementAst] }, $true)[0]
$caseText = $null
foreach ($clause in $switchAst.Clauses) {
    if ($clause.Item1.Extent.Text -match 'Get-ServiceAccountExpiration') { $caseText = $clause.Item2.Extent.Text }
}
if ($null -eq $caseText) {
    Write-Host "FATAL: the 'Get-ServiceAccountExpiration' case was not found in Main()." -ForegroundColor Red
    exit 1
}
$fullSource = Get-Content -Raw -LiteralPath $ScriptPath

# CODE ONLY - comments stripped by re-tokenising the case.
#
# This matters more than it looks. The case is heavily commented, and the comments
# QUOTE THE OLD DEFECTIVE CODE verbatim ("the old code called Get-ListOfUsers ...",
# "$Result += $Result2 - $Result2 IS NEVER ASSIGNED"). An absence assertion run against
# the raw text therefore fails on its own documentation, and - far worse - the obvious
# "fix" would be to delete the comments that explain why the defect existed. Assert
# against the executable tokens and the documentation stays free to describe history.
$caseTokens = $null; $caseErr = $null
[System.Management.Automation.Language.Parser]::ParseInput($caseText, [ref]$caseTokens, [ref]$caseErr) | Out-Null
$caseCode = (@($caseTokens | Where-Object { $_.Kind -ne 'Comment' } | ForEach-Object { $_.Text })) -join ' '

# ── Stubs ────────────────────────────────────────────────────────────────────
$script:LogLines = @()
function Write-Log { param($InformationItem, $Echo) $script:LogLines += "$InformationItem" }
$script:MailBody = $null
$script:MailCount = 0
function SendMail { param($MailBody, $MailSubject, $MailAttachments) $script:MailBody = $MailBody; $script:MailCount++ }

$Global:DebugDir           = Join-Path $PSScriptRoot 'Debug'
$Global:Today              = Get-Date
$Global:DuplicateAccounts  = @()
$Global:QueryFailures      = @()
$eMailReport               = 'yes'

# ── Test plumbing ────────────────────────────────────────────────────────────
$script:pass = 0; $script:fail = 0
function Check([string]$Name, $Condition) {
    if ($Condition) { Write-Host "  PASS  $Name" -ForegroundColor Green; $script:pass++ }
    else            { Write-Host "  FAIL  $Name" -ForegroundColor Red;   $script:fail++ }
}
function Section([string]$Title) { Write-Host ""; Write-Host $Title -ForegroundColor Cyan }

function New-Acct {
    param($Sam, $Expires, $PwdLastSet, $Enabled = $true, $Locked = $false,
          $Domain = 'corp.local', $OU = 'OU=Service Accounts,DC=corp,DC=local', $Desc = '')
    [PSCustomObject]@{
        SamAccountName = $Sam; DisplayName = "$Sam display"; Office = 'HQ'
        Enabled = $Enabled; LockedOut = $Locked
        AccountExpirationDate = $Expires; pwdLastSet = $PwdLastSet
        WhenCreated = (Get-Date).AddYears(-2); Description = $Desc
        SourceDomain = $Domain; SourceOU = $OU
    }
}
function AsFileTime([datetime]$d) { $d.ToFileTime() }

$now = Get-Date

# ═════════════════════════════════════════════════════════════════════════════
Section '1. ConvertFrom-ADFileTime - the FILETIME sentinels (S-22 defect 2)'
# The defect being guarded: pwdLastSet = 0 means "never set / must change at next
# logon". v1 reported it as a password age of ZERO - identical to a password changed
# this morning, and sorted to the BOTTOM of an age-descending report. The rows most
# in need of attention looked like the freshest ones.
Check 'zero -> null (never set)'        ($null -eq (ConvertFrom-ADFileTime -FileTime 0))
Check 'null -> null'                    ($null -eq (ConvertFrom-ADFileTime -FileTime $null))
Check 'empty string -> null'            ($null -eq (ConvertFrom-ADFileTime -FileTime ''))
Check 'negative -> null'                ($null -eq (ConvertFrom-ADFileTime -FileTime -1))
Check 'Int64 max ("never") -> null'     ($null -eq (ConvertFrom-ADFileTime -FileTime 0x7FFFFFFFFFFFFFFF))
Check 'non-numeric -> null, no throw'   ($null -eq (ConvertFrom-ADFileTime -FileTime 'not-a-number'))
Check 'valid Int64 round-trips'         ((ConvertFrom-ADFileTime -FileTime (AsFileTime $now.AddDays(-3))).Date -eq $now.AddDays(-3).Date)
Check 'valid numeric STRING round-trips'((ConvertFrom-ADFileTime -FileTime ("$(AsFileTime $now.AddDays(-3))")).Date -eq $now.AddDays(-3).Date)
# FromFileTime (local) not FromFileTimeUTC: v1 mixed the two, so the age column and
# the last-set column disagreed by the host's UTC offset.
$rt = ConvertFrom-ADFileTime -FileTime (AsFileTime $now.AddHours(-1))
Check 'local time basis, not UTC'       ([math]::Abs(($now - $rt).TotalHours - 1) -lt 0.01)

# ═════════════════════════════════════════════════════════════════════════════
Section '2. Get-AccountExpiryState - classification'
Check 'null date -> Never expires'      ((Get-AccountExpiryState -ExpirationDate $null -Now $now).State -eq 'Never expires')
Check 'empty -> Never expires'          ((Get-AccountExpiryState -ExpirationDate '' -Now $now).State -eq 'Never expires')
Check 'past -> Expired'                 ((Get-AccountExpiryState -ExpirationDate $now.AddDays(-1) -Now $now).State -eq 'Expired')
Check 'within window -> Expiring'       ((Get-AccountExpiryState -ExpirationDate $now.AddDays(5) -WithinDays 30 -Now $now).State -eq 'Expiring')
Check 'beyond window -> Active'         ((Get-AccountExpiryState -ExpirationDate $now.AddDays(200) -WithinDays 30 -Now $now).State -eq 'Active')
Check 'AD sentinel 1601 -> Never'       ((Get-AccountExpiryState -ExpirationDate ([datetime]'1601-01-01') -Now $now).State -eq 'Never expires')
Check 'AD sentinel 9999 -> Never'       ((Get-AccountExpiryState -ExpirationDate ([datetime]'9999-12-31') -Now $now).State -eq 'Never expires')
Check 'garbage date -> Never, no throw' ((Get-AccountExpiryState -ExpirationDate 'not-a-date' -Now $now).State -eq 'Never expires')

# The window is INCLUSIVE at its edge and rounds toward warning EARLY - warning one
# run late is the failure this report exists to prevent.
Check 'edge: 29.6d IS inside a 29d win' ((Get-AccountExpiryState -ExpirationDate $now.AddDays(29.6) -WithinDays 29 -Now $now).State -eq 'Expiring')
Check 'edge: exactly 30d in a 30d win'  ((Get-AccountExpiryState -ExpirationDate $now.AddDays(30) -WithinDays 30 -Now $now).State -eq 'Expiring')
Check 'edge: 31d outside a 30d win'     ((Get-AccountExpiryState -ExpirationDate $now.AddDays(31) -WithinDays 30 -Now $now).State -eq 'Active')
Check 'window 0 = expiring today only'  ((Get-AccountExpiryState -ExpirationDate $now.AddHours(6) -WithinDays 0 -Now $now).State -eq 'Expiring')
Check 'window 0 excludes tomorrow'      ((Get-AccountExpiryState -ExpirationDate $now.AddDays(1.5) -WithinDays 0 -Now $now).State -eq 'Active')

Check 'DaysToExpiry positive when future' ((Get-AccountExpiryState -ExpirationDate $now.AddDays(10) -Now $now).DaysToExpiry -eq 10)
Check 'DaysToExpiry NEGATIVE when expired'((Get-AccountExpiryState -ExpirationDate $now.AddDays(-10) -Now $now).DaysToExpiry -lt 0)
Check 'DaysToExpiry null when no expiry'  ($null -eq (Get-AccountExpiryState -ExpirationDate $null -Now $now).DaysToExpiry)
Check 'ExpiresOn echoed back'             ((Get-AccountExpiryState -ExpirationDate $now.AddDays(10) -Now $now).ExpiresOn.Date -eq $now.AddDays(10).Date)

# ═════════════════════════════════════════════════════════════════════════════
Section '3. Sort-ServiceAccountRows - worst first, on numeric keys'
$sorted = Sort-ServiceAccountRows -Rows @(
    [PSCustomObject]@{ ExpiryState='Never expires'; DaysToExpiry=$null; PWAgeDays=$null; SamAccountName='never-unset-pw' }
    [PSCustomObject]@{ ExpiryState='Active';        DaysToExpiry=300;   PWAgeDays=5;     SamAccountName='active' }
    [PSCustomObject]@{ ExpiryState='Expiring';      DaysToExpiry=20;    PWAgeDays=10;    SamAccountName='expiring-late' }
    [PSCustomObject]@{ ExpiryState='Expired';       DaysToExpiry=-5;    PWAgeDays=10;    SamAccountName='expired' }
    [PSCustomObject]@{ ExpiryState='Expiring';      DaysToExpiry=2;     PWAgeDays=10;    SamAccountName='expiring-soon' }
    [PSCustomObject]@{ ExpiryState='Never expires'; DaysToExpiry=$null; PWAgeDays=900;   SamAccountName='never-old-pw' }
)
Check 'expired first'                   ($sorted[0].SamAccountName -eq 'expired')
Check 'then soonest expiring'           ($sorted[1].SamAccountName -eq 'expiring-soon')
Check 'then later expiring'             ($sorted[2].SamAccountName -eq 'expiring-late')
Check 'then active'                     ($sorted[3].SamAccountName -eq 'active')
Check 'never-expires last'              ($sorted[4].ExpiryState -eq 'Never expires' -and $sorted[5].ExpiryState -eq 'Never expires')
Check 'unset password ABOVE old one'    ($sorted[4].SamAccountName -eq 'never-unset-pw')
# Numeric, not lexical: "9" must not sort after "80".
$num = Sort-ServiceAccountRows -Rows @(
    [PSCustomObject]@{ ExpiryState='Expiring'; DaysToExpiry=9;  PWAgeDays=1; SamAccountName='nine' }
    [PSCustomObject]@{ ExpiryState='Expiring'; DaysToExpiry=80; PWAgeDays=1; SamAccountName='eighty' }
)
Check 'numeric not lexical ordering'    ($num[0].SamAccountName -eq 'nine')
Check 'empty input -> empty, no throw'  ((Sort-ServiceAccountRows -Rows @()).Count -eq 0)
Check 'null input -> empty, no throw'   ((Sort-ServiceAccountRows -Rows $null).Count -eq 0)

Section '4. Get-ServiceAccountSectionNote'
$note = Get-ServiceAccountSectionNote -Rows @(
    [PSCustomObject]@{ ExpiryState='Expired' }, [PSCustomObject]@{ ExpiryState='Expiring' },
    [PSCustomObject]@{ ExpiryState='Never expires' }, [PSCustomObject]@{ ExpiryState='Active' })
Check 'counts the rows'                 ($note -match '^4 account\(s\)')
Check 'names the expired'               ($note -match '1 expired')
Check 'names the expiring'              ($note -match '1 expiring')
Check 'names the no-expiry'             ($note -match '1 with no expiry date')
$clean = Get-ServiceAccountSectionNote -Rows @([PSCustomObject]@{ ExpiryState='Active' })
Check 'clean section says only a count' ($clean -eq '1 account(s).')
$pref = Get-ServiceAccountSectionNote -Rows @([PSCustomObject]@{ ExpiryState='Expired' }) -Prefix '9 account(s) across 3 OUs'
Check 'prefix overrides the count'      ($pref -match '^9 account\(s\) across 3 OUs' -and $pref -match '1 expired')

# ═════════════════════════════════════════════════════════════════════════════
Section '5. Report structure - the S-23 rebuild'
$accounts = @(
    New-Acct 'svc-expired'  $now.AddDays(-10) (AsFileTime $now.AddDays(-400)) -Desc 'legacy batch job'
    New-Acct 'svc-soon'     $now.AddDays(5)   (AsFileTime $now.AddDays(-90))  -Desc 'sql agent'
    New-Acct 'svc-neverpw'  $null             0                               -Desc 'password never set'
    New-Acct 'svc-ok'       $now.AddDays(200) (AsFileTime $now.AddDays(-5))   -Domain 'other.local' -OU 'OU=Svc,DC=other,DC=local'
    New-Acct 'svc-locked'   $now.AddDays(29)  (AsFileTime $now.AddDays(-800)) -Locked $true -Domain 'other.local' -OU 'OU=Svc,DC=other,DC=local'
    New-Acct 'svc-disabled' $now.AddDays(-3)  (AsFileTime $now.AddDays(-50))  -Enabled $false -Domain 'other.local' -OU 'OU=Svc,DC=other,DC=local'
)
$map = [PSCustomObject]@{}
$map | Add-Member -NotePropertyName 'corp.local'  -NotePropertyValue @('OU=Service Accounts,DC=corp,DC=local')
$map | Add-Member -NotePropertyName 'other.local' -NotePropertyValue @('OU=Svc,DC=other,DC=local','OU=Empty,DC=other,DC=local')

$script:LogLines = @(); $script:MailBody = $null; $script:MailCount = 0
$Error.Clear()
GenerateReportServiceAccountExpiration $accounts $map @() @() 30
$body = $script:MailBody

# The S-17 lesson: a NON-terminating error can empty a table while the report still
# sends and still looks well-formed. No content assertion would catch that, so the
# suite fails on ANY unexpected error record.
Check 'NO non-terminating errors'       ($Error.Count -eq 0)
if ($Error.Count -gt 0) { $Error | ForEach-Object { Write-Host "        $_" -ForegroundColor DarkRed } }

Check 'report was emailed once'         ($script:MailCount -eq 1)
Check 'body is not empty'               (-not [string]::IsNullOrWhiteSpace($body))
Check 'titled as an expiration report'  ($body -match 'Service Account Expiration Report')
Check 'states the look-ahead window'    ($body -match 'Look-ahead window: 30 day')

# THE headline defect: v1 never rendered an expiration date at all.
Check 'EXPIRATION DATE column present'  ($body -match '>Expires on<')
Check 'expiry date VALUE rendered'      ($body -match $now.AddDays(-10).ToString('yyyy-MM-dd'))
Check 'days-to-expiry column present'   ($body -match '>Days to expiry<')

Check 'exec summary: accounts in scope' ($body -match 'Accounts in scope')
Check 'exec summary: already expired'   ($body -match 'Already expired')
Check 'exec summary: expiring within'   ($body -match 'Expiring within 30 day')
Check 'exec summary: no expiry set'     ($body -match 'No expiry date set')

Check 'ACTION section: expired table'   ($body -match 'Already expired &#8212; 2 account')
Check 'ACTION section: expiring table'  ($body -match 'Expiring within 30 day\(s\) &#8212; 2 account')
Check 'action tables carry a Domain col'($body -match '>Domain</th>')
Check 'per-domain summary present'      ($body -match '>By domain<' -or $body -match 'By domain')
Check 'full inventory present'          ($body -match 'Full inventory by domain')
Check 'empty OU still gets a heading'   ($body -match 'No accounts found in this OU')
Check 'scope footnote present'          ($body -match 'Scope - OUs queried')
Check 'footnote says searches recurse'  ($body -match 'include all sub-OUs')

Check 'password never set flagged'      ($body -match '>Never set<')
Check 'never-set is coloured as urgent' ($body -match '#C00000"><b>Never set')
Check 'locked out surfaced'             ($body -match 'Locked out')
Check 'disabled account surfaced'       ($body -match '>Disabled<')

# Outlook renders with the Word engine, which ignores most of a <style> block.
Check 'styles are INLINE for Outlook'   ($body -match '<table style=')
Check 'no <style> block relied upon'    ($body -notmatch '<style>')

# v1 wrote the whole HTML body to the log - the stream vRO classifies on.
Check 'HTML is NOT written to the log'  (-not ($script:LogLines | Where-Object { $_ -match '<table|<html|<div' }))
Check 'one-line summary IS logged'      ($script:LogLines | Where-Object { $_ -match 'account\(s\) in scope, 2 expired, 2 expiring' })

# v1 appended, so the file grew without bound across scheduled runs.
$outFile = Join-Path $Global:DebugDir 'ServiceAccountExpiration_result.html'
Check 'report written to Debug folder'  (Test-Path $outFile)
$len1 = (Get-Item $outFile).Length
GenerateReportServiceAccountExpiration $accounts $map @() @() 30
$len2 = (Get-Item $outFile).Length
Check 'file OVERWRITTEN, not appended'  ($len2 -le $len1 * 1.05)

# ═════════════════════════════════════════════════════════════════════════════
Section '6. Failure surfacing (S-16 / S-20 machinery, reused)'
$failures = @(
    [PSCustomObject]@{ Domain='other.local'; OU='OU=Dead,DC=other,DC=local'; Category='Unreachable'
                       Reason='The server is not operational'; Guidance='Check DNS, network path and DC health.'
                       ExceptionType='ADServerDownException' }
    [PSCustomObject]@{ Domain='corp.local';  OU='OU=Typo,DC=corp,DC=local';  Category='Scope error'
                       Reason='A referral was returned from the server'; Guidance='Correct the OU list.'
                       ExceptionType='ADReferralException' }
)
$script:MailBody = $null
$Error.Clear()
GenerateReportServiceAccountExpiration $accounts $map $failures @() 30
$bodyF = $script:MailBody
Check 'no errors on the failure path'   ($Error.Count -eq 0)
Check 'INCOMPLETE banner shown'         ($bodyF -match 'THIS REPORT IS INCOMPLETE')
Check 'banner counts the OUs and domains'($bodyF -match '2 organisational unit\(s\) across 2 domain\(s\)')
Check 'category breakdown in banner'    ($bodyF -match '1 scope error' -and $bodyF -match '1 unreachable')
Check 'per-category guidance rendered'  ($bodyF -match 'Correct the OU list')
Check 'What to do column present'       ($bodyF -match 'What to do')
Check 'per-domain PARTIAL warning'      ($bodyF -match 'could not be read - the accounts below are a PARTIAL list')
Check 'NOT READ flag in the footnote'   ($bodyF -match 'NOT READ')
Check 'says an expiring acct is missed' ($bodyF -match 'will not appear here and will not warn anyone')

# A failure record written before the S-20 classifier existed carries no Category or
# Guidance. It must still render, degraded, rather than producing blank cells.
$legacyFail = @([PSCustomObject]@{ Domain='corp.local'; OU='OU=Old,DC=corp,DC=local'; Reason='some older message' })
$script:MailBody = $null
GenerateReportServiceAccountExpiration $accounts $map $legacyFail @() 30
Check 'legacy failure record degrades'  ($script:MailBody -match 'Unclassified')
Check 'and keeps its raw message'       ($script:MailBody -match 'some older message')

# ═════════════════════════════════════════════════════════════════════════════
Section '7. De-duplication (S-19, inherited)'
# Subtree searches are recursive, so an OU list holding a parent AND a child returns
# the deeper accounts twice.
$Global:DuplicateAccounts = @()
$dupAccounts = @(
    New-Acct 'svc-dup' $now.AddDays(5) (AsFileTime $now.AddDays(-10)) -OU 'OU=Service Accounts,DC=corp,DC=local'
    New-Acct 'svc-dup' $now.AddDays(5) (AsFileTime $now.AddDays(-10)) -OU 'OU=Tier1,OU=Service Accounts,DC=corp,DC=local'
)
$dupMap = [PSCustomObject]@{}
$dupMap | Add-Member -NotePropertyName 'corp.local' -NotePropertyValue @('OU=Service Accounts,DC=corp,DC=local','OU=Tier1,OU=Service Accounts,DC=corp,DC=local')
$script:MailBody = $null
GenerateReportServiceAccountExpiration $dupAccounts $dupMap @() $null 30
$bodyD = $script:MailBody
Check 'duplicate collapsed to one row'  (([regex]::Matches($bodyD, '>svc-dup<')).Count -ge 1)
Check 'counted ONCE in the summary'     ($bodyD -match 'Expiring within 30 day\(s\) &#8212; 1 account')
Check 'overlapping-scope notice shown'  ($bodyD -match 'overlapping OU list')
Check 'notice says totals are correct'  ($bodyD -match 'totals are correct')
Check 'kept under the DEEPEST OU'       ($bodyD -match 'OU=Tier1,OU=Service Accounts')

# ═════════════════════════════════════════════════════════════════════════════
Section '8. SOURCE assertions on the action case - regression guards'
# These assert against the SHIPPING switch-case text. A behavioural test cannot catch
# any of them, because each regression only fires on inputs a passing test never
# supplies (see the header note).

# S-22 defect 1 - THE critical one. Get-ListOfUsers-MultiDomain must be called with NO
# -SC argument, so the query reaches -Filter * and returns EVERY account. Re-adding
# `-SC $false` would silently narrow the report to non-smartcard accounts again and
# every other test here would still pass.
Check 'sweep calls the MULTI-DOMAIN fn'   ($caseCode -match 'Get-ListOfUsers-MultiDomain')
Check 'sweep passes NO -SC argument'      ($caseCode -notmatch 'Get-ListOfUsers-MultiDomain[^\r\n]*-SC')
Check 'legacy Get-ListOfUsers NOT called' ($caseCode -notmatch '(?<!-)\bGet-ListOfUsers\b(?!-MultiDomain)')

# S-22 defect 4 - the phantom $Result2 that appended a $null row to every report.
Check 'no unassigned $Result2 append'     ($caseCode -notmatch '\$Result2')

# S-22 defect 3 - a missing AD module must FAIL the run, not fall through and send
# nothing (which is indistinguishable from a report with no findings).
Check 'AD module guard THROWS'            ($caseText -match 'throw\s+"ActiveDirectory module not available')
Check 'no silent fall-through on module'  ($caseCode -notmatch 'if\s*\(\s*Invoke-Module')

# Scope guards - no map means the run fails rather than reporting a narrower scope.
Check 'scope resolved via the OU map'     ($caseText -match 'Resolve-DomainOUsMap')
Check 'null map THROWS'                   ($caseText -match 'throw\s+"Get-ServiceAccountExpiration requires a domain/OU map')
# The S-21 lesson: no legacy -DomainName/-OUPath fallback may be reinstated here.
Check 'NO legacy -OUPath fallback'        ($caseCode -notmatch '\$OUPath')
Check 'NO legacy -DomainName fallback'    ($caseCode -notmatch 'DomainName\s*=|-DomainName\s+\$DomainName')

# Counting order - dedup must happen BEFORE the counts, or the subject line advertises
# figures the report body contradicts.
Check 'dedup called before counting'      ($caseCode.IndexOf('Remove-DuplicateAccounts') -gt 0 -and
                                           $caseCode.IndexOf('Remove-DuplicateAccounts') -lt $caseCode.IndexOf('$Global:MailSubject'))
# Subject and body must classify identically - same function, not a re-implementation.
Check 'subject counts use the classifier' ($caseText -match 'Get-AccountExpiryState')
Check 'subject carries expired/expiring'  ($caseText -match '\$expired expired - \$expiring expiring within')
Check 'INCOMPLETE prefix on failed sweep' ($caseText -match '\[INCOMPLETE\]')
Check 'empty scope warns but still sends' ($caseText -match 'Warn: Get-ServiceAccountExpiration - the supplied OUs contain no user accounts')

# The window parameter must exist and default to 30.
Check '-ExpiringWithinDays param exists'  ($fullSource -match '\[string\]\$ExpiringWithinDays\s*=\s*''30''')
Check 'bad window degrades, not throws'   ($caseText -match 'using the default of 30 days')

# Read-only guarantee: this action must never write to the directory.
Check 'no Set-ADUser in the case'         ($caseCode -notmatch 'Set-ADUser|Set-AdUser')
Check 'no Remove/New-ADUser in the case'  ($caseCode -notmatch 'Remove-ADUser|New-ADUser')

# The disarmed mass-write case must stay out of the ValidateSet (Admin report §2A-i).
Check 'Set-L3-Admin-Accounts still unreachable' ($fullSource -notmatch "ValidateSet\([^)]*'Set-L3-Admin-Accounts'")
# Get-ListOfUsers is superseded but must remain present - the two disabled cases still
# reference it and the file has to parse.
Check 'superseded Get-ListOfUsers marked' ($fullSource -match 'SUPERSEDED \(S-22\)')

# ═════════════════════════════════════════════════════════════════════════════
Section '9. Edge cases'
$script:MailBody = $null; $script:LogLines = @()
$Error.Clear()
GenerateReportServiceAccountExpiration @() $map @() @() 30
Check 'empty account set still reports'   ($script:MailBody -match 'Accounts in scope')
Check 'empty set keeps its scope footnote'($script:MailBody -match 'Scope - OUs queried')
Check 'empty set says nothing is expiring'($script:MailBody -match 'No account in scope has expired')
Check 'empty set raises no errors'        ($Error.Count -eq 0)

$script:MailBody = $null
$Error.Clear()
GenerateReportServiceAccountExpiration $accounts $null @() @() 30
Check 'null map still renders a report'   (-not [string]::IsNullOrWhiteSpace($script:MailBody))
Check 'null map says scope is unknown'    ($script:MailBody -match 'report scope unknown')
Check 'null map raises no errors'         ($Error.Count -eq 0)

# A clean run must not carry an alarm.
$script:MailBody = $null
$Global:DuplicateAccounts = @()
GenerateReportServiceAccountExpiration @(New-Acct 'svc-fine' $now.AddDays(300) (AsFileTime $now.AddDays(-10))) $map @() @() 30
Check 'clean run: no INCOMPLETE banner'   ($script:MailBody -notmatch 'THIS REPORT IS INCOMPLETE')
Check 'clean run: no overlap notice'      ($script:MailBody -notmatch 'overlapping OU list')
Check 'clean run: reassuring statement'   ($script:MailBody -match 'No account in scope has expired')

# The window must reach the rendered output, not just the classification.
$script:MailBody = $null
GenerateReportServiceAccountExpiration $accounts $map @() @() 7
Check 'window 7 narrows the expiring set' ($script:MailBody -match 'Expiring within 7 day\(s\) &#8212; 1 account')
$script:MailBody = $null
GenerateReportServiceAccountExpiration $accounts $map @() @() 365
Check 'window 365 widens it'              ($script:MailBody -match 'Expiring within 365 day\(s\) &#8212; 3 account')
# A bad window must degrade to 30 rather than throwing inside the report.
$script:MailBody = $null
$Error.Clear()
GenerateReportServiceAccountExpiration $accounts $map @() @() 'rubbish'
Check 'garbage window degrades to 30'     ($script:MailBody -match 'Look-ahead window: 30 day')
Check 'garbage window raises no errors'   ($Error.Count -eq 0)

# ═════════════════════════════════════════════════════════════════════════════
Section '10. Lab tooling - the AD seeder'
# Found during lab validation, 2026-08-04: the seeder aborted on its own normal path.
#
# The ActiveDirectory cmdlets raise ADIdentityNotFoundException as a TERMINATING error
# when -Identity or -SearchBase does not resolve, and `-ErrorAction SilentlyContinue`
# DOES NOT SUPPRESS A TERMINATING ERROR. So
#
#     if (Get-ADOrganizationalUnit -Identity $DN -ErrorAction SilentlyContinue) { ... }
#
# does not mean "if this OU exists" - it kills the script whenever the OU does NOT
# exist, which is precisely the case the seeder is written to handle.
#
# Asserted statically because the failure needs a real directory to reproduce, and the
# pattern reads as correct to anyone who has not been bitten by it.
$seeder = Join-Path $PSScriptRoot 'New-ServiceAccountTestData.ps1'
if (-not (Test-Path $seeder)) {
    Check 'seeder script present' $false
} else {
    $seederSrc = Get-Content -Raw -LiteralPath $seeder
    $seederTok = $null; $seederErr = $null
    [System.Management.Automation.Language.Parser]::ParseInput($seederSrc, [ref]$seederTok, [ref]$seederErr) | Out-Null
    $seederCode = (@($seederTok | Where-Object { $_.Kind -ne 'Comment' } | ForEach-Object { $_.Text })) -join ' '

    Check 'seeder parses'                    ($seederErr.Count -eq 0)
    # The broken pattern: -Identity or -SearchBase on the same command as
    # -ErrorAction SilentlyContinue. Checked against code, so the comment that explains
    # the trap does not trip it.
    Check 'no -Identity + SilentlyContinue'  ($seederCode -notmatch '-Identity[^|;]{0,200}?SilentlyContinue')
    Check 'no -SearchBase + SilentlyContinue'($seederCode -notmatch '-SearchBase[^|;]{0,200}?SilentlyContinue')
    Check 'existence checks are wrapped'     ($seederCode -match 'Get-OUOrNull' -and $seederCode -match 'Get-UsersOrEmpty')
    # Whitespace-tolerant: $seederCode is rebuilt by joining TOKENS with a space, so
    # "GetType().Name" arrives as "GetType ( ) . Name". Match accordingly.
    # Type matched by NAME, not a [type] literal, so it survives module-version changes.
    Check 'catches ADIdentityNotFound by name'($seederCode -match "Name\s*-eq\s*'ADIdentityNotFoundException'")
    Check 'validates the -OUPath parent'      ($seederCode -match "ContainsKey\s*\(\s*'OUPath'\s*\)")
    # The safety mechanism: -Remove must only ever delete TAGGED objects.
    Check 'seeder -Remove is tag-gated'      ($seederCode -match '\$TAG')
    Check 'seeder supports -WhatIf'          ($seederCode -match 'SupportsShouldProcess')
}

# ═════════════════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "PASS: $($script:pass)   FAIL: $($script:fail)" -ForegroundColor $(if ($script:fail -eq 0) {'Green'} else {'Red'})
exit $(if ($script:fail -gt 0) { 1 } else { 0 })

