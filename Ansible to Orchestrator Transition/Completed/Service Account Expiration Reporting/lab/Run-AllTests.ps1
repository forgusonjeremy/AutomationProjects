<#
.SYNOPSIS
    Runs the full Service Account Expiration Report regression suite. One command, no setup.

.DESCRIPTION
    Runs all four suites in the required order and prints a single summary.
    Everything external is stubbed - NO Active Directory, SMTP, PowerShell host or
    Orchestrator appliance is needed, so this runs on a laptop.

    Requires: PowerShell 5.1+ (or 7) and Node.js. Node is only used to execute the vRO
    action's JavaScript exactly as written, so the file under test is the file that
    ships - not a translation of it.

.PARAMETER ScriptPath
    Path to the cvs_functions.ps1 under test. Passed through to the PowerShell suites.

.PARAMETER KeepArtifacts
    Keep the generated working files (invocation strings, stub script, rendered report)
    instead of deleting them. Useful when a test fails and you want to look at what was
    actually produced.

.EXAMPLE
    .\Run-AllTests.ps1

.EXAMPLE
    .\Run-AllTests.ps1 -KeepArtifacts
    # then open .\Debug\ServiceAccountExpiration_result.html to see the rendered report
#>
[CmdletBinding()]
param(
    [string] $ScriptPath = "e:\GitHub-LocalRepos\AutomationProjects\Ansible to Orchestrator Transition\InProgress\psscript\files\cvs_functions.ps1",
    [switch] $KeepArtifacts
)

$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot

if (-not (Test-Path -LiteralPath $ScriptPath)) {
    Write-Host "FATAL: script under test not found: $ScriptPath" -ForegroundColor Red
    Write-Host "       Pass -ScriptPath if it has been promoted to Completed\_Shared References\." -ForegroundColor Yellow
    exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "FATAL: Node.js is required - it executes the vRO action's JavaScript as written." -ForegroundColor Red
    exit 1
}

$script:results = @()

function Invoke-Suite {
    param([string] $Name, [scriptblock] $Body, [string] $Covers)

    Write-Host ""
    Write-Host ("=" * 72) -ForegroundColor DarkCyan
    Write-Host " $Name" -ForegroundColor Cyan
    Write-Host " $Covers" -ForegroundColor DarkGray
    Write-Host ("=" * 72) -ForegroundColor DarkCyan

    # '*>&1' NOT '2>&1'. The PowerShell suites report through Write-Host, which goes to
    # the INFORMATION stream (6), not to output or error - with '2>&1' their results are
    # written straight to the console and the variable stays empty, so the summary
    # silently scored them 0/0 while they had actually passed.
    $out = & $Body *>&1
    $text = ($out | Out-String)

    # Echo only the verdict lines; the suites are chatty by design.
    $out | Where-Object { $_ -match '^\s*(PASS|FAIL)\s{2}|^T\d|^B\d|^W\d|^\d\.\s|^PASS:' } | ForEach-Object {
        $line = "$_"
        if     ($line -match 'FAIL')     { Write-Host $line -ForegroundColor Red }
        elseif ($line -match '^PASS:')   { Write-Host $line -ForegroundColor White }
        elseif ($line -match '^\s*PASS') { Write-Host $line -ForegroundColor Green }
        else   { Write-Host $line -ForegroundColor DarkGray }
    }

    $p = 0; $f = 0
    if ($text -match 'PASS:\s*(\d+)\s+FAIL:\s*(\d+)') { $p = [int]$Matches[1]; $f = [int]$Matches[2] }
    $script:results += [PSCustomObject]@{ Suite = $Name; Passed = $p; Failed = $f }
}

# Order matters: test-action.js writes invocation.txt and gen-awkward.js writes
# invocation-awkward.txt / invocation-quotes.txt - all three are fixtures that
# Test-Boundary.ps1 EXECUTES.
Invoke-Suite -Name 'vRO action (JavaScript)' `
             -Covers 'buildServiceAccountExpirationInvocation.js - grouping, window validation, JSON encoding' `
             -Body { node .\test-action.js }

Invoke-Suite -Name 'PowerShell functions' `
             -Covers 'cvs_functions.ps1 S-22/S-23 - expiry classification, report structure, action-case guards' `
             -Body { & .\Test-S22.ps1 -ScriptPath $ScriptPath }

Invoke-Suite -Name 'JS -> PowerShell boundary' `
             -Covers 'the escaping chain: JSON -> PowerShell single-quote -> ConvertFrom-Json' `
             -Body { node .\gen-awkward.js | Out-Null; & .\Test-Boundary.ps1 -ScriptPath $ScriptPath }

# The scriptable-task code in the workflow spec is real deployed code, not
# documentation. It is extracted from the spec and executed, so the file that gets
# pasted into vRO is the file under test.
Invoke-Suite -Name 'Workflow scriptable tasks' `
             -Covers 'Get-ServiceAccountExpirationReport_spec.js - (item6) Set Execution Context, ES5 compatibility' `
             -Body { node .\test-workflow-tasks.js }

# ── Summary ──────────────────────────────────────────────────────────────────
$totalPass = ($script:results | Measure-Object -Property Passed -Sum).Sum
$totalFail = ($script:results | Measure-Object -Property Failed -Sum).Sum

Write-Host ""
Write-Host ("=" * 72) -ForegroundColor DarkCyan
Write-Host " SUMMARY" -ForegroundColor Cyan
Write-Host ("=" * 72) -ForegroundColor DarkCyan
$script:results | Format-Table -AutoSize | Out-String | Write-Host

if ($totalFail -eq 0) {
    Write-Host " ALL $totalPass CHECKS PASSED" -ForegroundColor Green
} else {
    Write-Host " $totalFail CHECK(S) FAILED  ($totalPass passed)" -ForegroundColor Red
    Write-Host " Re-run with -KeepArtifacts and inspect .\Debug\ServiceAccountExpiration_result.html" -ForegroundColor Yellow
}

Write-Host ""
Write-Host " NOT covered here (needs the lab, see 05_Validation_and_Testing_Plan):" -ForegroundColor DarkGray
Write-Host "   - the Get-ADUser queries themselves and real AD data" -ForegroundColor DarkGray
Write-Host "   - per-OU failure isolation against a genuinely unreachable DC" -ForegroundColor DarkGray
Write-Host "   - real pwdLastSet / AccountExpirationDate values from a directory" -ForegroundColor DarkGray
Write-Host "   - SMTP delivery and how the report renders in Outlook" -ForegroundColor DarkGray
Write-Host "   - the vRO workflow schema, PS host binding and end-state routing" -ForegroundColor DarkGray
Write-Host ""

if (-not $KeepArtifacts) {
    Remove-Item -Recurse -Force .\Debug, .\invocation.txt, .\invocation-awkward.txt,
                                .\invocation-quotes.txt, .\stub_cvs.ps1 -ErrorAction SilentlyContinue
} else {
    Write-Host " Artifacts kept. Rendered report: .\Debug\ServiceAccountExpiration_result.html" -ForegroundColor DarkGray
    Write-Host " For presentation samples run: .\New-SampleReport.ps1" -ForegroundColor DarkGray
    Write-Host ""
}

exit $(if ($totalFail -gt 0) { 1 } else { 0 })
