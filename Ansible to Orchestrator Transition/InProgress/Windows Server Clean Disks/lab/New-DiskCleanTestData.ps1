<#
.SYNOPSIS
    LAB helper: seed aged files (and nested folders) into the disk-clean target
    directories on one or more test servers, so the Clean-ServerDisks-ByADGroup
    workflow (cvs_functions.ps1 -> clean-ServerDisk -> Remove-files) has something
    real to find, report on (whatIf='yes'), and delete (whatIf='no').

.DESCRIPTION
    The clean automation selects items purely by LastWriteTime (older than
    today + NumberOfDays) and a name -Filter; it never inspects content. This
    script therefore writes lightweight TEXT placeholder files with a BACK-DATED
    LastWriteTime (and, with FolderIncluded='yes', nested folders whose own
    timestamps are also back-dated) so they qualify for the clean.

    It reproduces the two production target profiles seen in the project tracker
    (Ansible to Orchestrator Projects.xlsx, row "servers_diskclean.yml"):

      ccmcache  -> c:\Windows\ccmcache   FolderIncluded=yes ForceEnable=no  NumberOfDays=-1   (6 templates)
      profiles  -> c:\users              FolderIncluded=yes ForceEnable=yes NumberOfDays=0    (2 templates)

    Both invoke the SAME clean-ServerDisk action; the profile templates just point
    at c:\users with -Force and a 0-day age. Choose the profile with -Scenario, or
    seed an explicit path with -FolderTarget.

    Negative-test artifacts (created unless suppressed) prove the cleaner's SAFE
    behaviours, not just its deletes:
      * vmware-vmsvc-SYSTEM.log  - back-dated, but the cleaner EXCLUDES this name;
                                   it must SURVIVE (Remove-files $FileExclude).
      * _KEEP_newer_than_threshold.txt - FUTURE-dated; newer than the age cutoff for
                                   BOTH scenarios, so it must SURVIVE.
      * _readonly_hidden_*.txt   - back-dated but Read-Only+Hidden; SURVIVES when
                                   ForceEnable='no' (ccmcache), DELETED when
                                   ForceEnable='yes' (profiles). Exercises -Force.

    Server targeting (choose one parameter set):
      -ComputerName <list>            explicit server names/FQDNs, OR
      -ADGroup <name> [-DomainName]   resolve DIRECT (non-recursive) ENABLED
                                      computer members - the SAME set the clean
                                      workflow targets (Get-ListOfServers-Direct).

    Delivery method:
      (default)      writes over the UNC admin share, mirroring the automation:
                     c:\path -> \\<server>\C$\path
      -UseRemoting   writes locally on each server via Invoke-Command (WinRM)

    Requires administrative write access to the target directory on each server.

.PARAMETER ComputerName
    One or more target servers (name or FQDN).

.PARAMETER ADGroup
    AD security group whose DIRECT, ENABLED computer members are seeded. Mirrors
    the clean workflow's Get-ListOfServers-Direct resolution (non-recursive,
    computer objects only), so the test data lands on exactly the machines the
    workflow would act on. Requires the ActiveDirectory module (RSAT) on the
    machine running this helper.

.PARAMETER DomainName
    Optional AD -Server target (a specific DC / domain) for -ADGroup resolution.

.PARAMETER Scenario
    Convenience preset for the default FolderTarget:
      ccmcache (default) -> c:\Windows\ccmcache
      profiles           -> c:\users\_LabDiskCleanTest   (a THROWAWAY subfolder, so
                            seeding never touches a real user profile)
    Ignored if -FolderTarget is supplied explicitly.

.PARAMETER FolderTarget
    One or more local paths to seed, e.g. 'c:\Windows\ccmcache' or
    'c:\Windows\ccmcache','c:\Temp\ScratchCache'. Overrides -Scenario. Use LOCAL
    drive-letter paths (c:\...); they are rewritten to \\server\C$\... for UNC
    delivery, exactly as the automation addresses them.

.PARAMETER FilesPerFolder
    Aged files to create in each folder (target root and each subfolder). Default 6.

.PARAMETER SubFolders
    Nested back-dated subfolders to create under each target (realistic ccmcache
    layout; exercises FolderIncluded='yes' folder deletion). Default 3. Use 0 for
    a flat, files-only target.

.PARAMETER AgeDays
    Days in the past to back-date the aged items. Default 30. Must exceed the
    clean's age threshold (files older than |NumberOfDays|; -1 or 0 in production).

.PARAMETER NoNegativeTests
    Skip the survive-me artifacts (excluded name, future-dated file, readonly/hidden).

.PARAMETER UseRemoting
    Write via PowerShell remoting (Invoke-Command) instead of the UNC admin share.

.PARAMETER Credential
    Optional credential for AD queries, remoting, and/or UNC access.

.EXAMPLE
    # Seed the default ccmcache target on two lab servers
    .\New-DiskCleanTestData.ps1 -ComputerName winsrv01,winsrv02

.EXAMPLE
    # Seed every direct member of the clean group (the set the workflow targets)
    .\New-DiskCleanTestData.ps1 -ADGroup 'CVS-DPT-AllServers' -DomainName connect.sbu

.EXAMPLE
    # Reproduce the user-profile template into a throwaway subfolder (safe)
    .\New-DiskCleanTestData.ps1 -ComputerName winsrv01 -Scenario profiles

.EXAMPLE
    # Seed a custom path via remoting with explicit creds
    .\New-DiskCleanTestData.ps1 -ComputerName winsrv01 -FolderTarget 'c:\Temp\ScratchCache' -UseRemoting -Credential (Get-Credential)

.NOTES
    Lab utility only - NOT part of the deployed vRO package. Files are plain text;
    safe to delete. Re-running adds more files.

    VALIDATION FLOW:
      1. Seed:  this script.
      2. Preview: run Clean-ServerDisks-ByADGroup with whatIf='yes' and confirm the
                 transcript lists the aged items as "[ReportOnly] WouldDelete: ...".
      3. Verify negatives: confirm vmware-vmsvc-SYSTEM.log, _KEEP_newer_than_threshold,
                 and (for ForceEnable='no') the readonly/hidden file are NOT listed.
      4. Delete: run whatIf='no' and re-inspect the folders.

    SAFETY: seeding c:\users directly is avoided by default (-Scenario profiles uses
    c:\users\_LabDiskCleanTest). Never point a LIVE clean run (whatIf='no',
    NumberOfDays=0, ForceEnable=yes) at a real c:\users on a machine with real
    profiles - that is what the two profile templates do in production and is
    exactly why the workflow defaults whatIf to 'yes'.
#>
[CmdletBinding(SupportsShouldProcess, DefaultParameterSetName = 'ByComputer')]
param(
    [Parameter(Mandatory, ParameterSetName = 'ByComputer', Position = 0)]
    [string[]]$ComputerName,

    [Parameter(Mandatory, ParameterSetName = 'ByADGroup')]
    [string]$ADGroup,

    [Parameter(ParameterSetName = 'ByADGroup')]
    [string]$DomainName,

    [ValidateSet('ccmcache', 'profiles')]
    [string]$Scenario = 'ccmcache',

    [string[]]$FolderTarget,

    [ValidateRange(1, 1000)]
    [int]$FilesPerFolder = 6,

    [ValidateRange(0, 50)]
    [int]$SubFolders = 3,

    [ValidateRange(1, 36500)]
    [int]$AgeDays = 30,

    [switch]$NoNegativeTests,

    [switch]$UseRemoting,

    [System.Management.Automation.PSCredential]$Credential
)

# --- Resolve the default FolderTarget from -Scenario (unless given explicitly) --
if (-not $FolderTarget -or $FolderTarget.Count -eq 0) {
    $FolderTarget = switch ($Scenario) {
        'ccmcache' { , 'c:\Windows\ccmcache' }
        'profiles' { , 'c:\users\_LabDiskCleanTest' }   # throwaway - never a real profile
    }
}

# Normalise: keep only local drive-letter paths (c:\...); reject UNC/relative so the
# c: -> C$ rewrite is always valid.
$cleanTargets = @()
foreach ($ft in $FolderTarget) {
    $p = ("$ft").Trim()
    if ($p -notmatch '^[A-Za-z]:\\') {
        Write-Warning "FolderTarget '$p' is not a local drive-letter path (expected 'c:\...'); skipped."
        continue
    }
    $cleanTargets += $p
}
if (-not $cleanTargets) { Write-Warning 'No valid FolderTarget paths. Nothing to do.'; return }

# --- Resolve the target server list ------------------------------------------
if ($PSCmdlet.ParameterSetName -eq 'ByADGroup') {
    if (-not (Get-Module -ListAvailable -Name ActiveDirectory)) {
        throw "ActiveDirectory module not available on this machine; cannot resolve -ADGroup '$ADGroup'. " +
              "Run this helper from a host with RSAT AD PowerShell, or pass -ComputerName instead."
    }
    Import-Module ActiveDirectory -ErrorAction Stop

    # DIRECT (non-recursive), computer objects only, Enabled only - mirrors
    # Get-ListOfServers-Direct, the resolver the clean workflow uses.
    $memberParams = @{ Identity = $ADGroup; ErrorAction = 'Stop' }
    if ($DomainName) { $memberParams['Server'] = $DomainName }
    if ($Credential) { $memberParams['Credential'] = $Credential }

    $computerParams = @{ Properties = @('DNSHostName', 'Enabled') }
    if ($DomainName) { $computerParams['Server'] = $DomainName }
    if ($Credential) { $computerParams['Credential'] = $Credential }

    $ComputerName =
        Get-ADGroupMember @memberParams |
            Where-Object { $_.objectClass -eq 'computer' } |
            ForEach-Object { Get-ADComputer -Identity $_.distinguishedName @computerParams } |
            Where-Object { $_.Enabled } |
            ForEach-Object { if ($_.DNSHostName) { $_.DNSHostName } else { $_.Name } }
}

if (-not $ComputerName) { Write-Warning 'No target servers resolved. Nothing to do.'; return }

Write-Host ("Target servers ({0}): {1}" -f $ComputerName.Count, ($ComputerName -join ', '))
Write-Host ("Folder target(s)   : {0}" -f ($cleanTargets -join ', '))
$agedPerTarget = $FilesPerFolder * (1 + $SubFolders)
Write-Host ("Plan per target    : {0} aged file(s) across 1 root + {1} subfolder(s), back-dated {2} day(s){3}" -f `
        $agedPerTarget, $SubFolders, $AgeDays, $(if ($NoNegativeTests) { '' } else { ', + 3 negative-test artifacts' }))

# --- File/folder creation logic (runs locally or inside a remoting session) ---
$makeData = {
    param($BaseDir, $FilesPerFolder, $SubFolders, $AgeDays, $NoNegativeTests)

    $created = New-Object System.Collections.Generic.List[string]
    $aged    = (Get-Date).AddDays(-1 * $AgeDays)
    $future  = (Get-Date).AddDays(2)   # newer than any production threshold (-1 / 0)

    # Helper: write a text file and stamp its timestamps.
    function New-StampedFile {
        param($Path, $Stamp, [switch]$ReadOnlyHidden)
        "Lab placeholder ($([IO.Path]::GetFileName($Path))) for Clean-ServerDisks testing. Safe to delete." |
            Set-Content -LiteralPath $Path -Encoding Ascii -Force -ErrorAction Stop
        $it = Get-Item -LiteralPath $Path -Force
        if ($ReadOnlyHidden) { $it.Attributes = 'ReadOnly, Hidden' }
        $it.CreationTime = $Stamp; $it.LastWriteTime = $Stamp; $it.LastAccessTime = $Stamp
    }

    # Ensure the target root exists (the automation cleans its CONTENTS, not itself).
    $rootCreated = $false
    if (-not (Test-Path -LiteralPath $BaseDir)) {
        New-Item -ItemType Directory -Path $BaseDir -Force -ErrorAction Stop | Out-Null
        $rootCreated = $true
    }

    # Build the folder list: root + N realistic ccmcache-style subfolders.
    $folders = New-Object System.Collections.Generic.List[string]
    $folders.Add($BaseDir)
    for ($s = 1; $s -le $SubFolders; $s++) {
        # e.g. 0a1b2c3d.1  (8 hex + .revision, like real SCCM cache content folders)
        $hex = -join ((1..8) | ForEach-Object { '{0:x}' -f (Get-Random -Minimum 0 -Maximum 16) })
        $sub = Join-Path $BaseDir ("{0}.{1}" -f $hex, (Get-Random -Minimum 1 -Maximum 9))
        New-Item -ItemType Directory -Path $sub -Force -ErrorAction Stop | Out-Null
        $folders.Add($sub)
    }

    # Aged files in every folder (root + subfolders).
    foreach ($dir in $folders) {
        for ($i = 1; $i -le $FilesPerFolder; $i++) {
            $stamp = $aged.AddMinutes(-1 * $i)
            $name  = 'cache_{0}_{1:000}.tmp' -f $stamp.ToString('yyyyMMdd-HHmmss'), $i
            New-StampedFile -Path (Join-Path $dir $name) -Stamp $stamp
            $created.Add((Join-Path $dir $name))
        }
    }

    # Negative-test artifacts (must SURVIVE, except readonly/hidden which survives
    # only when ForceEnable='no'). Placed in the target root.
    if (-not $NoNegativeTests) {
        # (a) excluded by name in Remove-files ($FileExclude) - must survive
        New-StampedFile -Path (Join-Path $BaseDir 'vmware-vmsvc-SYSTEM.log') -Stamp $aged
        $created.Add((Join-Path $BaseDir 'vmware-vmsvc-SYSTEM.log'))
        # (b) future-dated - newer than the age cutoff for both scenarios - must survive
        New-StampedFile -Path (Join-Path $BaseDir '_KEEP_newer_than_threshold.txt') -Stamp $future
        $created.Add((Join-Path $BaseDir '_KEEP_newer_than_threshold.txt'))
        # (c) read-only + hidden, aged - survives ForceEnable='no', deleted ForceEnable='yes'
        New-StampedFile -Path (Join-Path $BaseDir '_readonly_hidden_aged.txt') -Stamp $aged -ReadOnlyHidden
        $created.Add((Join-Path $BaseDir '_readonly_hidden_aged.txt'))
    }

    # Back-date the SUBFOLDER timestamps LAST - writing child files bumped them to
    # 'now'. Do this after all writes so the folders themselves are clean targets
    # under FolderIncluded='yes'. (The root is intentionally left alone - it is not
    # a candidate; only its contents are.)
    for ($s = 1; $s -lt $folders.Count; $s++) {
        $d = Get-Item -LiteralPath $folders[$s] -Force
        $d.CreationTime = $aged; $d.LastWriteTime = $aged; $d.LastAccessTime = $aged
    }

    [pscustomobject]@{
        Directory   = $BaseDir
        AgedFiles   = ($created | Where-Object { $_ -notmatch '_KEEP_|vmware-vmsvc|_readonly_hidden_' }).Count
        SubFolders  = $SubFolders
        Negatives   = (-not $NoNegativeTests)
        RootCreated = $rootCreated
    }
}

# --- Seed each server × each target -------------------------------------------
$okCount = 0; $failCount = 0; $totalAged = 0

foreach ($server in $ComputerName) {
    foreach ($target in $cleanTargets) {

        if (-not $PSCmdlet.ShouldProcess("$server ($target)", "Seed disk-clean test data")) { continue }

        try {
            if ($UseRemoting) {
                $icmParams = @{
                    ComputerName = $server
                    ScriptBlock  = $makeData
                    ArgumentList = @($target, $FilesPerFolder, $SubFolders, $AgeDays, [bool]$NoNegativeTests)
                    ErrorAction  = 'Stop'
                }
                if ($Credential) { $icmParams['Credential'] = $Credential }
                $result = Invoke-Command @icmParams
                $where  = "$server (local: $($result.Directory))"
            }
            else {
                # c:\path -> \\server\C$\path  (same admin-share addressing the automation uses)
                $unc = '\\{0}\{1}' -f $server, ($target -replace '^([A-Za-z]):', '$1$')
                $result = & $makeData $unc $FilesPerFolder $SubFolders $AgeDays ([bool]$NoNegativeTests)
                $where  = $unc
            }

            $rootNote = if ($result.RootCreated) { ' (created missing target dir)' } else { '' }
            $negNote  = if ($result.Negatives)   { ' +3 negatives' } else { '' }
            Write-Host ("[OK]   {0}: {1} aged file(s), {2} subfolder(s){3} in {4}{5}" -f `
                    $server, $result.AgedFiles, $result.SubFolders, $negNote, $where, $rootNote) -ForegroundColor Green
            $totalAged += $result.AgedFiles
            $okCount++
        }
        catch {
            Write-Warning ("[FAIL] {0} ({1}): {2}" -f $server, $target, $_.Exception.Message)
            $failCount++
        }
    }
}

# --- Summary ------------------------------------------------------------------
Write-Host ''
Write-Host '=================== Seeding Summary ==================='
Write-Host ("  Seed operations OK   : {0}" -f $okCount)
Write-Host ("  Seed operations FAIL : {0}" -f $failCount) -ForegroundColor $(if ($failCount) { 'Red' } else { 'Gray' })
Write-Host ("  Total aged files     : {0}  (back-dated {1} day(s))" -f $totalAged, $AgeDays)
if (-not $NoNegativeTests) {
    Write-Host '  Negative-test artifacts per target (expected to SURVIVE a clean):'
    Write-Host '    - vmware-vmsvc-SYSTEM.log        (excluded by name)'
    Write-Host '    - _KEEP_newer_than_threshold.txt (future-dated, newer than cutoff)'
    Write-Host "    - _readonly_hidden_aged.txt      (survives ForceEnable='no'; deleted ForceEnable='yes')"
}
Write-Host '  Next: run Clean-ServerDisks-ByADGroup with whatIf=yes and confirm the'
Write-Host "        aged items appear as '[ReportOnly] WouldDelete: ...' and the"
Write-Host '        negatives do NOT.'
Write-Host '======================================================'
