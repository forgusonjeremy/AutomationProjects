<#
.SYNOPSIS
    Seeds a LAB Active Directory with service accounts that exercise every behaviour of
    the expiration report, then prints the workflow inputs and the figures the report
    should produce.

.DESCRIPTION
    Creates an OU structure and a set of accounts covering: expired, expiring inside the
    window, expiring outside it, no expiry date at all, a password that has NEVER been
    set, a disabled account, a locked-out account, and (optionally) a nested OU so the
    de-duplication path can be exercised.

    It then prints the exact `domainOUs` rows to paste into the workflow AND THE
    EXPECTED COUNTS, so a lab run can be VERIFIED rather than eyeballed. A report that
    looks plausible is not the same as a report that is right - and for this deliverable
    the failure mode is an account that is missing, which looks like nothing at all.

    *** THIS WRITES TO ACTIVE DIRECTORY. LAB DOMAINS ONLY. ***

    Every object it creates is tagged in its Description with a fixed marker. -Remove
    deletes ONLY tagged objects, and refuses to delete the OUs if anything it did not
    create is still inside them.

.PARAMETER Domain
    The lab domain to seed, e.g. vcf.lab. Required.

.PARAMETER OUPath
    Parent DN under which the test OU is created. Defaults to the domain root.

.PARAMETER IncludeNestedOU
    Also create a sub-OU with an account that is returned by BOTH searches, to exercise
    the overlapping-scope / de-duplication path.

.PARAMETER Remove
    Delete the tagged test objects instead of creating them.

.PARAMETER WhatIf
    Preview without changing anything. RUN THIS FIRST.

.EXAMPLE
    .\New-ServiceAccountTestData.ps1 -Domain vcf.lab -WhatIf
    .\New-ServiceAccountTestData.ps1 -Domain vcf.lab
    .\New-ServiceAccountTestData.ps1 -Domain vcf.lab -IncludeNestedOU
    .\New-ServiceAccountTestData.ps1 -Domain vcf.lab -Remove
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory = $true)]
    [string] $Domain,

    [string] $OUPath,

    [switch] $IncludeNestedOU,

    [switch] $Remove
)

$ErrorActionPreference = 'Stop'

# The tag is the safety mechanism: -Remove will not touch anything without it.
$TAG        = '[LABTEST-SVCEXPIRY]'
$TEST_OU    = 'Lab Service Accounts'
$NESTED_OU  = 'Tier1'

Import-Module ActiveDirectory -ErrorAction Stop

if (-not $OUPath) {
    $OUPath = (Get-ADDomain -Server $Domain).DistinguishedName
}
$testOUDN   = "OU=$TEST_OU,$OUPath"
$nestedOUDN = "OU=$NESTED_OU,$testOUDN"

$now = Get-Date

# ── Existence checks ─────────────────────────────────────────────────────────
#
# THE ACTIVE DIRECTORY CMDLETS RAISE ADIdentityNotFoundException AS A *TERMINATING*
# ERROR when -Identity (or -SearchBase) does not resolve, and `-ErrorAction
# SilentlyContinue` DOES NOT SUPPRESS A TERMINATING ERROR - it must be CAUGHT. Writing
#
#     if (Get-ADOrganizationalUnit -Identity $DN -ErrorAction SilentlyContinue) { ... }
#
# therefore aborts the script on the completely normal path where the OU does not exist
# yet, which is exactly the case this script is here to fix.
#
# (Note the asymmetry: -Filter returns an empty result for "no match" and does NOT
# throw, which is why the per-user existence check below can use it directly.)

function Get-OUOrNull {
    param([string] $DN)
    Try {
        return Get-ADOrganizationalUnit -Server $Domain -Identity $DN -Properties Description -ErrorAction Stop
    } Catch {
        # Match on the exception TYPE NAME as a string rather than a [type] literal, so
        # this keeps working across ActiveDirectory module versions.
        if ($_.Exception.GetType().Name -eq 'ADIdentityNotFoundException') { return $null }
        throw
    }
}

function Get-UsersOrEmpty {
    param([string] $SearchBase)
    Try {
        return @(Get-ADUser -Server $Domain -SearchBase $SearchBase -SearchScope Subtree `
                            -Filter * -Properties Description -ErrorAction Stop)
    } Catch {
        # An absent search base is not an error here - it means there is nothing to remove.
        if ($_.Exception.GetType().Name -eq 'ADIdentityNotFoundException') { return @() }
        throw
    }
}

# ── The data set ─────────────────────────────────────────────────────────────
# ExpiresInDays: $null means no expiration date at all (the AD default).
# PwdAgeDays:    $null means the password has NEVER been set (pwdLastSet = 0), which is
#                the case the v1 report rendered as an age of zero.
$plan = @(
    @{ Name='lab-svc-expired-old';  Display='Expired Long Ago';   ExpiresInDays=-90; PwdAgeDays=400;   Enabled=$true;  Nested=$false; Note='expired 90 days ago' }
    @{ Name='lab-svc-expired-new';  Display='Expired Recently';   ExpiresInDays=-2;  PwdAgeDays=120;   Enabled=$true;  Nested=$false; Note='expired 2 days ago' }
    @{ Name='lab-svc-expiring-3';   Display='Expiring In 3 Days'; ExpiresInDays=3;   PwdAgeDays=200;   Enabled=$true;  Nested=$false; Note='inside a 30-day window' }
    @{ Name='lab-svc-expiring-29';  Display='Expiring In 29 Days';ExpiresInDays=29;  PwdAgeDays=45;    Enabled=$true;  Nested=$false; Note='inside a 30-day window, near the edge' }
    @{ Name='lab-svc-outside-31';   Display='Expiring In 31 Days';ExpiresInDays=31;  PwdAgeDays=10;    Enabled=$true;  Nested=$false; Note='OUTSIDE a 30-day window - must NOT be flagged' }
    @{ Name='lab-svc-far';          Display='Expiring Next Year'; ExpiresInDays=300; PwdAgeDays=15;    Enabled=$true;  Nested=$false; Note='Active' }
    @{ Name='lab-svc-noexpiry';     Display='No Expiry Set';      ExpiresInDays=$null;PwdAgeDays=250;  Enabled=$true;  Nested=$false; Note='the AD default - reported as Never expires' }
    @{ Name='lab-svc-nopassword';   Display='Password Never Set'; ExpiresInDays=$null;PwdAgeDays=$null;Enabled=$true;  Nested=$false; Note='pwdLastSet = 0 - v1 showed this as age 0' }
    @{ Name='lab-svc-disabled';     Display='Disabled Expired';   ExpiresInDays=-10; PwdAgeDays=500;   Enabled=$false; Nested=$false; Note='disabled AND expired - still reported' }
    @{ Name='lab-svc-locked';       Display='Locked Out';         ExpiresInDays=12;  PwdAgeDays=700;   Enabled=$true;  Nested=$false; Note='account state column should say Locked out (needs a lockout to be provoked)' }
    @{ Name='lab-svc-nested';       Display='In The Sub-OU';      ExpiresInDays=7;   PwdAgeDays=60;    Enabled=$true;  Nested=$true;  Note='only created with -IncludeNestedOU' }
)

$wanted = @($plan | Where-Object { -not $_.Nested -or $IncludeNestedOU })

# ═════════════════════════════════════════════════════════════════════════════
if ($Remove) {
    Write-Host ""
    Write-Host "REMOVING tagged lab objects from $Domain" -ForegroundColor Yellow
    Write-Host ""

    $found = @(Get-UsersOrEmpty -SearchBase $testOUDN)
    if ($found.Count -eq 0 -and $null -eq (Get-OUOrNull -DN $testOUDN)) {
        Write-Host "  Nothing to do - $testOUDN does not exist." -ForegroundColor Gray
        Write-Host ""
        return
    }
    $tagged   = @($found | Where-Object { "$($_.Description)" -like "*$TAG*" })
    $untagged = @($found | Where-Object { "$($_.Description)" -notlike "*$TAG*" })

    foreach ($u in $tagged) {
        if ($PSCmdlet.ShouldProcess($u.SamAccountName, 'Remove-ADUser')) {
            Remove-ADUser -Server $Domain -Identity $u.DistinguishedName -Confirm:$false
            Write-Host "  removed user  $($u.SamAccountName)" -ForegroundColor Gray
        }
    }

    # Refuse to delete an OU holding anything this script did not create. Deleting an
    # OU is recursive and silent about what went with it.
    if ($untagged.Count -gt 0) {
        Write-Host ""
        Write-Host "  NOT removing the OUs - they still contain $($untagged.Count) object(s) this script did not create:" -ForegroundColor Yellow
        $untagged | ForEach-Object { Write-Host "    $($_.DistinguishedName)" -ForegroundColor Yellow }
        Write-Host "  Move or delete those first, then re-run with -Remove." -ForegroundColor Yellow
    } else {
        foreach ($dn in @($nestedOUDN, $testOUDN)) {
            $ou = Get-OUOrNull -DN $dn
            if ($null -eq $ou) { continue }
            if ("$($ou.Description)" -notlike "*$TAG*") {
                Write-Host "  NOT removing $dn - it is not tagged as lab test data." -ForegroundColor Yellow
                continue
            }
            if ($PSCmdlet.ShouldProcess($dn, 'Remove-ADOrganizationalUnit')) {
                # Accidental-deletion protection is on by default and blocks removal.
                Set-ADObject -Server $Domain -Identity $dn -ProtectedFromAccidentalDeletion $false -Confirm:$false
                Remove-ADOrganizationalUnit -Server $Domain -Identity $dn -Recursive -Confirm:$false
                Write-Host "  removed OU    $dn" -ForegroundColor Gray
            }
        }
    }

    Write-Host ""
    Write-Host "Done." -ForegroundColor Green
    return
}

# ═════════════════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "SEEDING lab service accounts in $Domain" -ForegroundColor Cyan
Write-Host "  Test OU : $testOUDN" -ForegroundColor Gray
if ($IncludeNestedOU) { Write-Host "  Sub-OU  : $nestedOUDN" -ForegroundColor Gray }
Write-Host "  Tag     : $TAG (only tagged objects are removable with -Remove)" -ForegroundColor Gray
Write-Host ""

function Ensure-OU {
    param([string]$Name, [string]$Parent, [string]$DN)
    if ($null -ne (Get-OUOrNull -DN $DN)) {
        Write-Host "  OU exists     $DN" -ForegroundColor DarkGray
        return
    }
    if ($PSCmdlet.ShouldProcess($DN, 'New-ADOrganizationalUnit')) {
        New-ADOrganizationalUnit -Server $Domain -Name $Name -Path $Parent `
                                 -Description "$TAG test data - safe to delete" `
                                 -ProtectedFromAccidentalDeletion $false
        Write-Host "  created OU    $DN" -ForegroundColor Green
    }
}

# The parent must exist before anything can be created under it. Checked explicitly so a
# typo in -OUPath says so, rather than surfacing as a New-ADOrganizationalUnit failure
# several lines later. Skipped when -OUPath was defaulted to the domain root, which
# Get-ADDomain already resolved.
if ($PSBoundParameters.ContainsKey('OUPath') -and $null -eq (Get-OUOrNull -DN $OUPath)) {
    Write-Host ""
    Write-Host "FATAL: the -OUPath parent does not exist in $($Domain):" -ForegroundColor Red
    Write-Host "         $OUPath" -ForegroundColor Red
    Write-Host "       Create it first, or omit -OUPath to use the domain root." -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

Ensure-OU -Name $TEST_OU -Parent $OUPath -DN $testOUDN
if ($IncludeNestedOU) { Ensure-OU -Name $NESTED_OU -Parent $testOUDN -DN $nestedOUDN }

# A password nobody needs to know: these accounts are never signed in to. Generated
# rather than hard-coded so the same string is not committed to the repo.
function New-LabPassword {
    $bytes = New-Object 'System.Byte[]' 24
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return (ConvertTo-SecureString ("Lab!" + [Convert]::ToBase64String($bytes)) -AsPlainText -Force)
}

foreach ($p in $wanted) {
    $targetOU = if ($p.Nested) { $nestedOUDN } else { $testOUDN }
    $desc     = "$TAG $($p.Note)"

    # -Filter (unlike -Identity) returns an EMPTY RESULT for no match rather than
    # throwing, so no suppression is needed here - and adding it would hide a genuine
    # failure, such as an unreachable DC, behind "the user does not exist".
    $existing = Get-ADUser -Server $Domain -Filter "SamAccountName -eq '$($p.Name)'"
    if ($existing) {
        Write-Host "  user exists   $($p.Name)" -ForegroundColor DarkGray
        continue
    }

    if (-not $PSCmdlet.ShouldProcess($p.Name, 'New-ADUser')) { continue }

    $params = @{
        Server            = $Domain
        Name              = $p.Display
        SamAccountName    = $p.Name
        UserPrincipalName = "$($p.Name)@$Domain"
        DisplayName       = $p.Display
        Office            = 'Lab Platform Services'
        Path              = $targetOU
        Description       = $desc
        Enabled           = $p.Enabled
        AccountPassword   = (New-LabPassword)
    }
    if ($null -ne $p.ExpiresInDays) { $params['AccountExpirationDate'] = $now.AddDays($p.ExpiresInDays) }

    New-ADUser @params

    # Password age. There is no supported way to BACKDATE pwdLastSet - it is set by the
    # directory when the password changes - so the "password age" column cannot be
    # seeded to a specific number of days here. What CAN be seeded is the case that
    # actually mattered: pwdLastSet = 0.
    if ($null -eq $p.PwdAgeDays) {
        # ChangePasswordAtLogon sets pwdLastSet to 0 - the exact condition v1 rendered
        # as a password age of ZERO and sorted to the bottom of the report.
        Set-ADUser -Server $Domain -Identity $p.Name -ChangePasswordAtLogon $true
    }

    Write-Host "  created user  $($p.Name)  ($($p.Note))" -ForegroundColor Green
}

# ═════════════════════════════════════════════════════════════════════════════
# What the report should say - so the lab run is VERIFIED, not eyeballed.
# ═════════════════════════════════════════════════════════════════════════════
$expired  = @($wanted | Where-Object { $null -ne $_.ExpiresInDays -and $_.ExpiresInDays -lt 0 }).Count
$expiring = @($wanted | Where-Object { $null -ne $_.ExpiresInDays -and $_.ExpiresInDays -ge 0 -and $_.ExpiresInDays -le 30 }).Count
$noExpiry = @($wanted | Where-Object { $null -eq $_.ExpiresInDays }).Count

Write-Host ""
Write-Host ("=" * 74) -ForegroundColor DarkCyan
Write-Host " WORKFLOW INPUT - paste into 'domainOUs', ONE ROW PER LINE" -ForegroundColor Cyan
Write-Host ("=" * 74) -ForegroundColor DarkCyan
Write-Host ""
Write-Host "  $testOUDN" -ForegroundColor White
if ($IncludeNestedOU) {
    Write-Host "  $nestedOUDN" -ForegroundColor White
    Write-Host ""
    Write-Host "  (Both rows deliberately overlap - searches are recursive, so the sub-OU's" -ForegroundColor DarkGray
    Write-Host "   account is returned TWICE and must be collapsed to one entry, with the" -ForegroundColor DarkGray
    Write-Host "   overlapping-scope notice on the report.)" -ForegroundColor DarkGray
}
Write-Host ""
Write-Host " Set expiringWithinDays to 30 for the figures below." -ForegroundColor DarkGray
Write-Host ""
Write-Host ("=" * 74) -ForegroundColor DarkCyan
Write-Host " EXPECTED REPORT FIGURES (window = 30 days)" -ForegroundColor Cyan
Write-Host ("=" * 74) -ForegroundColor DarkCyan
Write-Host ""
Write-Host ("  Accounts in scope        : {0}" -f $wanted.Count)
Write-Host ("  Already expired          : {0}" -f $expired)
Write-Host ("  Expiring within 30 days  : {0}" -f $expiring)
Write-Host ("  No expiry date set       : {0}" -f $noExpiry)
Write-Host ""
Write-Host ("  Subject line should read : ... ( {0} expired - {1} expiring within 30 days )" -f $expired, $expiring)
Write-Host ""
Write-Host " Specific things to CHECK on the report:" -ForegroundColor Cyan
Write-Host "   - lab-svc-outside-31 is listed in the inventory but NOT in the Expiring" -ForegroundColor Gray
Write-Host "     section. Re-run with expiringWithinDays=31 and it must move up."       -ForegroundColor Gray
Write-Host "   - lab-svc-nopassword shows 'Never set' in BOTH password columns, in red," -ForegroundColor Gray
Write-Host "     and sorts to the TOP of its group - not a password age of 0."           -ForegroundColor Gray
Write-Host "   - lab-svc-disabled appears with Account state = Disabled and is STILL"    -ForegroundColor Gray
Write-Host "     counted in the expired figure."                                          -ForegroundColor Gray
Write-Host "   - every account has an 'Expires on' value or 'Never expires'. The v1"     -ForegroundColor Gray
Write-Host "     report had no expiration column at all."                                 -ForegroundColor Gray
Write-Host "   - the report is NOT filtered: all $($wanted.Count) accounts appear in the inventory." -ForegroundColor Gray
Write-Host ""
Write-Host " To provoke the [INCOMPLETE] path, add a bogus row to domainOUs:" -ForegroundColor Cyan
Write-Host "   OU=Does Not Exist,$OUPath" -ForegroundColor Gray
Write-Host "   The run must end 'Completed with Errors', the report must still arrive," -ForegroundColor Gray
Write-Host "   the subject must be prefixed [INCOMPLETE], and the failure must be"       -ForegroundColor Gray
Write-Host "   classified as a Scope error." -ForegroundColor Gray
Write-Host ""
Write-Host " To provoke the LOCKED OUT state on lab-svc-locked, attempt a few bad" -ForegroundColor Cyan
Write-Host " logons against it until the lockout policy trips." -ForegroundColor Cyan
Write-Host ""
Write-Host " Clean up with:  .\New-ServiceAccountTestData.ps1 -Domain $Domain -Remove" -ForegroundColor DarkGray
Write-Host ""
