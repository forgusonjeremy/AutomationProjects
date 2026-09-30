<#
.SYNOPSIS
    Deletes aged files (and optionally folders) from one or more local folders on each
    Windows server in a supplied list, or reports what it would delete.

.DESCRIPTION
    This is the Windows half of the "Windows Server Clean Disks" automation. It replaces
    the clean-ServerDisk action of cvs_functions.ps1, which servers_diskclean.yml invoked.

    WHERE THIS FILE LIVES
    The master copy is an Orchestrator Resource Element named Invoke-ServerDiskClean.ps1.
    Before every run, the stageScriptOnHost action compares the SHA-256 of that element
    with the copy on the PowerShell host (default C:\PSO\Scripts\Invoke-ServerDiskClean.ps1):

        not there yet         -> copied
        exact match           -> left alone; the existing copy is run
        any difference        -> overwritten, then verified, then run

    So the host can only ever run exactly what Orchestrator holds. Do NOT edit the copy on
    the host: the next run will detect the change and overwrite it. Change the Resource
    Element instead (and the repository copy it was imported from).

    This file is kept FULLY COMMENTED on purpose. Because it crosses WinRM only when it
    has changed, its size costs nothing on a normal run.

    THE SCRIPT DOES NOT TALK TO ACTIVE DIRECTORY
    Orchestrator's Active Directory plug-in resolves the security group to its direct,
    enabled computer members and passes them in through -ComputerNames. The script never
    runs Get-ADGroupMember and needs no ActiveDirectory module.

    THE SCRIPT DOES NOT SEND EMAIL
    It prints a per-server result as one PSO_RESULT line of JSON. Orchestrator builds the
    HTML report from that and sends it through its Mail plug-in.

    HOW IT REACHES THE SERVERS
    Everything runs on the PowerShell host and reaches each server through its
    administrative share:

        c:\Windows\ccmcache   on SRV01   becomes   \\SRV01\c$\Windows\ccmcache

    So the account the PowerShell host runs as needs local administrator rights on each
    target (the admin share requires it) and SMB (TCP 445) from the host to each target.
    Nothing is installed on or run on the targets.

    PHYSICAL AND VIRTUAL SERVERS ARE TREATED IDENTICALLY
    Every operation is a file-system operation over SMB. Nothing touches vCenter or
    VMware Tools, so hardware and VMs are handled the same way.

    WHAT IS DELETED - THE SELECTION RULES
    These are the rules of the original Remove-files function (as hardened by change S-15),
    with one deliberate change to how folders are chosen (S-35). For each folder target on
    each server:

      1. Every FILE under the target is enumerated recursively (Get-ChildItem -Recurse),
         matching -FilterOn. Hidden and system items are NOT enumerated (no -Force).
      2. With -FolderIncluded 'yes', every FOLDER under the target is enumerated as well,
         WHATEVER ITS NAME -- -FilterOn applies to files only (S-35). A folder is removed
         whole, with everything in it.
      3. An item is a candidate when its LastWriteTime is older than the cutoff
         (now minus -OlderThanDays days) AND its name is not exactly
         'vmware-vmsvc-SYSTEM.log'.
      4. Each candidate is removed with Remove-Item -Recurse, adding -Force only when
         -ForceEnable is 'yes'. One failure is logged and the rest continue.
      5. The target folder itself is never a candidate: it is emptied, not removed.

    DELETING FOLDERS MEANS DELETING EVERYTHING IN THEM -- SO IT MUST BE ASKED FOR IN FULL
    Because a folder goes with all of its contents, folders are deleted ONLY when
    -FolderIncluded 'yes' comes together with:
        -FilterOn     '*' or '*.*'   (a filter that matches every file), AND
        -ForceEnable  'yes'          (read-only contents are deleted too).
    With any other combination, FOLDER DELETION IS DECLINED -- no folder is touched -- but
    the rest of the request still runs: files matching -FilterOn are cleaned exactly as if
    -FolderIncluded were 'no' (S-35). A WARN line says why, and PSO_RESULT carries the
    reason in 'foldersDeclined' so Orchestrator puts it in its log and the report.

    The guard never goes the other way: a narrow filter or protected read-only files are
    never overridden by a folder deletion that would remove them anyway.

    WHAT IS PRESERVED - NEVER DELETED
      - vmware-vmsvc-SYSTEM.log (exact, case-sensitive name) - unless it sits inside a
        folder that is itself removed; see "READ THIS" in the NOTES.
      - Anything with a LastWriteTime at or after the cutoff - same caveat.
      - Loose hidden or system files directly under a target (they are never enumerated).
      - The target folder itself.
      - Read-only items, when -ForceEnable is 'no' (the delete fails and is logged).
      - All folders, when -FolderIncluded is 'no'.
      - EVERYTHING, when -ReportOnly is 'yes' (the default).

.PARAMETER ComputerNames
    Comma-separated server names (normally FQDNs), supplied by Orchestrator from the AD
    group's direct, enabled computer members.

.PARAMETER FolderTarget
    One or more LOCAL folder paths as seen on each server, separated by '|' - for example
    'c:\Windows\ccmcache' or 'c:\Windows\ccmcache|d:\Temp'. The '|' separator is used
    because it can never appear in a Windows path. Each path must be an absolute local
    path with a drive letter. Drive roots and core operating-system folders are refused
    (see Test-FolderTarget).

.PARAMETER OlderThanDays
    Delete items older than this many days. 1 = older than a day (the cache templates);
    0 = everything older than the moment the run started (the profile templates).
    This is the positive form of the Ansible var_NumberOfDays (-1 there is 1 here).

.PARAMETER FilterOn
    File-name filter, e.g. '*.tmp' or 'cache_*'. Default '*.*' (every file). It applies to
    FILES only; folders are chosen by age alone when -FolderIncluded is 'yes'. Folders are
    deleted only when it is '*' or '*.*' (see "DELETING FOLDERS" above).

.PARAMETER FolderIncluded
    'yes' - folders older than the cutoff are removed whole, as well as matching files --
    PROVIDED -FilterOn is '*' or '*.*' AND -ForceEnable is 'yes'. Otherwise folder deletion
    is declined (logged, reported in 'foldersDeclined') and only matching files are cleaned.
    'no' (default) - files only; every folder is left in place.

.PARAMETER ForceEnable
    'yes' - Remove-Item -Force, so read-only items are deleted too. 'no' (default) -
    read-only items are left in place and each is logged as an error. Must be 'yes' for
    -FolderIncluded 'yes' to delete folders.

.PARAMETER ReportOnly
    THE SAFETY GATE. 'yes' (default) lists what WOULD be deleted and deletes nothing.
    Only 'no' deletes. Any other value fails parameter validation, so nothing runs.

.PARAMETER MaxItemsListed
    How many individual items to name in the log per target per server (the would-delete
    list, and separately the failures). The counts always cover everything; this only
    limits how many are printed. A cache can hold tens of thousands of files, and the whole
    transcript is copied into the Orchestrator run log. Default 25; 0 names none.

.OUTPUTS
    Log lines on the host stream, and exactly one final line:

        PSO_RESULT={...compact JSON...}

    invokeStagedScript parses that line. If it is missing, the run is treated as having
    failed to complete. Fields:

        serversRequested    number    servers passed in
        serversReachable    number    servers whose admin share could be opened
        serversUnreachable  number    servers whose admin share could not be opened
        serversWithErrors   number    reachable servers where anything failed
        itemsMatched        number    candidates found (all servers, all targets)
        itemsRemoved        number    candidates removed (0 in a report-only run)
        itemsFailed         number    candidates that could not be removed
        bytes               number    report-only: size of what would be removed (estimate)
                                      delete: size of what was removed (measured)
        reportOnly          boolean   what the script actually did
        olderThanDays       number    as received
        cutoff              string    the cutoff, yyyy-MM-dd HH:mm:ss (host local time)
        targets             string[]  the folder targets, as received
        foldersDeclined     string    empty when folder deletion was not requested or was
                                      performed; otherwise WHY it was declined (the files
                                      were still cleaned)
        servers             object[]  one per server:
                                        name, status, matched, removed, failed, bytes,
                                        freeBefore, freeAfter, detail
                                      status is one of:
                                        ReportOnly | Cleaned | CleanedWithErrors |
                                        Unreachable | Failed
        errorCount          number    ERROR lines logged
        errors              string[]  the first 10 of them, shortened

.NOTES
    Requires Windows PowerShell 5.1 or later on the PowerShell host. Nothing is required on
    the targets beyond the admin share.

    READ THIS - A FOLDER IS REMOVED WHOLE (inherited behaviour, deliberately unchanged)
    With -FolderIncluded 'yes', a FOLDER whose own LastWriteTime is older than the cutoff
    is removed with -Recurse, taking EVERYTHING inside it - including files newer than the
    cutoff, hidden files, and a vmware-vmsvc-SYSTEM.log - because a folder's timestamp only
    changes when entries are added, removed or renamed directly in it, not when a file
    deeper down is modified. That is how the original script behaved and it is what the
    user-profile templates (c:\users, 0 days, force) rely on to remove whole profiles, so it
    is preserved exactly. For the SCCM cache it is harmless: cache content is written once.
    Do not point a live run with -FolderIncluded 'yes' at a folder whose sub-folders hold
    live data you expect the age rule to protect.

    DIFFERENCES FROM cvs_functions.ps1 -Action clean-ServerDisk  (see the Change Register)
      S-31  Standalone script; no AD lookup (Orchestrator's AD plug-in supplies the list);
            no ActiveDirectory module guard needed.
      S-31  -OlderThanDays is positive (was the negative -NumberOfDays).
      S-31  -ReportOnly 'yes'/'no' replaces -WhatIf 'yes'/'no'; same fail-safe default.
      S-31  Folder targets are '|'-separated (was a YAML-list string run through
            Convert-YAMLList and split on ',').
      S-32  Per-server structured result (PSO_RESULT) instead of free-text Info:/Error:
            lines scanned by parseScriptOutput.
      S-32  Space freed is measured, and drive free space is recorded before and after.
      S-33  One inaccessible sub-folder no longer abandons the whole target: the target
            root must open (or the target is an error), but an unreadable folder deeper
            down is logged as an error and everything else is still cleaned.
      S-33  A folder target that does not exist on a server is a warning for that server
            (nothing to clean), and an ERROR only if it exists on NONE of the reachable
            servers - which almost always means a mistyped path.
      S-36  Drive roots, and any folder that is or is INSIDE a protected OS tree (\Windows,
            \Program Files, \Program Files (x86), \ProgramData, \Boot, \Recovery, \System
            Volume Information), are refused before anything is touched -- except the
            allow-listed caches \Windows\ccmcache, \Windows\Temp and
            \Windows\SoftwareDistribution\Download. (Was: exact-match on a few folders only.)
      S-33  The number of individually named items is capped (-MaxItemsListed).
      S-35  -FilterOn applies to FILES only; with -FolderIncluded 'yes' folders are chosen
            by age alone, whatever their name (the original filtered folder names too, so
            a narrow filter silently kept every folder). Folders are deleted only when
            -FilterOn is '*' or '*.*' AND -ForceEnable is 'yes'; otherwise folder deletion
            is DECLINED (WARN + foldersDeclined) and matching files are still cleaned.
            -FolderIncluded now defaults to 'no' (Orchestrator always passes it).

    TIMEOUTS
    The whole run is ONE synchronous PowerShell invocation. Deleting a large cache over SMB
    is slow - per item, not per byte. The PowerShell host's WinRM MaxTimeoutms and the
    Orchestrator PowerShell plug-in timeout must both exceed the longest expected run.
    Always do a report-only run against a new group first; its duration is a lower bound.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ComputerNames,

    [Parameter(Mandatory = $true)]
    [string]$FolderTarget,

    [ValidateRange(0, 36500)]
    [int]$OlderThanDays = 1,

    [string]$FilterOn = '*.*',

    [ValidateSet('yes', 'no')]
    [string]$FolderIncluded = 'no',

    [ValidateSet('yes', 'no')]
    [string]$ForceEnable = 'no',

    [ValidateSet('yes', 'no')]
    [string]$ReportOnly = 'yes',

    [ValidateRange(0, 1000)]
    [int]$MaxItemsListed = 25
)

# Every cmdlet error is terminating unless a call says otherwise. Each place that must
# carry on after a failure has its own try/catch or an explicit -ErrorAction.
$ErrorActionPreference = 'Stop'

# The one name the original script always protected. Compared CASE-SENSITIVELY (-cne), as
# the original did: only this exact casing is protected.
$ProtectedFileName = 'vmware-vmsvc-SYSTEM.log'

# Every ERROR line is also kept here, so the final PSO_RESULT line can report a count and
# the first few messages.
$script:ErrorMessages = New-Object System.Collections.ArrayList


# ==============================================================================
# Logging and the result line
# ==============================================================================

function Write-Log {
    <#
        One timestamped line on the host stream. Write-Host is used deliberately: the
        caller merges every stream (*>&1) and the plug-in returns it as the transcript,
        and Write-Host cannot be swallowed by a function's return value by accident.
    #>
    param(
        [string]$Message,

        [ValidateSet('INFO', 'WARN', 'ERROR')]
        [string]$Level = 'INFO'
    )
    if ($Level -eq 'ERROR') { [void]$script:ErrorMessages.Add($Message) }
    Write-Host ('{0}  {1,-5}  {2}' -f (Get-Date).ToString('HH:mm:ss'), $Level, $Message)
}

function Write-Result {
    <#
        Prints the single PSO_RESULT line Orchestrator reads. Always called exactly once,
        on every path that reaches the end of the script - including "nothing to do" - so
        its absence reliably means the script did not complete.
    #>
    param([hashtable]$Data)

    $shortErrors = @($script:ErrorMessages | Select-Object -First 10 | ForEach-Object {
        if ($_.Length -gt 160) { $_.Substring(0, 157) + '...' } else { $_ }
    })
    $Data['errorCount'] = $script:ErrorMessages.Count
    $Data['errors']     = $shortErrors
    Write-Host ('PSO_RESULT=' + ($Data | ConvertTo-Json -Compress -Depth 5))
}

function Format-Bytes {
    <# 1536 -> '1.5 KB'. For log lines only; the result line carries raw numbers. #>
    param([double]$Bytes)
    if ($Bytes -ge 1TB) { return ('{0:N2} TB' -f ($Bytes / 1TB)) }
    if ($Bytes -ge 1GB) { return ('{0:N2} GB' -f ($Bytes / 1GB)) }
    if ($Bytes -ge 1MB) { return ('{0:N1} MB' -f ($Bytes / 1MB)) }
    if ($Bytes -ge 1KB) { return ('{0:N1} KB' -f ($Bytes / 1KB)) }
    return ('{0:N0} bytes' -f $Bytes)
}


# ==============================================================================
# Folder targets
# ==============================================================================

function Test-FolderTarget {
    <#
        Returns $null when the path is an acceptable folder target, or a sentence saying
        why it is not.

        This is a guard against catastrophe, not a policy engine (S-36). It refuses:
          - a drive root;
          - any folder that IS, or is INSIDE, a protected operating-system tree
            ($ProtectedTrees) -- deleting inside System32, Program Files or ProgramData
            can leave a server unbootable or break installed software -- EXCEPT
          - the known-safe cache folders in $AllowedInsideProtected, and anything inside
            them (the SCCM cache, Windows temp, the Windows Update download cache).
        c:\users is deliberately NOT refused - two production templates clean it.

        To allow another folder inside a protected tree, add it to $AllowedInsideProtected
        here AND to the same list in the workflow's 'Create Script Parameters' task, which
        applies identical rules before the host is ever contacted.
    #>
    param([string]$Path)

    $ProtectedTrees = @(
        '\Windows', '\Program Files', '\Program Files (x86)', '\ProgramData',
        '\Boot', '\Recovery', '\System Volume Information'
    )
    $AllowedInsideProtected = @(
        '\Windows\ccmcache', '\Windows\Temp', '\Windows\SoftwareDistribution\Download'
    )

    if ($Path -notmatch '^[A-Za-z]:\\') {
        return "must be an absolute local path with a drive letter, as seen on the server (e.g. c:\Windows\ccmcache)"
    }
    if ($Path -match '[*?"<>|]') {
        return "contains a wildcard or a character that is not valid in a path"
    }
    if ($Path -match '(^|\\)\.\.(\\|$)') {
        return "contains '..'"
    }

    # Compare without the drive letter and without a trailing backslash.
    $rest = ($Path.Substring(2)).TrimEnd('\')
    if ($rest -eq '') {
        return "is the root of a drive"
    }

    # "Is, or is inside": equal to the entry, or starting with the entry plus '\'. The '\'
    # matters -- '\Windows' must not also catch a sibling such as '\WindowsApps-Old'.
    function Test-IsOrInside([string]$Candidate, [string]$Tree) {
        return ($Candidate -ieq $Tree) -or $Candidate.StartsWith($Tree + '\', [System.StringComparison]::OrdinalIgnoreCase)
    }

    foreach ($ok in $AllowedInsideProtected) {
        if (Test-IsOrInside $rest $ok) { return $null }
    }
    foreach ($tree in $ProtectedTrees) {
        if (Test-IsOrInside $rest $tree) {
            $drive = $Path.Substring(0, 2)
            return ("is inside the protected operating-system folder $drive$tree. The only folders allowed there are " +
                    (($AllowedInsideProtected | ForEach-Object { "$drive$_" }) -join ', ') + " (and anything inside them)")
        }
    }
    return $null
}

function ConvertTo-AdminSharePath {
    <#
        c:\Windows\ccmcache on SRV01  ->  \\SRV01\c$\Windows\ccmcache
        This is the only way the script reaches a target: one PowerShell host, every server
        through its administrative share - exactly as the original script did.
    #>
    param([string]$Server, [string]$LocalPath)

    $drive = $LocalPath.Substring(0, 1).ToLower()
    return ('\\{0}\{1}${2}' -f $Server, $drive, $LocalPath.Substring(2))
}

function Test-ShareAccess {
    <#
        Returns $null if the share root can be LISTED by the account this script runs as,
        or the reason it cannot, as a sentence.

        Listing (not just resolving) is the real test: it is the first thing the clean does,
        and it exercises the SMB session, the share and the account's rights in one step.

        When the reason is "access denied" but the same account can browse the share in an
        interactive logon on this host, the cause is almost always the SECOND HOP: a remote
        (WinRM) session has no credential to pass on to the target unless Kerberos
        delegation or CredSSP is configured for the PowerShell host. The message says so,
        because that is the one case where "it works when I log on" is true and irrelevant.
    #>
    param([string]$Share)

    try {
        $entries = [System.IO.Directory]::EnumerateFileSystemEntries($Share).GetEnumerator()
        $null = $entries.MoveNext()
        return $null
    }
    catch {
        # PowerShell wraps .NET exceptions in a MethodInvocationException; the useful text
        # is on the inner one.
        $ex = $_.Exception
        while ($ex.InnerException) { $ex = $ex.InnerException }
        $reason = $ex.Message.Trim()
        if ($ex -is [System.UnauthorizedAccessException] -or $reason -match 'denied|logon failure|user name or password') {
            $reason += " (If this account can browse the share when logged on to the PowerShell host interactively, the remote session cannot pass its credential on -- the 'second hop'. Check Kerberos delegation / CredSSP for the PowerShell host; see Script-Staging-Design.md section 6.3.)"
        }
        return $reason
    }
}

function Get-ShareFreeSpace {
    <#
        Free bytes on a server's drive, read through its admin share (\\SRV01\c$), or $null
        if it cannot be read. Scripting.FileSystemObject accepts a UNC share where
        System.IO.DriveInfo does not, and it needs nothing but the SMB access the clean
        itself uses - no WMI, no RPC, no extra firewall rule.

        Used only for the before/after figure in the report. A failure here is never an
        error: the clean does not depend on it.
    #>
    param([string]$Share)

    try {
        $fso = New-Object -ComObject Scripting.FileSystemObject
        return [double]$fso.GetDrive($Share).FreeSpace
    }
    catch {
        return $null
    }
}


# ==============================================================================
# The clean itself - one folder target on one server
# ==============================================================================

function Invoke-TargetClean {
    <#
        Applies the selection rules (see .DESCRIPTION) to one folder on one server and
        either lists or removes the candidates.

        Returns a hashtable: Present, Matched, Removed, Failed, Bytes, Errors.

        Never throws for a per-item problem. It throws only when the target folder exists
        but cannot be opened at all, which the caller records against the server.
    #>
    param(
        [string]$Server,
        [string]$LocalPath,
        [string]$UncPath,
        [datetime]$Cutoff,
        [bool]$DeleteForReal
    )

    $outcome = @{ Present = $true; Matched = 0; Removed = 0; Failed = 0; Bytes = [double]0; Errors = 0 }
    $ctx = "$Server : $LocalPath"

    # ---- Does the target exist? -------------------------------------------------
    # Absent is not a failure: a server without an SCCM client has no ccmcache, and there
    # is nothing to clean. The caller escalates it only if the target is absent EVERYWHERE.
    if (-not (Test-Path -LiteralPath $UncPath -PathType Container)) {
        $outcome.Present = $false
        Write-Log "$ctx : folder not present on this server - nothing to clean" 'WARN'
        return $outcome
    }

    # ---- Enumerate ---------------------------------------------------------------
    # The target root must be readable; if it is not, nothing under it can be cleaned and
    # the caller logs that as the server's error. Below the root, an unreadable sub-folder
    # is collected in $enumErrors and logged, and everything else is still processed
    # (S-33) - previously one such folder abandoned the whole target.
    $null = Get-Item -LiteralPath $UncPath -ErrorAction Stop

    # FILES are matched by -FilterOn. FOLDERS (only with -FolderIncluded 'yes') are matched
    # by age alone, whatever their name (S-35) -- they are enumerated separately, with no
    # filter, so a folder called '2b54ffb5.1' is found even though it matches no file filter.
    # Folders come first so a folder is removed before its contents are visited one by one;
    # contents already removed with their folder are skipped by the Test-Path check below.
    $enumErrors = @()
    $dirErrors  = @()
    $folders = @()
    if ($FolderIncluded -eq 'yes') {
        $folders = @(Get-ChildItem -LiteralPath $UncPath -Recurse -Directory `
                        -ErrorAction SilentlyContinue -ErrorVariable dirErrors |
            Where-Object { $_.LastWriteTime -lt $Cutoff })
    }
    $files = @(Get-ChildItem -LiteralPath $UncPath -Recurse -File -Filter $FilterOn `
                  -ErrorAction SilentlyContinue -ErrorVariable enumErrors |
        Where-Object { $_.LastWriteTime -lt $Cutoff -and $_.Name -cne $ProtectedFileName })
    $candidates = @($folders) + @($files)

    # One unreadable sub-folder is reported by both enumerations; count it once.
    $seenErr = @{}
    $enumErrors = @(@($dirErrors) + @($enumErrors) | Where-Object {
        $k = [string]$_.TargetObject + '|' + $_.Exception.Message
        if ($seenErr.ContainsKey($k)) { $false } else { $seenErr[$k] = $true; $true }
    })

    $listed = 0
    foreach ($err in $enumErrors) {
        $outcome.Errors++
        if ($listed -lt $MaxItemsListed) {
            Write-Log "$ctx : could not read part of the folder, so it was not cleaned - $($err.Exception.Message)" 'ERROR'
            $listed++
        }
        else {
            [void]$script:ErrorMessages.Add("$ctx : could not read part of the folder")
        }
    }
    if ($enumErrors.Count -gt $listed) {
        Write-Log "$ctx : ...and $($enumErrors.Count - $listed) more unreadable location(s)" 'WARN'
    }

    $outcome.Matched = $candidates.Count

    if ($candidates.Count -eq 0) {
        Write-Log "$ctx : nothing older than the cutoff"
        return $outcome
    }

    # ---- Report only ---------------------------------------------------------------
    if (-not $DeleteForReal) {
        # Estimate the size of what would go. A candidate FOLDER goes with everything in
        # it (Remove-Item -Recurse), so its size is measured including hidden content, and
        # candidates inside an already-measured folder are skipped so nothing is counted
        # twice.
        $counted = New-Object System.Collections.ArrayList
        foreach ($c in $candidates) {
            $inside = $false
            foreach ($prefix in $counted) {
                if ($c.FullName.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { $inside = $true; break }
            }
            if ($inside) { continue }

            if ($c.PSIsContainer) {
                $size = (Get-ChildItem -LiteralPath $c.FullName -Recurse -File -Force -ErrorAction SilentlyContinue |
                    Measure-Object -Property Length -Sum).Sum
                $outcome.Bytes += [double]$size
                [void]$counted.Add($c.FullName.TrimEnd('\') + '\')
            }
            else {
                $outcome.Bytes += [double]$c.Length
            }
        }

        Write-Log "$ctx : REPORT ONLY - $($candidates.Count) item(s), about $(Format-Bytes $outcome.Bytes), would be deleted. Nothing was deleted."
        $n = 0
        foreach ($c in $candidates) {
            if ($n -ge $MaxItemsListed) { break }
            Write-Log "$ctx :   would delete $($c.FullName)  (last written $($c.LastWriteTime.ToString('yyyy-MM-dd HH:mm')))"
            $n++
        }
        if ($candidates.Count -gt $n) {
            Write-Log "$ctx :   ...and $($candidates.Count - $n) more"
        }
        return $outcome
    }

    # ---- Delete ----------------------------------------------------------------------
    Write-Log "$ctx : deleting $($candidates.Count) item(s)"
    $useForce = ($ForceEnable -eq 'yes')
    $listedFailures = 0

    foreach ($c in $candidates) {
        # Already gone: a child of a folder removed earlier in this loop. Neither a removal
        # nor a failure - it was counted with its parent.
        if (-not (Test-Path -LiteralPath $c.FullName)) { continue }

        # Measure BEFORE removing; afterwards there is nothing to measure.
        if ($c.PSIsContainer) {
            $size = [double](Get-ChildItem -LiteralPath $c.FullName -Recurse -File -Force -ErrorAction SilentlyContinue |
                Measure-Object -Property Length -Sum).Sum
        }
        else {
            $size = [double]$c.Length
        }

        try {
            if ($useForce) {
                Remove-Item -LiteralPath $c.FullName -Recurse -Force -Confirm:$false -ErrorAction Stop
            }
            else {
                Remove-Item -LiteralPath $c.FullName -Recurse -Confirm:$false -ErrorAction Stop
            }
            $outcome.Removed++
            $outcome.Bytes += $size
        }
        catch {
            if (Test-Path -LiteralPath $c.FullName) {
                # Still there: a genuine failure (read-only without -Force, in use, access
                # denied). If it is a folder, whatever inside it could be removed was, and
                # its remaining children are tried individually further down the list.
                $outcome.Failed++
                $outcome.Errors++
                if ($listedFailures -lt $MaxItemsListed) {
                    Write-Log "$ctx : could not delete $($c.FullName) - $($_.Exception.Message)" 'ERROR'
                    $listedFailures++
                }
                else {
                    [void]$script:ErrorMessages.Add("$ctx : could not delete $($c.FullName)")
                }
            }
            else {
                # Gone despite the error (a race with something else deleting it). Count it.
                $outcome.Removed++
                $outcome.Bytes += $size
            }
        }
    }
    if ($outcome.Failed -gt $listedFailures) {
        Write-Log "$ctx : ...and $($outcome.Failed - $listedFailures) more item(s) could not be deleted" 'WARN'
    }

    Write-Log "$ctx : deleted $($outcome.Removed) item(s), $(Format-Bytes $outcome.Bytes); $($outcome.Failed) could not be deleted"
    return $outcome
}


# ==============================================================================
# Main
# ==============================================================================

$isReportOnly = ($ReportOnly -ne 'no')
$cutoff       = (Get-Date).AddDays(-$OlderThanDays)

$servers = @($ComputerNames -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
$targets = @($FolderTarget  -split '\|' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })

# Everything the result line reports, so every exit path below can emit it.
$summary = @{
    serversRequested   = $servers.Count
    serversReachable   = 0
    serversUnreachable = 0
    serversWithErrors  = 0
    itemsMatched       = 0
    itemsRemoved       = 0
    itemsFailed        = 0
    bytes              = [double]0
    reportOnly         = $isReportOnly
    olderThanDays      = $OlderThanDays
    cutoff             = $cutoff.ToString('yyyy-MM-dd HH:mm:ss')
    targets            = $targets
    foldersDeclined    = ''
    servers            = @()
}

# ---- Refuse bad requests before touching anything --------------------------------
if ($servers.Count -eq 0) {
    Write-Log 'No server names were supplied. Nothing was done.' 'ERROR'
    Write-Result $summary
    return
}
if ($targets.Count -eq 0) {
    Write-Log 'No folder targets were supplied. Nothing was done.' 'ERROR'
    Write-Result $summary
    return
}

$badTargets = 0
foreach ($t in $targets) {
    $why = Test-FolderTarget -Path $t
    if ($null -ne $why) {
        Write-Log "Folder target '$t' $why. Nothing was done on any server." 'ERROR'
        $badTargets++
    }
}
if ($badTargets -gt 0) {
    Write-Result $summary
    return
}

if ([string]::IsNullOrWhiteSpace($FilterOn)) {
    Write-Log "FilterOn is empty. Give a file-name filter, e.g. '*.*' for every file or '*.tmp'. Nothing was done on any server." 'ERROR'
    Write-Result $summary
    return
}

# Deleting folders deletes EVERYTHING in them, so it happens only when the request says so
# in full: a filter that matches every file AND permission to delete read-only items. With
# anything less, FOLDER DELETION IS DECLINED -- no folder is touched -- and the rest of the
# request still runs: files matching the filter are cleaned as if FolderIncluded were 'no'.
# The guard only ever narrows what is deleted; it never widens it (S-35).
$matchesAllFiles = @('*', '*.*') -contains $FilterOn.Trim()
if ($FolderIncluded -eq 'yes' -and (-not $matchesAllFiles -or $ForceEnable -ne 'yes')) {
    $why = @()
    if (-not $matchesAllFiles)  { $why += "the file filter '$FilterOn' does not match every file (it must be '*' or '*.*')" }
    if ($ForceEnable -ne 'yes') { $why += "'delete read-only items' is not enabled" }
    $summary.foldersDeclined = "Folder deletion was requested but NOT performed: " + ($why -join ', and ') +
        ". Deleting a folder deletes everything in it, so it needs both. Files matching '$FilterOn' are still processed; every folder is left in place."
    Write-Log $summary.foldersDeclined 'WARN'
    $FolderIncluded = 'no'
}

Write-Log '==============================================='
Write-Log "Servers           : $($servers.Count)"
Write-Log "Folder targets    : $($targets -join ' | ')"
Write-Log "Older than        : $OlderThanDays day(s) - cutoff $($summary.cutoff)"
Write-Log "File filter       : $FilterOn  (files only; folders are chosen by age)"
Write-Log "Folders deleted   : $FolderIncluded$(if ($summary.foldersDeclined) { '  (requested, but DECLINED - see the warning above)' })"
Write-Log "Force (read-only) : $ForceEnable"
Write-Log "Mode              : $(if ($isReportOnly) { 'REPORT ONLY - nothing will be deleted' } else { 'DELETE' })"
Write-Log '==============================================='

# Track, per target, how many reachable servers actually had it - a target present on none
# of them is almost certainly a typo, and must not pass as "nothing to clean".
$presentCount = @{}
foreach ($t in $targets) { $presentCount[$t] = 0 }

# The drive shares whose free space is measured: one per distinct drive letter in the targets.
$driveLetters = @($targets | ForEach-Object { $_.Substring(0, 1).ToLower() } | Sort-Object -Unique)

foreach ($server in $servers) {
    $record = [ordered]@{
        name       = $server.ToUpper()
        status     = ''
        matched    = 0
        removed    = 0
        failed     = 0
        bytes      = [double]0
        freeBefore = $null
        freeAfter  = $null
        detail     = ''
    }

    # Each server is isolated: nothing that goes wrong on one can stop the next.
    try {
        # ---- Reachability: can the admin share be opened? ------------------------
        # Checked by LISTING the share root through .NET, which proves the account can
        # actually read it and, when it cannot, says WHY in words a person can act on:
        #     "The network path was not found."      name / DNS / SMB 445 / host down
        #     "The network name cannot be found."    the admin share itself is missing
        #     "Access to the path ... is denied."    rights, or the second hop (below)
        #
        # NOT Get-Item: in Windows PowerShell 5.1, Get-Item on a share ROOT with a trailing
        # '\' (\\srv\c$\) fails with "Could not find item" even when the share is fully
        # accessible -- which reported every server as unreachable. Test-Path would give
        # only True/False, with no reason.
        $firstShare = '\\{0}\{1}$\' -f $server, $driveLetters[0]
        $shareError = Test-ShareAccess -Share $firstShare
        if ($null -ne $shareError) {
            $record.status = 'Unreachable'
            $record.detail = "Admin share $firstShare could not be opened: $shareError"
            Write-Log "$server : UNREACHABLE - $($record.detail)" 'ERROR'
            $summary.serversUnreachable++
            $summary.servers += [pscustomobject]$record
            continue
        }
        $summary.serversReachable++

        # ---- Free space before -----------------------------------------------------
        $before = [double]0; $beforeOk = $true
        foreach ($d in $driveLetters) {
            $free = Get-ShareFreeSpace -Share ('\\{0}\{1}$' -f $server, $d)
            if ($null -eq $free) { $beforeOk = $false } else { $before += $free }
        }
        if ($beforeOk) { $record.freeBefore = $before }

        # ---- Clean each target -------------------------------------------------------
        $serverErrors = 0
        $notes = @()
        foreach ($t in $targets) {
            $unc = ConvertTo-AdminSharePath -Server $server -LocalPath $t
            try {
                $r = Invoke-TargetClean -Server $server -LocalPath $t -UncPath $unc -Cutoff $cutoff -DeleteForReal (-not $isReportOnly)
                if ($r.Present) { $presentCount[$t]++ } else { $notes += "$t not present" }
                $record.matched += $r.Matched
                $record.removed += $r.Removed
                $record.failed  += $r.Failed
                $record.bytes   += $r.Bytes
                $serverErrors   += $r.Errors
            }
            catch {
                # The target exists but could not be opened at all.
                $presentCount[$t]++
                $serverErrors++
                $notes += "$t could not be opened"
                Write-Log "$server : $t : the folder could not be opened, so nothing in it was cleaned - $($_.Exception.Message)" 'ERROR'
            }
        }

        # ---- Free space after --------------------------------------------------------
        $after = [double]0; $afterOk = $true
        foreach ($d in $driveLetters) {
            $free = Get-ShareFreeSpace -Share ('\\{0}\{1}$' -f $server, $d)
            if ($null -eq $free) { $afterOk = $false } else { $after += $free }
        }
        if ($afterOk) { $record.freeAfter = $after }

        # ---- Status for this server ----------------------------------------------------
        if ($isReportOnly) {
            $record.status = 'ReportOnly'
            $record.detail = "$($record.matched) item(s), about $(Format-Bytes $record.bytes), would be deleted"
        }
        elseif ($serverErrors -gt 0) {
            $record.status = 'CleanedWithErrors'
            $record.detail = "$($record.removed) deleted ($(Format-Bytes $record.bytes)); $($record.failed) could not be deleted"
        }
        else {
            $record.status = 'Cleaned'
            $record.detail = "$($record.removed) deleted ($(Format-Bytes $record.bytes))"
        }
        if ($isReportOnly -and $serverErrors -gt 0) {
            $record.detail += "; $serverErrors location(s) could not be read"
        }
        if ($notes.Count -gt 0) { $record.detail += ' - ' + ($notes -join '; ') }
        if ($serverErrors -gt 0) { $summary.serversWithErrors++ }
    }
    catch {
        # Anything unforeseen. Recorded against this server; the loop carries on.
        $record.status = 'Failed'
        $record.detail = "Unexpected error: $($_.Exception.Message)"
        Write-Log "$server : $($record.detail)" 'ERROR'
        $summary.serversWithErrors++
    }

    $summary.itemsMatched += $record.matched
    $summary.itemsRemoved += $record.removed
    $summary.itemsFailed  += $record.failed
    $summary.bytes        += $record.bytes
    $summary.servers      += [pscustomobject]$record
}

# ---- A target present on no reachable server is a mistake, not "nothing to do" -------
if ($summary.serversReachable -gt 0) {
    foreach ($t in $targets) {
        if ($presentCount[$t] -eq 0) {
            Write-Log "Folder target '$t' did not exist on ANY of the $($summary.serversReachable) reachable server(s). Check the path - nothing was cleaned for it." 'ERROR'
        }
    }
}

# ---- Per-server outcome and totals -----------------------------------------------
Write-Log '--- per-server outcome ---'
foreach ($s in ($summary.servers | Sort-Object -Property status, name)) {
    Write-Log ('  {0,-40} {1,-18} {2}' -f $s.name, $s.status, $s.detail)
}

Write-Log '==============================================='
Write-Log "Servers requested  : $($summary.serversRequested)"
Write-Log "Reachable          : $($summary.serversReachable)"
Write-Log "Unreachable        : $($summary.serversUnreachable)"
if ($isReportOnly) {
    Write-Log "Would delete       : $($summary.itemsMatched) item(s), about $(Format-Bytes $summary.bytes)  (REPORT ONLY - nothing was deleted)"
}
else {
    Write-Log "Deleted            : $($summary.itemsRemoved) of $($summary.itemsMatched) item(s), $(Format-Bytes $summary.bytes)"
    Write-Log "Could not delete   : $($summary.itemsFailed)"
}
Write-Log "Servers with errors: $($summary.serversWithErrors)"
Write-Log "Errors             : $($script:ErrorMessages.Count)"

Write-Result $summary
