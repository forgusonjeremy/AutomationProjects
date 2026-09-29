<#
.SYNOPSIS
    Promotes one or more finished projects from InProgress to Completed.

.DESCRIPTION
    The repository follows one rule:

        InProgress   is the working tree. It holds EVERY project -- finished and active --
                     plus the shared code (_Shared) and the programme-level documents
                     (_Programme). All editing happens here.

        Completed    is a snapshot. It holds the finished projects exactly as they were when
                     last promoted, plus the _Shared and _Programme they were finished
                     against. Nobody edits it directly; only this script writes to it.

    For each project named, this script MIRRORS

        InProgress\<Project>     ->  Completed\<Project>
        InProgress\_Shared       ->  Completed\_Shared
        InProgress\_Programme    ->  Completed\_Programme

    "Mirror" means the Completed copy ends up identical to the InProgress one: new and
    changed files are copied, and files that no longer exist in InProgress are DELETED from
    Completed. That is intended -- Completed is a snapshot, not an archive of every file that
    ever existed. The history is in git.

    SAFETY
      - Run with -WhatIf first. It lists every file that would be copied or deleted and
        changes nothing.
      - The script refuses to run if git shows uncommitted changes anywhere under Completed\.
        Such a change means someone edited the snapshot directly, and a mirror would silently
        overwrite it. Move that edit into InProgress (or commit/discard it), then promote.
        -Force overrides the check.
      - Nothing is committed. Review with 'git status' / 'git diff', then commit.

.PARAMETER Project
    One or more project folder names under InProgress, e.g. 'Windows Server Clean Disks'.
    A name that does not exist is refused with the list of project folders.

.PARAMETER SharedOnly
    Refresh only Completed\_Shared and Completed\_Programme (no project), e.g. after a fix to
    a shared action that finished projects already use.

.PARAMETER Force
    Promote even though git reports uncommitted changes under Completed\.

.EXAMPLE
    .\Promote-Project.ps1 -Project 'Windows Server Clean Disks' -WhatIf
    .\Promote-Project.ps1 -Project 'Windows Server Clean Disks'

.EXAMPLE
    .\Promote-Project.ps1 -SharedOnly
#>
[CmdletBinding(SupportsShouldProcess = $true, DefaultParameterSetName = 'Project')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Project', Position = 0)]
    [string[]]$Project,

    [Parameter(Mandatory = $true, ParameterSetName = 'SharedOnly')]
    [switch]$SharedOnly,

    [switch]$Force
)

$ErrorActionPreference = 'Stop'

# This script lives in InProgress\_Shared\Tools.
$inProgress = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$root       = Split-Path -Parent $inProgress
$completed  = Join-Path $root 'Completed'

if ((Split-Path -Leaf $inProgress) -ne 'InProgress' -or -not (Test-Path -LiteralPath $completed)) {
    throw "Promote-Project.ps1 must run from InProgress\_Shared\Tools (resolved InProgress to '$inProgress')."
}

# ---- What to mirror ---------------------------------------------------------------
$pairs = New-Object System.Collections.ArrayList
if ($PSCmdlet.ParameterSetName -eq 'Project') {
    foreach ($p in $Project) {
        if ($p -like '_*') { throw "'$p' is not a project. _Shared and _Programme are always promoted; use -SharedOnly to refresh just those." }
        $src = Join-Path $inProgress $p
        if (-not (Test-Path -LiteralPath $src -PathType Container)) {
            $known = (Get-ChildItem -LiteralPath $inProgress -Directory | Where-Object { $_.Name -notlike '_*' } | ForEach-Object Name) -join "', '"
            throw "No project folder '$p' under InProgress. Projects: '$known'."
        }
        [void]$pairs.Add(@{ Name = $p; Source = $src; Target = (Join-Path $completed $p) })
    }
}
foreach ($s in '_Shared', '_Programme') {
    $src = Join-Path $inProgress $s
    if (Test-Path -LiteralPath $src -PathType Container) {
        [void]$pairs.Add(@{ Name = $s; Source = $src; Target = (Join-Path $completed $s) })
    }
}

# ---- Refuse to overwrite direct edits to the snapshot ------------------------------------
$git = Get-Command git -ErrorAction SilentlyContinue
if ($git) {
    $dirty = @(& git -C $root status --porcelain -- 'Completed' 2>$null)
    if ($dirty.Count -gt 0 -and -not $Force -and -not $WhatIfPreference) {
        throw ("git reports uncommitted changes under Completed\ -- someone may have edited the snapshot directly, " +
               "and promoting would overwrite them:`n  " + ($dirty -join "`n  ") +
               "`nMove the change into InProgress, or commit/discard it, then promote. -Force overrides.")
    }
    if ($dirty.Count -gt 0) {
        Write-Warning "Uncommitted changes under Completed\ ($($dirty.Count)) will be overwritten by the mirror."
    }
}
else {
    Write-Warning 'git not found; the uncommitted-changes check was skipped.'
}

# ---- Mirror ---------------------------------------------------------------------------------
foreach ($pair in $pairs) {
    $action = "Mirror to $($pair.Target)"
    if ($WhatIfPreference) {
        Write-Host "WHAT IF: $($pair.Name) -> Completed\$($pair.Name)" -ForegroundColor Cyan
        # /L = list only. Prints each file that would be copied, and '*EXTRA File' for each that would be deleted.
        robocopy $pair.Source $pair.Target /MIR /L /NJH /NJS /NDL /NP /FP /XJ
        if ($LASTEXITCODE -ge 8) { throw "robocopy preview failed for $($pair.Name) (exit $LASTEXITCODE)." }
        continue
    }
    if ($PSCmdlet.ShouldProcess($pair.Source, $action)) {
        robocopy $pair.Source $pair.Target /MIR /NJH /NJS /NDL /NP /FP /XJ | Out-Null
        # robocopy: 0-7 success (bit flags for copied/extra/mismatched), 8+ failure.
        if ($LASTEXITCODE -ge 8) { throw "robocopy failed for $($pair.Name) (exit $LASTEXITCODE)." }
        $a = @(Get-ChildItem -LiteralPath $pair.Source -Recurse -File).Count
        $b = @(Get-ChildItem -LiteralPath $pair.Target -Recurse -File).Count
        if ($a -ne $b) { throw "After mirroring $($pair.Name), InProgress has $a files and Completed has $b." }
        Write-Host ("Promoted {0,-38} {1,4} files" -f $pair.Name, $b) -ForegroundColor Green
    }
}

if (-not $WhatIfPreference) {
    Write-Host ''
    Write-Host 'Done. Nothing has been committed. Review with:  git status -- Completed' -ForegroundColor Yellow
}

# robocopy's 1-7 "success with changes" codes would otherwise leak out as this script's exit
# code and look like a failure to a caller or CI job.
$global:LASTEXITCODE = 0
