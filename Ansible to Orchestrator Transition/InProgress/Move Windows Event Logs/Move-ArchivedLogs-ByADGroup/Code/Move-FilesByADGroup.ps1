<#
.SYNOPSIS
    Moves files from the servers in an AD group to a per-server folder on a file share.

.DESCRIPTION
    Consolidates seven AAP job templates and two playbook generations
    (file-move_with-UNCPath_AD-Group.yml and file-move_with-UNCPath_AD-Group-TEST(1).yml)
    into one script with two actions.

    Held in Orchestrator as a Resource Element and copied to the PowerShell host by
    stageScriptOnHost. It replaces PowerShell that was previously embedded inline in the
    playbooks as win_shell heredocs, so there is no existing script generation to preserve.

    TWO ACTIONS, BECAUSE THERE ARE TWO IDENTITIES.
    The playbooks read AD as the Machine/connection credential and move files as the Cloud
    credential (via `become: runas`). Those are different accounts in six of the seven
    templates. One PowerShell session is one identity, so the split is preserved by running
    two invocations against two PowerShellHost objects:

        Get-GroupComputers  -> the AD-query identity   (queryAs)
        Move-Files          -> the file-move identity  (moveAs)

    Orchestrator carries the computer list between them.

.NOTES
    Behaviour corrected relative to the playbooks - all four deliberate, all requested:

    1. FILE COUNTS ARE ACCURATE.
       The originals piped `Move-Item -PassThru` AND `$_.Name` into the same collection, so
       every "Moved N files" message reported exactly twice the real number. Counting here
       is done with explicit counters incremented on confirmed success.

    2. -OlderThanDays MEANS OLDER THAN N DAYS.
       The originals computed (Get-Date).AddDays(+$Days), which moves the cutoff into the
       FUTURE - so a positive value was more permissive, not less, and 30 meant "everything".
       Here the cutoff is (Get-Date).AddDays(-$OlderThanDays): a file is moved only when it
       is strictly older than that, so a file exactly N days old is KEPT.
       NEGATIVE VALUES ARE REJECTED. They were the working convention in the old code
       (the delivered lab checklist used fileAgeDays: -1), and carrying one forward here
       would put the cutoff in the future and move every file in scope.

    3. DIRECTORY STRUCTURE IS PRESERVED.
       The originals gathered with -Recurse and dropped every file into one flat folder with
       -Force, so two files sharing a name in different subdirectories silently overwrote
       each other. Here the destination mirrors the source tree beneath the per-server
       folder, and an existing destination file is NOT overwritten unless -OverwriteExisting
       is 'yes' - a collision is reported as an error and the source file is left in place,
       so nothing is destroyed by a run that did not expect it.

    4. THE AD QUERY IS BOTH DOMAIN-TARGETED AND RECURSIVE, AND THE DOMAIN IS DERIVED.
       Neither playbook did both: the TEST generation passed -Server but read direct members
       only (silently missing nested groups); the other recursed but ignored DomainName
       entirely, resolving the group in whatever domain the connection account belonged to.
       A member that cannot be resolved is an ERROR, not a silent skip (S-27).

       There is no -DomainName parameter. The group must be given as a distinguishedName,
       and the domain comes from its DC= components, so the two cannot disagree - there is
       only one place either can come from. That removes both playbook defects at once,
       including template #5's DomainName that was passed and never read.

    Exit codes:  0 success | 1 completed with errors | 2 unusable input
#>

[CmdletBinding()]
param (
    [Parameter(Mandatory = $true)]
    [ValidateSet('Get-GroupComputers', 'Move-Files')]
    [string]$Action,

    # --- Get-GroupComputers ---------------------------------------------------
    # No -DomainName: the group's distinguishedName already carries it. See below.
    [Parameter(Mandatory = $false)]
    [string]$GroupIdentity,

    # --- Move-Files -----------------------------------------------------------
    [Parameter(Mandatory = $false)]
    [string]$ComputerNames,          # comma-separated; from Get-GroupComputers

    [Parameter(Mandatory = $false)]
    [string]$SourcePath,             # relative to \\<server>\ e.g. 'C$\Windows\System32\winevt\Logs'

    [Parameter(Mandatory = $false)]
    [string]$TargetPath,             # e.g. '\\fileserver.corp.net\archive$\Windows'

    [Parameter(Mandatory = $false)]
    [string]$FileFilter = '*',

    [Parameter(Mandatory = $false)]
    [string]$OlderThanDays = '0',

    [Parameter(Mandatory = $false)]
    [ValidateSet('yes', 'no')]
    [string]$WhatIf = 'yes',

    [Parameter(Mandatory = $false)]
    [ValidateSet('yes', 'no')]
    [string]$OverwriteExisting = 'no'
)

$ErrorActionPreference = 'Stop'
$Global:ErrorCount = 0

function Write-Log {
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [ValidateSet('Info', 'Warn', 'Error', 'Success')][string]$Level = 'Info'
    )
    if ($Level -eq 'Error') { $Global:ErrorCount++ }
    $line = '{0}  {1}: {2}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $Level.ToUpper(), $Message
    switch ($Level) {
        'Error'   { Write-Host $line -ForegroundColor Red }
        'Warn'    { Write-Host $line -ForegroundColor Yellow }
        'Success' { Write-Host $line -ForegroundColor Green }
        default   { Write-Host $line }
    }
}

function Import-ADModule {
    try { Import-Module ActiveDirectory -ErrorAction Stop }
    catch {
        Write-Log "ActiveDirectory module unavailable - $($_.Exception.Message)" 'Error'
        exit 2
    }
}

# ---------------------------------------------------------------------------
# Get-GroupComputers
#
# Runs as the AD-QUERY identity. Emits the computer list on one marked line for
# Orchestrator to parse and hand to the move invocation.
# ---------------------------------------------------------------------------
function Invoke-GetGroupComputers {

    if ([string]::IsNullOrWhiteSpace($GroupIdentity)) {
        Write-Log 'GroupIdentity is required - the distinguishedName of the server group.' 'Error'
        exit 2
    }

    Import-ADModule

    # --- The group must be a distinguishedName, and it supplies the domain ---
    #
    # -Identity would also accept an objectGUID, objectSid or sAMAccountName (NOT a CN - the
    # bare names two of the job templates pass resolve as sAMAccountName, not as the CN they
    # look like). Only the DN is accepted, for two reasons.
    #
    # FIRST, how the alternatives fail:
    #
    #   A stale DN - the group was renamed or moved to another OU, either of which changes
    #   the DN - does not resolve. The run stops, says so, and nothing is moved.
    #
    #   A bare sAMAccountName is unique only WITHIN a domain. If it happens to exist in the
    #   domain being queried, it resolves to that group and the run succeeds against the
    #   WRONG set of servers, with nothing in the output looking wrong.
    #
    #   For a workflow that moves files off production servers, a loud failure is worth more
    #   than a form that is harder to invalidate. A stale DN costs a config edit; a silently
    #   wrong scope costs a search of the file server.
    #
    # SECOND, the DN already names its domain, so there is no separate DomainName input.
    # The playbooks had one and it was the source of two distinct defects: the non-TEST
    # generation ignored it entirely and resolved the group in whatever domain the
    # credential belonged to, while template #5 passed a DomainName that therefore did
    # nothing. Deriving it here means the domain and the group cannot disagree, because
    # there is only one place either can come from.

    if ($GroupIdentity -notmatch '(?i)^\s*CN=') {
        Write-Log ("GroupIdentity must be a distinguishedName beginning 'CN=' - got '$GroupIdentity'. " +
                   "A bare group name is a sAMAccountName, which is unique only within a domain and can " +
                   "silently resolve to a different group. Get the DN with: Get-ADGroup -Identity " +
                   "'$GroupIdentity' -Server <domain> | Select-Object -ExpandProperty DistinguishedName") 'Error'
        exit 2
    }

    # Domain from the DN's DC= components, honouring DN escaping (\, \= \+).
    $dnLabels = @()
    foreach ($m in [regex]::Matches($GroupIdentity, '(?i)DC=((?:[^,\\]|\\.)*)')) {
        $dnLabels += ($m.Groups[1].Value -replace '\\(.)', '$1')
    }
    $domain = $dnLabels -join '.'

    if ([string]::IsNullOrWhiteSpace($domain)) {
        Write-Log ("GroupIdentity '$GroupIdentity' has no 'DC=' component, so it is not a complete " +
                   "distinguishedName and no domain can be derived from it. The full form is " +
                   "'CN=<group>,OU=<...>,DC=<sub>,DC=<domain>,DC=<tld>'.") 'Error'
        exit 2
    }

    Write-Log "Domain derived from the group DN: $domain"

    # Resolve before reading members: fails early with a clear message, confirms the object
    # really is a group, and puts its identity in the run record - which answers "which
    # group did that run actually use?" without anybody inferring it.
    $group = $null
    try {
        $group = Get-ADGroup -Identity $GroupIdentity -Server $domain -Properties CN, sAMAccountName -ErrorAction Stop
    }
    catch {
        Write-Log ("Group '$GroupIdentity' could not be resolved on '$domain' - $($_.Exception.Message). " +
                   "A DN changes when a group is renamed OR moved between OUs, so a DN that used to work " +
                   "does not mean the group is gone. Find it by name: " +
                   "Get-ADGroup -Filter `"sAMAccountName -eq '<name>'`" -Server '$domain'") 'Error'
        exit 1
    }

    Write-Log "Group resolved: DN='$($group.DistinguishedName)' CN='$($group.CN)' sAMAccountName='$($group.sAMAccountName)'"

    $members = $null
    try {
        # -Recursive from the non-TEST generation, -Server from the TEST generation.
        # Neither playbook had both. Read from the resolved DN so this cannot re-resolve to
        # a different object than the one logged above.
        $members = @(Get-ADGroupMember -Identity $group.DistinguishedName -Server $domain -Recursive -ErrorAction Stop)
    }
    catch {
        Write-Log "Could not read members of '$($group.DistinguishedName)' on '$domain' - $($_.Exception.Message)" 'Error'
        exit 1
    }

    Write-Log "Group has $($members.Count) member(s) after recursion"

    $computers = @()
    foreach ($m in $members) {

        if ($m.objectClass -ne 'computer') {
            Write-Log "Skipping non-computer member '$($m.name)' (objectClass=$($m.objectClass))"
            continue
        }

        try {
            $c = Get-ADComputer -Identity $m.distinguishedName -Server $domain -Properties DNSHostName, Enabled -ErrorAction Stop

            if ([string]::IsNullOrWhiteSpace($c.DNSHostName)) {
                # The originals dropped these with `| select()`, silently. A computer with no
                # DNSHostName cannot be addressed, so its files never move and nobody is told.
                Write-Log "Computer '$($c.Name)' has no DNSHostName - it cannot be addressed and its files will NOT be moved." 'Error'
                continue
            }

            if ($c.Enabled -ne $true) {
                # Not skipped - the originals did not skip them either, and changing that
                # would quietly narrow the scope. Logged so the connection failure that
                # usually follows is explainable.
                Write-Log "Computer '$($c.DNSHostName)' is DISABLED in AD. It is still in scope; expect it to be unreachable." 'Warn'
            }

            $computers += $c.DNSHostName
        }
        catch {
            # S-27: targeting groups are single-domain by agreement, so a member that will not
            # resolve against this server is a violated constraint, not routine. It is an
            # error so the run ends "Completed with Errors" instead of reporting success while
            # omitting a server somebody deliberately added to the group.
            Write-Log "Member '$($m.distinguishedName)' could not be resolved on '$domain' - $($_.Exception.Message)" 'Error'
        }
    }

    $computers = @($computers | Sort-Object -Unique)
    Write-Log "Resolved $($computers.Count) computer(s)"

    # Single marked line, so parsing does not depend on the surrounding log text.
    # ConvertTo-Json on a single-element array emits a bare string, so force an array.
    $json = if ($computers.Count -eq 0) { '[]' } else { ConvertTo-Json -InputObject @($computers) -Compress }
    Write-Host "PSO_COMPUTERS=$json"

    if ($computers.Count -eq 0) {
        Write-Log "Group '$GroupIdentity' resolved to no usable computers. Nothing will be moved." 'Warn'
    }
}

# ---------------------------------------------------------------------------
# Move-Files
#
# Runs as the FILE-MOVE identity. Reaches \\<server>\<SourcePath> and the target
# share - both second hops from this session, which is why the host object needs
# Kerberos delegation covering CIFS as well as the directory service.
# ---------------------------------------------------------------------------
function Invoke-MoveFiles {

    foreach ($required in @(
        @{ Name = 'ComputerNames'; Value = $ComputerNames },
        @{ Name = 'SourcePath';    Value = $SourcePath },
        @{ Name = 'TargetPath';    Value = $TargetPath })) {
        if ([string]::IsNullOrWhiteSpace($required.Value)) {
            Write-Log "$($required.Name) is required." 'Error'
            exit 2
        }
    }

    # --- The age cutoff ---------------------------------------------------
    $days = 0
    if (-not [int]::TryParse($OlderThanDays, [ref]$days)) {
        Write-Log "OlderThanDays '$OlderThanDays' is not a whole number." 'Error'
        exit 2
    }
    if ($days -lt 0) {
        Write-Log ("OlderThanDays must be zero or greater - got $days. " +
                   "Negative values were the convention in the previous code, where the cutoff was " +
                   "(Get-Date).AddDays(+N) and a negative number meant 'older than N days'. That is " +
                   "inverted here: -OlderThanDays 7 means older than 7 days. A negative value would " +
                   "put the cutoff in the FUTURE and move every file in scope, so it is rejected " +
                   "rather than interpreted.") 'Error'
        exit 2
    }

    # Strictly older than the cutoff, so a file exactly N days old is KEPT.
    $cutoff = (Get-Date).AddDays(-$days)
    if ($days -eq 0) {
        Write-Log "OlderThanDays is 0 - every matching file is in scope, regardless of age. This matches what the job templates do today." 'Warn'
    } else {
        Write-Log "Moving files last written before $($cutoff.ToString('yyyy-MM-dd HH:mm:ss')) (older than $days day(s)); anything newer, or exactly $days day(s) old, is kept."
    }

    $dryRun    = ($WhatIf -eq 'yes')
    $overwrite = ($OverwriteExisting -eq 'yes')
    if ($dryRun)    { Write-Log 'WhatIf is yes - files will be listed but NOT moved.' 'Warn' }
    if ($overwrite) { Write-Log 'OverwriteExisting is yes - a destination file of the same name WILL be replaced. This is the old -Force behaviour and it destroys the existing copy.' 'Warn' }

    $servers = @($ComputerNames.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($servers.Count -eq 0) {
        Write-Log 'ComputerNames contained no usable entries.' 'Error'
        exit 2
    }

    $srcRelative = $SourcePath.Trim().Trim('\')
    $totalMoved = 0; $totalSkipped = 0; $totalFailed = 0; $serversDone = 0

    foreach ($server in $servers) {

        $hostShort   = $server.Split('.')[0]
        $sourceRoot  = "\\$server\$srcRelative"
        $serverTarget = Join-Path -Path $TargetPath.TrimEnd('\') -ChildPath $hostShort

        Write-Log "[$server] $sourceRoot -> $serverTarget"

        try {
            if (-not (Test-Path -LiteralPath $sourceRoot)) {
                Write-Log "[$server] source path not found or unreachable: $sourceRoot" 'Error'
                $totalFailed++
                continue
            }

            # Resolve once so relative paths are computed against the real, normalised root -
            # this is what preserves the tree rather than flattening it.
            $rootResolved = (Resolve-Path -LiteralPath $sourceRoot).ProviderPath.TrimEnd('\')

            $candidates = @(Get-ChildItem -LiteralPath $rootResolved -Recurse -File -Filter $FileFilter -ErrorAction Stop |
                            Where-Object { $_.LastWriteTime -lt $cutoff })

            if ($candidates.Count -eq 0) {
                Write-Log "[$server] no files matched '$FileFilter' older than the cutoff."
                $serversDone++
                continue
            }

            Write-Log "[$server] $($candidates.Count) file(s) match"

            if (-not $dryRun -and -not (Test-Path -LiteralPath $serverTarget -PathType Container)) {
                New-Item -ItemType Directory -Path $serverTarget -Force | Out-Null
                Write-Log "[$server] created $serverTarget"
            }

            $moved = 0; $skipped = 0; $failed = 0

            foreach ($file in $candidates) {

                # Sub-path of the file relative to the source root, e.g. 'Sub\Deeper'.
                # Empty for files sitting directly in the root.
                $subDir = ''
                if ($file.DirectoryName.Length -gt $rootResolved.Length) {
                    $subDir = $file.DirectoryName.Substring($rootResolved.Length).Trim('\')
                }

                $destDir  = if ($subDir -eq '') { $serverTarget } else { Join-Path -Path $serverTarget -ChildPath $subDir }
                $destFile = Join-Path -Path $destDir -ChildPath $file.Name

                if ($dryRun) {
                    Write-Log "[$server] WHATIF would move: $($file.FullName) -> $destFile"
                    $moved++
                    continue
                }

                try {
                    if (-not (Test-Path -LiteralPath $destDir -PathType Container)) {
                        New-Item -ItemType Directory -Path $destDir -Force | Out-Null
                    }

                    if ((Test-Path -LiteralPath $destFile) -and -not $overwrite) {
                        # The source file is deliberately left in place. A collision means two
                        # distinct files claim the same destination; overwriting would destroy
                        # one of them and report success, which is what the original -Force did.
                        Write-Log "[$server] destination already exists, source kept: $destFile" 'Error'
                        $skipped++
                        continue
                    }

                    Move-Item -LiteralPath $file.FullName -Destination $destFile -Force:$overwrite -ErrorAction Stop
                    $moved++      # incremented only after the move returns without throwing
                }
                catch {
                    Write-Log "[$server] failed to move '$($file.FullName)' - $($_.Exception.Message)" 'Error'
                    $failed++
                }
            }

            $verb = if ($dryRun) { 'would move' } else { 'moved' }
            Write-Log "[$server] $verb $moved file(s); $skipped skipped; $failed failed" $(if ($failed -gt 0 -or $skipped -gt 0) { 'Warn' } else { 'Success' })

            $totalMoved += $moved; $totalSkipped += $skipped; $totalFailed += $failed
            $serversDone++
        }
        catch {
            Write-Log "[$server] $($_.Exception.Message)" 'Error'
            $totalFailed++
        }
    }

    # Single marked line: the numbers Orchestrator reports are the numbers this script
    # counted, not a figure re-derived from the transcript.
    Write-Host ("PSO_RESULT=" + (ConvertTo-Json -Compress -InputObject ([ordered]@{
        whatIf        = $dryRun
        servers       = $servers.Count
        serversDone   = $serversDone
        filesMoved    = $totalMoved
        filesSkipped  = $totalSkipped
        filesFailed   = $totalFailed
        errors        = $Global:ErrorCount
    })))

    $verb = if ($dryRun) { 'Would move' } else { 'Moved' }
    Write-Log "$verb $totalMoved file(s) across $serversDone of $($servers.Count) server(s); $totalSkipped skipped; $totalFailed failed." 'Info'
}

# ---------------------------------------------------------------------------

Write-Log "Action: $Action"

switch ($Action) {
    'Get-GroupComputers' { Invoke-GetGroupComputers }
    'Move-Files'         { Invoke-MoveFiles }
}

if ($Global:ErrorCount -gt 0) {
    Write-Log "Completed with $($Global:ErrorCount) error(s)." 'Error'
    exit 1
}

Write-Log 'Complete.' 'Success'
exit 0
