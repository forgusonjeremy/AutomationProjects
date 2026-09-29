<#
.SYNOPSIS
    Produces a comment-stripped copy of a .ps1 for import as an Orchestrator
    Resource Element, and proves it is the same program.

.DESCRIPTION
    WHY THIS EXISTS

    The shared runPowerShellScript action does not copy a file to the PowerShell
    host -- it embeds the entire script text inside the command it sends over
    WinRM. Startup time is therefore linear in script size. Measured against
    pshost.vcf.lab on VCF Automation 9.1.1:

        payload      time before the script's first line runs
        -----------  ----------------------------------------
             ~0        6s   (OOTB "Invoke a PowerShell script")
         11,290 ch    25s   (Move-ArchivedLogs.ps1)
         20,195 ch    38s   (Invoke-ServerReboot.ps1, stripped)
         39,261 ch    73s   (Invoke-ServerReboot.ps1, as written)

    That is roughly 5s fixed plus 1.7s per KB. The cost is paid once per run and
    does NOT scale with the number of servers, so a 50-server reboot pays the same
    73 seconds as a 2-server one.

    Roughly half of these scripts is comments -- deliberately, because the "why"
    behind several of the behaviours is not recoverable from the code. Those
    comments are worth keeping in the repository and worth nothing on the wire.
    So: the commented file stays the source of truth, and this produces the copy
    that actually gets imported.

    WHAT IT GUARANTEES

    Stripping is done with PowerShell's own tokenizer, against comment token
    extents -- not with regular expressions. A '#' inside a string, a here-string
    containing '#', and block comments are all handled correctly because the
    tokenizer has already decided what is and is not a comment.

    It then PROVES equivalence rather than assuming it: the output is re-tokenized
    and every non-comment, non-newline token is compared with the source's, by
    kind and by text. Any difference at all fails the build and writes nothing.

    This matters more than usual here. The artifact this produces is what reboots
    production servers, and a silently corrupted one would not be discovered until
    a maintenance window.

.PARAMETER Path
    The commented source .ps1.

.PARAMETER OutputPath
    Where to write the stripped copy. Defaults to <name>.deploy.ps1 beside the
    source.

.PARAMETER PassThru
    Emit an object with the sizes and the predicted startup time.

.EXAMPLE
    .\Build-ResourceElement.ps1 -Path '..\..\..\InProgress\Server Reboots\Code\Invoke-ServerReboot.ps1'

    Writes Invoke-ServerReboot.deploy.ps1. Import THAT as the Resource Element.

.NOTES
    Import the .deploy.ps1 as the Resource Element, but keep its NAME as the
    original: runPowerShellScript uses the element's name as the filename on the
    host, and the transcript is easier to read when it says Invoke-ServerReboot.ps1.

    Re-run this after every change to the source, or you will deploy a stale copy
    -- the failure mode being that a fix you are certain you made does not appear
    to take effect.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Path,

    [Parameter(Mandatory = $false)]
    [string]$OutputPath,

    [Parameter(Mandatory = $false)]
    [switch]$PassThru
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Fail { param([string]$m) Write-Host "  [FAIL] $m" -ForegroundColor Red }
function OK   { param([string]$m) Write-Host "  [OK]   $m" -ForegroundColor Green }
function Info { param([string]$m) Write-Host "         $m" -ForegroundColor DarkGray }

if (-not (Test-Path -LiteralPath $Path)) { throw "Source not found: $Path" }
$src = Resolve-Path -LiteralPath $Path

if (-not $OutputPath) {
    # GetFileNameWithoutExtension rather than Split-Path -LeafBase: the latter is
    # PowerShell 6+, and this has to run on the Windows PowerShell 5.1 that ships
    # with the servers this project targets.
    $OutputPath = Join-Path (Split-Path $src -Parent) `
        ([IO.Path]::GetFileNameWithoutExtension($src) + '.deploy.ps1')
}

Write-Host ""
Write-Host "Building deployable copy of $(Split-Path $src -Leaf)" -ForegroundColor Cyan

# ---------------------------------------------------------------------------
# 1. Tokenize the source
# ---------------------------------------------------------------------------
$raw = Get-Content -Raw -LiteralPath $src
$srcTokens = $null
$srcErrors = $null
$null = [System.Management.Automation.Language.Parser]::ParseInput($raw, [ref]$srcTokens, [ref]$srcErrors)

if ($srcErrors.Count -gt 0) {
    Fail "The SOURCE does not parse. Fix it before building."
    $srcErrors | ForEach-Object { Info "line $($_.Extent.StartLineNumber): $($_.Message)" }
    exit 1
}
OK "Source parses clean ($($raw.Length) chars)"

# ---------------------------------------------------------------------------
# 2. Strip the comments
#
# Back to front, so each removal leaves earlier offsets still valid.
# ---------------------------------------------------------------------------
$comments = @($srcTokens | Where-Object { $_.Kind -eq 'Comment' } |
    Sort-Object { $_.Extent.StartOffset } -Descending)

$out = $raw
foreach ($c in $comments) {
    $out = $out.Remove($c.Extent.StartOffset, $c.Extent.EndOffset - $c.Extent.StartOffset)
}

# Comments leave behind the lines they occupied. Drop lines that are now empty --
# but ONLY whole-line blanks, so nothing inside a here-string is touched: a
# here-string's content is a single token, and its internal newlines are not
# separate lines as far as this split is concerned... which is not true, so the
# equivalence check below is what actually protects us here. If a here-string ever
# contains a blank line, that check will fail the build rather than corrupt it.
$out = ($out -split "`r?`n" | Where-Object { $_.Trim() -ne '' }) -join "`r`n"

$header = @(
    "# =============================================================================="
    "# GENERATED FILE -- DO NOT EDIT."
    "#"
    "# Built from : $(Split-Path $src -Leaf)"
    "# Built on   : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
    "# By         : Build-ResourceElement.ps1"
    "#"
    "# Comments are stripped to cut the WinRM payload -- runPowerShellScript embeds"
    "# the whole script in the command it sends, so startup time is linear in size."
    "# Edit the SOURCE and re-run the build; changes made here are lost and, worse,"
    "# will not match what the repository says is deployed."
    "# =============================================================================="
    ""
) -join "`r`n"

$out = $header + $out

# ---------------------------------------------------------------------------
# 3. Prove it is the same program
#
# Re-tokenize and compare every token that is not a comment or a newline. Same
# kinds, same texts, same order. This is the check that makes stripping safe
# enough to do to something that reboots production.
# ---------------------------------------------------------------------------
$outTokens = $null
$outErrors = $null
$null = [System.Management.Automation.Language.Parser]::ParseInput($out, [ref]$outTokens, [ref]$outErrors)

if ($outErrors.Count -gt 0) {
    Fail "The STRIPPED output does not parse. Nothing was written."
    $outErrors | ForEach-Object { Info "line $($_.Extent.StartLineNumber): $($_.Message)" }
    exit 1
}
OK "Stripped output parses clean"

$meaningful = { param($t) $t.Kind -ne 'Comment' -and $t.Kind -ne 'NewLine' -and $t.Kind -ne 'EndOfInput' }
$a = @($srcTokens | Where-Object { & $meaningful $_ })
$b = @($outTokens | Where-Object { & $meaningful $_ })

if ($a.Count -ne $b.Count) {
    Fail "Token count differs: source $($a.Count), stripped $($b.Count). Nothing was written."
    exit 1
}

for ($i = 0; $i -lt $a.Count; $i++) {
    if ($a[$i].Kind -ne $b[$i].Kind -or $a[$i].Text -ne $b[$i].Text) {
        Fail "Token $i differs. Nothing was written."
        Info "source   : [$($a[$i].Kind)] $($a[$i].Text)"
        Info "stripped : [$($b[$i].Kind)] $($b[$i].Text)"
        exit 1
    }
}
OK "Token-for-token identical to the source ($($a.Count) tokens compared)"

# ---------------------------------------------------------------------------
# 4. The two things runPowerShellScript needs
# ---------------------------------------------------------------------------
if ($out -match '(?m)^\s*''@\s*$') {
    Fail "Output contains a line that is just  '@  -- runPowerShellScript refuses this,"
    Info "because it would truncate the here-string the script is sent inside."
    exit 1
}
OK "No bare '@ line (runPowerShellScript's here-string guard)"

if ($out -notmatch 'PSO_RESULT=') {
    Fail "Output does not emit a PSO_RESULT line. runPowerShellScript would treat every"
    Info "run as 'did not run to completion'. Nothing was written."
    exit 1
}
OK "PSO_RESULT emission intact"

# ---------------------------------------------------------------------------
# 5. Write it
# ---------------------------------------------------------------------------
# UTF8 without BOM. runPowerShellScript strips a leading U+FEFF defensively, but
# there is no reason to make it work for it.
[IO.File]::WriteAllText($OutputPath, $out, (New-Object Text.UTF8Encoding($false)))

$saved   = $raw.Length - $out.Length
$pct     = [math]::Round(($saved / $raw.Length) * 100)
$before  = [math]::Round(5 + ($raw.Length / 1KB) * 1.7)
$after   = [math]::Round(5 + ($out.Length / 1KB) * 1.7)

Write-Host ""
Write-Host "  source   : $($raw.Length) chars  ->  ~${before}s startup" -ForegroundColor Gray
Write-Host "  deployed : $($out.Length) chars  ->  ~${after}s startup   ($pct% smaller)" -ForegroundColor Green
Write-Host ""
Write-Host "  Written: $OutputPath" -ForegroundColor Cyan
Write-Host "  Import THIS as the Resource Element, named $(Split-Path $src -Leaf)" -ForegroundColor Cyan
Write-Host ""

if ($PassThru) {
    [PSCustomObject]@{
        Source           = $src.Path
        Output           = $OutputPath
        SourceChars      = $raw.Length
        DeployedChars    = $out.Length
        PercentSmaller   = $pct
        PredictedStartSec = $after
    }
}
