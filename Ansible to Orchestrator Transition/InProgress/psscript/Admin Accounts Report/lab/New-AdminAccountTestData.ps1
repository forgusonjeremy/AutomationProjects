<#
.SYNOPSIS
    Seeds a LAB Active Directory with admin accounts that exercise every feature of
    the Admin Accounts Report, and prints the exact workflow inputs to run it with.

.DESCRIPTION
    Creates an OU structure and a set of user accounts whose smart-card and enabled
    states are chosen so that the Get-AdminAccountsReport workflow produces a report
    demonstrating ALL of its behaviour:

      - compliant accounts (smart card enforced)
      - non-compliant accounts (smart card NOT enforced)   -> the headline figure
      - a DISABLED non-compliant account                   -> Account state column
      - a service account in an admin OU                   -> the exemption question
      - accounts split across TWO OUs in the domain        -> per-OU sub-sections
      - optionally a NESTED OU (-IncludeNestedOU)          -> de-duplication notice

    It then prints:
      1. the `domainOUs` list to paste into the workflow input, and
      2. the figures the report SHOULD produce, so you can verify the run rather than
         just eyeball it.

    *** LAB USE ONLY. THIS CREATES REAL ACTIVE DIRECTORY OBJECTS. ***
    Run it against a lab domain you own. It is not destructive to existing objects,
    but it does write to the directory.

.SAFETY
    Every object it creates is tagged with the marker string in $script:Marker, inside
    its Description. -Remove deletes ONLY objects carrying that marker, and only
    within the OUs this script created. It will never touch an account it did not
    create, even one sitting in the same OU.

    Supports -WhatIf and -Confirm. Start with -WhatIf.

.PARAMETER Domain
    Target AD domain (DNS name), e.g. 'vcf.lab'. Defaults to the current domain.

.PARAMETER OUPrefix
    Top-level container created under the domain root to hold everything, so the test
    data is easy to find and remove. Default 'LabAdminReport'.

.PARAMETER IncludeNestedOU
    Also create a nested OU with an account in it. Use this to demonstrate the
    de-duplication notice: list BOTH the parent and the nested OU in domainOUs and the
    report will collapse the duplicate and explain why.

.PARAMETER Remove
    Delete the test accounts and OUs this script created (marker-matched only).

.EXAMPLE
    .\New-AdminAccountTestData.ps1 -Domain vcf.lab -WhatIf
    Preview exactly what would be created.

.EXAMPLE
    .\New-AdminAccountTestData.ps1 -Domain vcf.lab
    Create the data and print the workflow inputs plus the expected report figures.

.EXAMPLE
    .\New-AdminAccountTestData.ps1 -Domain vcf.lab -IncludeNestedOU
    As above, plus a nested OU for demonstrating de-duplication.

.EXAMPLE
    .\New-AdminAccountTestData.ps1 -Domain vcf.lab -Remove
    Clean up everything this script created.

.NOTES
    Requires the ActiveDirectory module and rights to create OUs and users.
    Passwords are random, discarded, and never needed - the report only READS
    attributes and nothing ever logs on as these accounts.
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory = $false)]
    [string] $Domain,

    [Parameter(Mandatory = $false)]
    [ValidateNotNullOrEmpty()]
    [string] $OUPrefix = 'LabAdminReport',

    [Parameter(Mandatory = $false)]
    [switch] $IncludeNestedOU,

    [Parameter(Mandatory = $false)]
    [switch] $Remove
)

$ErrorActionPreference = 'Stop'

# Marker written into every Description. Cleanup matches on this, so the script can
# never delete an object it did not create.
$script:Marker = '[ADMIN-REPORT-LABDATA]'

# ── Preflight ────────────────────────────────────────────────────────────────
if (-not (Get-Module -ListAvailable -Name ActiveDirectory)) {
    throw "The ActiveDirectory PowerShell module is not installed. Install RSAT-AD-PowerShell and re-run."
}
Import-Module ActiveDirectory -ErrorAction Stop

if ([string]::IsNullOrWhiteSpace($Domain)) {
    $Domain = (Get-ADDomain).DNSRoot
    Write-Host "No -Domain supplied; using the current domain: $Domain" -ForegroundColor Yellow
}

try   { $domainObj = Get-ADDomain -Identity $Domain -ErrorAction Stop }
catch { throw "Cannot reach domain '$Domain': $($_.Exception.Message)" }

$rootDN = $domainObj.DistinguishedName

Write-Host ""
Write-Host ("=" * 74) -ForegroundColor Cyan
Write-Host " Admin Accounts Report - lab data seeder" -ForegroundColor Cyan
Write-Host ("=" * 74) -ForegroundColor Cyan
Write-Host " Target domain : $Domain"
Write-Host " Domain DN     : $rootDN"
Write-Host " Marker        : $script:Marker"
Write-Host " Mode          : $(if($Remove){'REMOVE'}else{'CREATE'})"
Write-Host ""

# ── OU layout ────────────────────────────────────────────────────────────────
# Mirrors the customer's production shape (an "Admin Accounts" OU beneath a
# Servers / Workstations tier), one level down inside $OUPrefix so all lab data is
# contained and removable.
$baseDN     = "OU=$OUPrefix,$rootDN"
$serversDN  = "OU=Servers,$baseDN"
$wksDN      = "OU=Workstations,$baseDN"
$svrAdminDN = "OU=Admin Accounts,$serversDN"
$wksAdminDN = "OU=Admin Accounts,$wksDN"
$nestedDN   = "OU=Tier0,$svrAdminDN"

# ── Account set ──────────────────────────────────────────────────────────────
# SC = SmartcardLogonRequired. Each row exists to light up one report behaviour.
$accounts = @(
    # Servers / Admin Accounts
    @{ Sam='lab.adm.halloway'; Name='Halloway, Jordan'; OU=$svrAdminDN; SC=$true;  Enabled=$true;  Desc='Tier 0 - Domain Admin';        Why='compliant' }
    @{ Sam='lab.adm.keswick';  Name='Keswick, Robin';   OU=$svrAdminDN; SC=$true;  Enabled=$true;  Desc='Tier 1 - Server Admin';        Why='compliant' }
    @{ Sam='lab.adm.gap';      Name='Fairlie, Morgan';  OU=$svrAdminDN; SC=$false; Enabled=$true;  Desc='Tier 1 - Server Admin';        Why='NON-COMPLIANT' }
    @{ Sam='lab.svc.backup';   Name='Backup Service';   OU=$svrAdminDN; SC=$false; Enabled=$true;  Desc='Service account - exempt?';    Why='NON-COMPLIANT (service acct - the exemption question)' }
    @{ Sam='lab.adm.leaver';   Name='Leaving, Oscar';   OU=$svrAdminDN; SC=$false; Enabled=$false; Desc='LEAVER - pending deletion';    Why='NON-COMPLIANT + DISABLED (Account state column)' }
    # Workstations / Admin Accounts
    @{ Sam='lab.adm.okonkwo';  Name='Okonkwo, Tobi';    OU=$wksAdminDN; SC=$true;  Enabled=$true;  Desc='Tier 2 - Workstation Admin';   Why='compliant' }
    @{ Sam='lab.adm.petrova';  Name='Petrova, Sofia';   OU=$wksAdminDN; SC=$false; Enabled=$true;  Desc='Tier 2 - Workstation Admin';   Why='NON-COMPLIANT' }
)
if ($IncludeNestedOU) {
    $accounts += @{ Sam='lab.adm.tier0'; Name='Nakamura, Yuki'; OU=$nestedDN; SC=$true; Enabled=$true; Desc='Tier 0 - nested OU'; Why='compliant (in a NESTED OU - for the de-duplication demo)' }
}

$ouList = @($baseDN, $serversDN, $wksDN, $svrAdminDN, $wksAdminDN)
if ($IncludeNestedOU) { $ouList += $nestedDN }

# ── Helpers ──────────────────────────────────────────────────────────────────
function Test-ADPath {
    param([string] $DN)
    try { $null = Get-ADObject -Identity $DN -Server $Domain -ErrorAction Stop; return $true }
    catch { return $false }
}

function New-LabPassword {
    # Random, complex, and immediately discarded. Nothing ever signs in as these
    # accounts - the report only reads attributes.
    $chars = [char[]]( (65..90) + (97..122) + (48..57) )
    $body  = -join (1..20 | ForEach-Object { $chars | Get-Random })
    ConvertTo-SecureString ("Lab!7" + $body + "#z") -AsPlainText -Force
}

# ── REMOVE mode ──────────────────────────────────────────────────────────────
if ($Remove) {
    if (-not (Test-ADPath $baseDN)) {
        Write-Host "Nothing to remove - '$baseDN' does not exist." -ForegroundColor Yellow
        return
    }

    # Marker-matched users only. An account someone else put in these OUs is left
    # alone: this script deletes only what it created.
    $victims = @(Get-ADUser -Server $Domain -SearchBase $baseDN -SearchScope Subtree `
                    -Filter * -Properties Description |
                 Where-Object { $_.Description -like "*$($script:Marker)*" })

    Write-Host "Found $($victims.Count) marker-tagged test account(s) to remove." -ForegroundColor Yellow
    foreach ($v in $victims) {
        if ($PSCmdlet.ShouldProcess($v.DistinguishedName, "Remove test user")) {
            Remove-ADUser -Identity $v.DistinguishedName -Server $Domain -Confirm:$false
            Write-Host "  removed user $($v.SamAccountName)" -ForegroundColor DarkGray
        }
    }

    # Any non-marker object still present means someone put something real in here -
    # stop rather than delete the OU out from under it.
    $leftovers = @(Get-ADObject -Server $Domain -SearchBase $baseDN -SearchScope Subtree `
                      -Filter "objectClass -ne 'organizationalUnit'")
    if ($leftovers.Count -gt 0) {
        Write-Host ""
        Write-Host "NOT removing the OUs - $($leftovers.Count) object(s) remain that this script did not create:" -ForegroundColor Yellow
        $leftovers | Select-Object -First 10 | ForEach-Object { Write-Host "  $($_.DistinguishedName)" -ForegroundColor Yellow }
        Write-Host "Review them, then delete '$baseDN' by hand if you are sure." -ForegroundColor Yellow
        return
    }

    # Deepest-first so children go before parents.
    foreach ($ou in ($ouList | Sort-Object { ($_ -split ',').Count } -Descending)) {
        if (-not (Test-ADPath $ou)) { continue }
        if ($PSCmdlet.ShouldProcess($ou, "Remove OU")) {
            # New-ADOrganizationalUnit protects OUs from accidental deletion by
            # default; that has to be cleared before Remove-ADOrganizationalUnit.
            Set-ADObject -Identity $ou -Server $Domain -ProtectedFromAccidentalDeletion $false -Confirm:$false
            Remove-ADOrganizationalUnit -Identity $ou -Server $Domain -Recursive -Confirm:$false
            Write-Host "  removed OU $ou" -ForegroundColor DarkGray
        }
    }

    Write-Host ""
    Write-Host "Cleanup complete." -ForegroundColor Green
    return
}

# ── CREATE mode ──────────────────────────────────────────────────────────────
Write-Host "OUs to ensure:" -ForegroundColor Cyan
$ouList | ForEach-Object { Write-Host "  $_" }
Write-Host ""
Write-Host "Accounts to ensure:" -ForegroundColor Cyan
$accounts | ForEach-Object {
    "{0,-20} SC:{1,-5} Enabled:{2,-5} {3}" -f $_.Sam, $_.SC, $_.Enabled, $_.Why | Write-Host
}
Write-Host ""

# Create OUs parent-first. Idempotent: an existing OU is left as-is.
foreach ($ou in ($ouList | Sort-Object { ($_ -split ',').Count })) {
    if (Test-ADPath $ou) {
        Write-Host "  OU exists : $ou" -ForegroundColor DarkGray
        continue
    }
    # Split "OU=<name>,<parent>" into its name and parent path.
    $ouName   = ($ou -split ',', 2)[0] -replace '^OU=', ''
    $ouParent = ($ou -split ',', 2)[1]
    if ($PSCmdlet.ShouldProcess($ou, "Create OU")) {
        New-ADOrganizationalUnit -Name $ouName -Path $ouParent -Server $Domain `
            -Description "Admin Accounts Report lab data $($script:Marker)" `
            -ProtectedFromAccidentalDeletion $false
        Write-Host "  OU created: $ou" -ForegroundColor Green
    }
}

# Create users. Idempotent: an existing account has its state RE-APPLIED so a
# half-finished previous run cannot leave the data set wrong.
foreach ($a in $accounts) {
    $existing = $null
    try { $existing = Get-ADUser -Identity $a.Sam -Server $Domain -ErrorAction Stop } catch { }

    $desc = "$($a.Desc) $($script:Marker)"

    if ($existing) {
        if ($PSCmdlet.ShouldProcess($a.Sam, "Update existing test user")) {
            Set-ADUser -Identity $existing.DistinguishedName -Server $Domain `
                -SmartcardLogonRequired $a.SC -Enabled $a.Enabled -Description $desc -DisplayName $a.Name
            Write-Host "  user updated: $($a.Sam)" -ForegroundColor DarkGray
        }
        continue
    }

    if ($PSCmdlet.ShouldProcess("$($a.Sam) in $($a.OU)", "Create test user")) {
        New-ADUser -Server $Domain `
            -Name              $a.Sam `
            -SamAccountName    $a.Sam `
            -UserPrincipalName "$($a.Sam)@$Domain" `
            -DisplayName       $a.Name `
            -Path              $a.OU `
            -Description       $desc `
            -AccountPassword   (New-LabPassword) `
            -Enabled           $a.Enabled `
            -SmartcardLogonRequired $a.SC
        Write-Host "  user created: $($a.Sam)" -ForegroundColor Green
    }
}

if ($WhatIfPreference) {
    Write-Host ""
    Write-Host "-WhatIf: nothing was changed. Re-run without -WhatIf to create the data." -ForegroundColor Yellow
    return
}

# ── Workflow inputs + expected result ────────────────────────────────────────
$scopeOUs = @($svrAdminDN, $wksAdminDN)
if ($IncludeNestedOU) { $scopeOUs += $nestedDN }

$compliant    = @($accounts | Where-Object { $_.SC -eq $true  }).Count
$nonCompliant = @($accounts | Where-Object { $_.SC -eq $false }).Count
$disabledNC   = @($accounts | Where-Object { $_.SC -eq $false -and $_.Enabled -eq $false }).Count
$total        = $accounts.Count
$rate         = if ($total -gt 0) { [math]::Round(($compliant / $total) * 100, 1) } else { 0 }

Write-Host ""
Write-Host ("=" * 74) -ForegroundColor Cyan
Write-Host " PASTE THIS INTO THE WORKFLOW - domainOUs (one DN per array row)" -ForegroundColor Cyan
Write-Host ("=" * 74) -ForegroundColor Cyan
$scopeOUs | ForEach-Object { Write-Host $_ -ForegroundColor White }

Write-Host ""
Write-Host "Other workflow inputs:" -ForegroundColor Cyan
Write-Host "  scriptPath   <path to cvs_functions.ps1 on the Orchestrator PS host>"
Write-Host "  emailReport  true  (or false to check the transcript only)"
Write-Host "  smtpServer   <your lab SMTP relay>"
Write-Host "  mailTo       <one address per array row>"
Write-Host "  mailSubject  Report: Admin PKI Card Status"

Write-Host ""
Write-Host ("=" * 74) -ForegroundColor Cyan
Write-Host " EXPECTED REPORT - verify the run against these numbers" -ForegroundColor Cyan
Write-Host ("=" * 74) -ForegroundColor Cyan
Write-Host "  Subject       Report: Admin PKI Card Status ( $nonCompliant Non-Compliance - $compliant Compliance )"
Write-Host "  Accounts      $total"
Write-Host "  Enforced      $compliant"
Write-Host "  Not enforced  $nonCompliant   (of which $disabledNC disabled - still counted, by design)"
Write-Host "  Rate          $rate%"
Write-Host "  Domains       1  -> one domain section"
Write-Host "  OUs in scope  $($scopeOUs.Count) -> per-OU sub-sections (a domain with 2+ OUs is broken down)"
if ($IncludeNestedOU) {
    Write-Host ""
    Write-Host "  DE-DUPLICATION DEMO:" -ForegroundColor Yellow
    Write-Host "    The nested OU is listed above ALONGSIDE its parent. Because searches are"
    Write-Host "    recursive, lab.adm.tier0 is returned by BOTH searches. The report should"
    Write-Host "    count it ONCE, place it under the nested OU, and show the"
    Write-Host "    'overlapping OU list' notice. The totals above already assume that."
    Write-Host "    Remove the nested DN from domainOUs and the notice disappears."
}
Write-Host ""
Write-Host "  To exercise the INCOMPLETE path, add a bogus OU DN to domainOUs, e.g."
Write-Host "    OU=Does Not Exist,$baseDN" -ForegroundColor DarkGray
Write-Host "  The report should be marked [INCOMPLETE], classify it as a Scope error,"
Write-Host "  and the workflow should end 'Completed with Errors'."
Write-Host ""
Write-Host "Clean up with:  .\New-AdminAccountTestData.ps1 -Domain $Domain -Remove" -ForegroundColor DarkGray
Write-Host ""
