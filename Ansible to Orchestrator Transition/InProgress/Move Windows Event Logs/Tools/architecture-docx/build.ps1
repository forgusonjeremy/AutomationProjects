# Builds the two architecture .docx files from the content modules alongside this script.
#
# There is no Word, pandoc or LibreOffice on the build machine, so the documents are
# assembled as OOXML directly: Node stages the package parts, and this script zips them
# with [Content_Types].xml first, which the OPC specification requires.
[CmdletBinding()]
param([string]$OutDir = $PSScriptRoot)

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName WindowsBase

$base = $PSScriptRoot

function Build-Docx([string]$stageName, [string]$outFile) {
    $stage = Join-Path $base $stageName
    $order = Get-Content -LiteralPath (Join-Path $base "$stageName.order.txt") -Encoding UTF8 |
             Where-Object { $_ -ne '' }

    # Every part must be well-formed before it goes in; a malformed one produces a file
    # that Word refuses with a message naming no part in particular.
    foreach ($f in (Get-ChildItem -LiteralPath $stage -Recurse -File |
                    Where-Object { $_.Extension -in '.xml', '.rels' })) {
        try { [void][xml](Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8) }
        catch { throw "malformed XML in $stageName : $($f.Name)" }
    }

    $out = Join-Path $OutDir $outFile
    if ([System.IO.File]::Exists($out)) { [System.IO.File]::Delete($out) }

    $fs  = [System.IO.File]::Open($out, [System.IO.FileMode]::CreateNew)
    $zip = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($entry in $order) {
            # PNGs are already compressed; deflating them again only costs time.
            $lvl = [System.IO.Compression.CompressionLevel]::Optimal
            if ($entry.EndsWith('.png')) { $lvl = [System.IO.Compression.CompressionLevel]::NoCompression }
            $e  = $zip.CreateEntry($entry, $lvl)
            $es = $e.Open()
            $b  = [System.IO.File]::ReadAllBytes((Join-Path $stage $entry))
            $es.Write($b, 0, $b.Length)
            $es.Dispose()
        }
    } finally { $zip.Dispose(); $fs.Dispose() }

    # Read it back through the same OPC layer Word uses, as a build-time check.
    $pkg = [System.IO.Packaging.Package]::Open($out, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read)
    $n = ($pkg.GetParts() | Measure-Object).Count
    $pkg.Close()
    Write-Host ("built {0}  ({1:N0} KB, {2} parts, OPC valid)" -f $outFile, ((Get-Item -LiteralPath $out).Length / 1KB), $n)
}

Push-Location $base
try {
    & node build.js move
    & node build.js remove
} finally { Pop-Location }

Build-Docx 'stage-move'   'Move Archived Logs - Solution Architecture.docx'
Build-Docx 'stage-remove' 'Remove Old Archived Logs - Solution Architecture.docx'
