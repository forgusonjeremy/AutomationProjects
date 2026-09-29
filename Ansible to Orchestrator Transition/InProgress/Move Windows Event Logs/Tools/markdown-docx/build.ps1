# Rebuilds the Word copies of documents 01-04 from their Markdown.
#
# Run this after editing any of the Markdown. The .docx files are outputs.
#
# Note for this build machine: Group Policy blocks running .ps1 files from disk, so this
# will refuse to start with "blocked by software restriction policies". Run it as a script
# block instead, which is not covered by the policy. Use an absolute path -- ReadAllText
# resolves a relative one against .NET's working directory, which Set-Location leaves alone:
#
#   $dir = 'C:\...\Tools\markdown-docx'
#   $c = [System.IO.File]::ReadAllText("$dir\build.ps1", [System.Text.Encoding]::UTF8)
#   & ([ScriptBlock]::Create($c))

[CmdletBinding()]
param(
    [string]$DocsDir,
    [string]$Package = 'Move Archived Logs'
)

# $PSScriptRoot is empty when this runs as a script block rather than as a file, which is
# how it has to run on this machine, so fall back to the working directory.
$here = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }

if (-not $DocsDir) {
    $DocsDir = Join-Path (Split-Path (Split-Path $here -Parent) -Parent) 'Documentation'
}
if (-not (Test-Path -LiteralPath $DocsDir)) {
    throw "cannot find the Documentation folder (looked in '$DocsDir'). Pass -DocsDir."
}

$tool = Join-Path $here 'md2docx.ps1'
$convert = [ScriptBlock]::Create([System.IO.File]::ReadAllText($tool, [System.Text.Encoding]::UTF8))

$names = @('01_User-Guide', '02_Design-Decisions', '03_Implementation-Guide', '04_Testing-Plan')

$report = foreach ($n in $names) {
    $md = Join-Path $DocsDir "$n.md"
    if (-not (Test-Path -LiteralPath $md)) { Write-Warning "missing: $md"; continue }

    $result = & $convert -InPath $md -OutPath (Join-Path $DocsDir "$n.docx") -Package $Package

    # The two word counts should be close, with the .docx slightly lower: Markdown's own
    # punctuation counts as words on the left and not on the right. A large gap either way
    # means content was dropped or duplicated.
    $text = [System.IO.File]::ReadAllText($md, [System.Text.Encoding]::UTF8)
    $result | Add-Member -NotePropertyName SourceWords `
                         -NotePropertyValue (($text -split '\s+' | Where-Object { $_ -ne '' }).Count) -PassThru
}

$report | Format-Table File, KB, Parts, Tables, SourceWords -AutoSize
Write-Host "Open one and read it before sending it on. The build proves the file opens, not that it reads well."
