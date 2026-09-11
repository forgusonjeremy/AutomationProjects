# Converts the Markdown documentation into Word documents.
#
# The styles here are deliberately the same ones engine.js uses for the architecture
# document, so every file in Documentation/ looks like it belongs to the same set.
# Where this differs is the front end: engine.js renders hand-authored block arrays,
# this reads the Markdown that is already the source of truth for these four documents.
#
# Word is installed on this machine but cannot be used for the conversion: Office policy
# opens HTML read-only, so the usual Markdown -> HTML -> Word route is closed. There is
# no pandoc and no Node either. The document is therefore assembled as OOXML directly.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InPath,
    [Parameter(Mandatory = $true)][string]$OutPath,
    [string]$Package  = 'Move Archived Logs',
    [string]$Platform = 'VCF Operations Orchestrator 9'
)

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName WindowsBase

$NL = [char]10

# ---------------------------------------------------------------------------
# Inline markup
# ---------------------------------------------------------------------------
$CODE_RPR = '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/>' +
            '<w:shd w:val="clear" w:fill="EEF1F4"/>'

function Esc([string]$s) {
    if ($null -eq $s) { return '' }
    $s.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;')
}

# **bold**, *italic* and `code`, nesting by recursion so bold-containing-code keeps both.
# Scanned by hand rather than by regex: the markers overlap (** before *) and a missing
# closing marker has to fall through as literal text instead of throwing.
function Runs([string]$text, [string]$baseRPr = '') {
    $out = New-Object System.Text.StringBuilder
    $buf = New-Object System.Text.StringBuilder
    $s = [string]$text
    $i = 0

    $flush = {
        if ($buf.Length -gt 0) {
            [void]$out.Append('<w:r><w:rPr>' + $baseRPr + '</w:rPr><w:t xml:space="preserve">' +
                              (Esc $buf.ToString()) + '</w:t></w:r>')
            [void]$buf.Clear()
        }
    }

    while ($i -lt $s.Length) {
        $two = if ($i + 1 -lt $s.Length) { $s.Substring($i, 2) } else { '' }

        if ($two -eq '**') {
            $end = $s.IndexOf('**', $i + 2)
            if ($end -gt -1) {
                & $flush
                [void]$out.Append((Runs $s.Substring($i + 2, $end - $i - 2) ($baseRPr + '<w:b/>')))
                $i = $end + 2
                continue
            }
        }

        if ($s[$i] -eq '*') {
            $end = $s.IndexOf('*', $i + 1)
            if ($end -gt -1 -and $end -ne $i + 1) {
                & $flush
                [void]$out.Append((Runs $s.Substring($i + 1, $end - $i - 1) ($baseRPr + '<w:i/>')))
                $i = $end + 1
                continue
            }
        }

        if ($s[$i] -eq '`') {
            $end = $s.IndexOf('`', $i + 1)
            if ($end -gt -1) {
                & $flush
                [void]$out.Append('<w:r><w:rPr>' + $baseRPr + $CODE_RPR + '</w:rPr><w:t xml:space="preserve">' +
                                  (Esc $s.Substring($i + 1, $end - $i - 1)) + '</w:t></w:r>')
                $i = $end + 1
                continue
            }
        }

        [void]$buf.Append($s[$i])
        $i++
    }

    & $flush
    $out.ToString()
}

function Para([string]$text, [string]$style = '', [string]$extraPPr = '') {
    $pPr = ''
    if ($style)    { $pPr += '<w:pStyle w:val="' + $style + '"/>' }
    if ($extraPPr) { $pPr += $extraPPr }
    $wrap = if ($pPr) { '<w:pPr>' + $pPr + '</w:pPr>' } else { '' }
    '<w:p>' + $wrap + (Runs $text) + '</w:p>'
}

function Spacer { '<w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>' }
function PageBreak { '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' }

# ---------------------------------------------------------------------------
# Block renderers -- lifted from engine.js so the two builds match
# ---------------------------------------------------------------------------
function Bullets([string[]]$items, [int]$numId = 1) {
    ($items | ForEach-Object {
        '<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/>' +
        '<w:numId w:val="' + $numId + '"/></w:numPr></w:pPr>' + (Runs $_) + '</w:p>'
    }) -join ''
}

# A checklist is not a bulleted list: the box is the point, and it has to survive being
# printed and ticked with a pen.
function Checklist([string[]]$items) {
    ($items | ForEach-Object {
        '<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:ind w:left="360" w:hanging="270"/></w:pPr>' +
        '<w:r><w:rPr><w:rFonts w:ascii="Segoe UI Symbol" w:hAnsi="Segoe UI Symbol"/><w:sz w:val="21"/></w:rPr>' +
        '<w:t xml:space="preserve">' + [char]0x2610 + '  </w:t></w:r>' + (Runs $_) + '</w:p>'
    }) -join ''
}

function CodeBlock([string[]]$lines) {
    $n = $lines.Count
    $sb = New-Object System.Text.StringBuilder
    for ($i = 0; $i -lt $n; $i++) {
        $first = ($i -eq 0); $last = ($i -eq $n - 1)
        $bdr = '<w:pBdr><w:left w:val="single" w:sz="18" w:space="6" w:color="1F5C8B"/>'
        if ($first) { $bdr += '<w:top w:val="single" w:sz="2" w:space="4" w:color="D4DAE1"/>' }
        if ($last)  { $bdr += '<w:bottom w:val="single" w:sz="2" w:space="4" w:color="D4DAE1"/>' }
        $bdr += '</w:pBdr>'
        $txt = if ($lines[$i] -eq '') { ' ' } else { $lines[$i] }
        [void]$sb.Append('<w:p><w:pPr><w:pStyle w:val="CodeBlock"/>' + $bdr +
            '<w:spacing w:before="' + $(if ($first) { 120 } else { 0 }) +
            '" w:after="' + $(if ($last) { 160 } else { 0 }) + '"/></w:pPr>' +
            '<w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="17"/></w:rPr>' +
            '<w:t xml:space="preserve">' + (Esc $txt) + '</w:t></w:r></w:p>')
    }
    $sb.ToString() + (Spacer)
}

function Callout([string]$label, [string[]]$body, [string]$tone = 'info') {
    $fill = switch ($tone) { 'warn' { 'F6E7DD' } 'good' { 'DDEDE7' } default { 'EAF0F5' } }
    $bar  = switch ($tone) { 'warn' { 'B04A16' } 'good' { '2C7C68' } default { '1F5C8B' } }

    $cells = ''
    if ($label) {
        $cells += '<w:p><w:pPr><w:spacing w:after="40"/></w:pPr>' +
                  (Runs $label ('<w:b/><w:caps/><w:color w:val="' + $bar + '"/><w:sz w:val="16"/>')) + '</w:p>'
    }
    for ($i = 0; $i -lt $body.Count; $i++) {
        $after = if ($i -eq $body.Count - 1) { 0 } else { 100 }
        $cells += '<w:p><w:pPr><w:spacing w:after="' + $after + '"/></w:pPr>' + (Runs $body[$i]) + '</w:p>'
    }

    '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/>' +
    '<w:tblBorders>' +
    '<w:top w:val="none" w:sz="0" w:space="0" w:color="auto"/>' +
    '<w:bottom w:val="none" w:sz="0" w:space="0" w:color="auto"/>' +
    '<w:left w:val="single" w:sz="18" w:space="0" w:color="' + $bar + '"/>' +
    '<w:right w:val="none" w:sz="0" w:space="0" w:color="auto"/>' +
    '<w:insideH w:val="none" w:sz="0" w:space="0" w:color="auto"/>' +
    '<w:insideV w:val="none" w:sz="0" w:space="0" w:color="auto"/>' +
    '</w:tblBorders>' +
    '<w:tblCellMar><w:top w:w="120" w:type="dxa"/><w:left w:w="180" w:type="dxa"/>' +
    '<w:bottom w:w="120" w:type="dxa"/><w:right w:w="180" w:type="dxa"/></w:tblCellMar>' +
    '</w:tblPr><w:tr><w:trPr><w:cantSplit/></w:trPr><w:tc><w:tcPr><w:shd w:val="clear" w:fill="' + $fill + '"/></w:tcPr>' +
    $cells + '</w:tc></w:tr></w:tbl>' + (Spacer)
}

function TableXml($head, $rows, [int[]]$widths) {
    $cell = {
        param($txt, $w, $isHead, $fill)
        $shd = if ($fill) { '<w:shd w:val="clear" w:fill="' + $fill + '"/>' } else { '' }
        $rpr = if ($isHead) { '<w:b/><w:color w:val="FFFFFF"/><w:sz w:val="17"/>' } else { '<w:sz w:val="18"/>' }
        '<w:tc><w:tcPr><w:tcW w:w="' + [Math]::Round($w * 93.6) + '" w:type="dxa"/>' + $shd +
        '<w:vAlign w:val="center"/></w:tcPr>' +
        '<w:p><w:pPr><w:pStyle w:val="TableCell"/></w:pPr>' + (Runs $txt $rpr) + '</w:p></w:tc>'
    }

    $xml = '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/>' +
        '<w:tblBorders>' +
        '<w:top w:val="single" w:sz="4" w:space="0" w:color="B2BDC7"/>' +
        '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="B2BDC7"/>' +
        '<w:left w:val="none" w:sz="0" w:space="0" w:color="auto"/>' +
        '<w:right w:val="none" w:sz="0" w:space="0" w:color="auto"/>' +
        '<w:insideH w:val="single" w:sz="2" w:space="0" w:color="D4DAE1"/>' +
        '<w:insideV w:val="none" w:sz="0" w:space="0" w:color="auto"/>' +
        '</w:tblBorders>' +
        '<w:tblCellMar><w:top w:w="80" w:type="dxa"/><w:left w:w="110" w:type="dxa"/>' +
        '<w:bottom w:w="80" w:type="dxa"/><w:right w:w="110" w:type="dxa"/></w:tblCellMar>' +
        '</w:tblPr><w:tblGrid>'
    foreach ($w in $widths) { $xml += '<w:gridCol w:w="' + [Math]::Round($w * 93.6) + '"/>' }
    $xml += '</w:tblGrid>'

    # tblHeader repeats the header row when a long table breaks across pages.
    $xml += '<w:tr><w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>'
    for ($i = 0; $i -lt $head.Count; $i++) { $xml += & $cell $head[$i] $widths[$i] $true '1F5C8B' }
    $xml += '</w:tr>'

    for ($r = 0; $r -lt $rows.Count; $r++) {
        $fill = if ($r % 2 -eq 1) { 'F2F4F6' } else { $null }
        $xml += '<w:tr><w:trPr><w:cantSplit/></w:trPr>'
        for ($i = 0; $i -lt $widths.Count; $i++) {
            $v = if ($i -lt $rows[$r].Count) { $rows[$r][$i] } else { '' }
            $xml += & $cell $v $widths[$i] $false $fill
        }
        $xml += '</w:tr>'
    }
    $xml + '</w:tbl>' + (Spacer)
}

function MetaTable($pairs) {
    $cell = {
        param($txt, $w, $rpr)
        '<w:tc><w:tcPr><w:tcW w:w="' + [Math]::Round($w * 93.6) + '" w:type="dxa"/>' +
        '<w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr><w:pStyle w:val="TableCell"/></w:pPr>' +
        (Runs $txt $rpr) + '</w:p></w:tc>'
    }
    $xml = '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/>' +
        '<w:tblBorders>' +
        '<w:top w:val="single" w:sz="4" w:space="0" w:color="B2BDC7"/>' +
        '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="B2BDC7"/>' +
        '<w:left w:val="none" w:sz="0" w:space="0" w:color="auto"/>' +
        '<w:right w:val="none" w:sz="0" w:space="0" w:color="auto"/>' +
        '<w:insideH w:val="single" w:sz="2" w:space="0" w:color="D4DAE1"/>' +
        '<w:insideV w:val="none" w:sz="0" w:space="0" w:color="auto"/>' +
        '</w:tblBorders><w:tblCellMar><w:top w:w="90" w:type="dxa"/><w:left w:w="0" w:type="dxa"/>' +
        '<w:bottom w:w="90" w:type="dxa"/><w:right w:w="110" w:type="dxa"/></w:tblCellMar></w:tblPr>' +
        '<w:tblGrid><w:gridCol w:w="2620"/><w:gridCol w:w="6740"/></w:tblGrid>'
    foreach ($p in $pairs) {
        $xml += '<w:tr><w:trPr><w:cantSplit/></w:trPr>' +
            (& $cell $p[0] 28 '<w:b/><w:caps/><w:sz w:val="15"/><w:color w:val="5B6875"/>') +
            (& $cell $p[1] 72 '<w:sz w:val="18"/>') + '</w:tr>'
    }
    $xml + '</w:tbl>' + (Spacer)
}

function Toc {
    $bs = [char]92
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' + (Runs 'Contents') + '</w:p>' +
    '<w:p><w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>' +
    '<w:r><w:instrText xml:space="preserve"> TOC ' + $bs + 'o "1-2" ' + $bs + 'h ' + $bs + 'z ' + $bs + 'u </w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    '<w:r><w:rPr><w:i/><w:color w:val="5B6875"/></w:rPr>' +
    '<w:t xml:space="preserve">Right-click here and choose Update Field to build the contents.</w:t></w:r>' +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
}

# ---------------------------------------------------------------------------
# Markdown -> blocks
# ---------------------------------------------------------------------------
function Split-Row([string]$line) {
    $t = $line.Trim()
    if ($t.StartsWith('|')) { $t = $t.Substring(1) }
    if ($t.EndsWith('|'))   { $t = $t.Substring(0, $t.Length - 1) }
    ,@($t -split '\|' | ForEach-Object { $_.Trim() })
}

function Is-Separator([string]$line) {
    $cells = Split-Row $line
    if ($cells.Count -eq 0) { return $false }
    foreach ($c in $cells) { if ($c -notmatch '^:?-{2,}:?$') { return $false } }
    $true
}

# Column widths from the widest cell in each column. Equal columns waste the page when
# one column holds a word and another holds a sentence, which is most of these tables.
function Get-Widths($head, $rows) {
    $n = $head.Count
    $max = New-Object int[] $n
    for ($i = 0; $i -lt $n; $i++) { $max[$i] = $head[$i].Length }
    foreach ($r in $rows) {
        for ($i = 0; $i -lt $n -and $i -lt $r.Count; $i++) {
            if ($r[$i].Length -gt $max[$i]) { $max[$i] = $r[$i].Length }
        }
    }
    # Square-root damping: a cell ten times longer needs more room, but not ten times more.
    $w = @(); $sum = 0.0
    for ($i = 0; $i -lt $n; $i++) {
        $v = [Math]::Sqrt([Math]::Max(4, $max[$i])); $w += $v; $sum += $v
    }
    $pct = @(); $acc = 0
    for ($i = 0; $i -lt $n; $i++) {
        $p = [int][Math]::Round(100.0 * $w[$i] / $sum)
        if ($p -lt 12) { $p = 12 }
        $pct += $p; $acc += $p
    }
    # Normalise back to exactly 100 after the minimum-width clamp.
    $pct[$n - 1] += (100 - $acc)
    ,$pct
}

function Strip-Links([string]$s) {
    # Cross-references point at sibling files that travel together; the link text already
    # names them, and a Word document cannot follow a relative Markdown path anyway.
    [regex]::Replace($s, '\[([^\]]+)\]\(([^)]+)\)', {
        param($m)
        $txt = $m.Groups[1].Value; $url = $m.Groups[2].Value
        if ($url -match '^https?://') { "$txt ($url)" } else { $txt }
    })
}

function Convert-Markdown([string[]]$lines) {
    $body = New-Object System.Text.StringBuilder
    $i = 0

    # An ArrayList, not an array: the flush below runs in a child scope, where assigning
    # $para = @() would silently create a local copy and leave the outer one full. Clearing
    # a list through its own reference is the only form that reaches back out.
    $para = New-Object System.Collections.ArrayList

    $flushPara = {
        if ($para.Count -gt 0) {
            [void]$body.Append((Para (($para.ToArray() -join ' ').Trim()) 'BodyText'))
            $script:paraCount++
            [void]$para.Clear()
        }
    }

    while ($i -lt $lines.Count) {
        $line = $lines[$i]
        $t = $line.Trim()

        # blank line ends a paragraph
        if ($t -eq '') { & $flushPara; $i++; continue }

        # horizontal rule -- Heading1 already carries a rule, so a second one is noise
        if ($t -match '^(-{3,}|\*{3,}|_{3,})$') { & $flushPara; $i++; continue }

        # headings
        if ($t -match '^(#{2,6})\s+(.*)$') {
            & $flushPara
            $level = $Matches[1].Length
            $text  = Strip-Links $Matches[2]
            $style = switch ($level) { 2 { 'Heading1' } 3 { 'Heading2' } default { 'Heading3' } }
            [void]$body.Append((Para $text $style))
            $i++; continue
        }

        # fenced code
        if ($t -match '^```') {
            & $flushPara
            $i++
            $buf = @()
            while ($i -lt $lines.Count -and $lines[$i].Trim() -notmatch '^```') { $buf += $lines[$i]; $i++ }
            $i++
            [void]$body.Append((CodeBlock $buf))
            continue
        }

        # blockquote -> callout. A leading **Label.** becomes the callout's label.
        if ($t -match '^>') {
            & $flushPara
            $buf = @()
            while ($i -lt $lines.Count -and $lines[$i].Trim() -match '^>') {
                $buf += ($lines[$i].Trim() -replace '^>\s?', '')
                $i++
            }
            $text  = Strip-Links (($buf -join ' ').Trim())
            $label = ''
            if ($text -match '^\*\*(.+?)\*\*\s*(.*)$') {
                $label = $Matches[1].TrimEnd('.', ':')
                $text  = $Matches[2].Trim()
            }
            if ($text -eq '') { $text = $label; $label = '' }
            [void]$body.Append((Callout $label @($text) 'info'))
            continue
        }

        # table
        if ($t.StartsWith('|') -and ($i + 1) -lt $lines.Count -and (Is-Separator $lines[$i + 1])) {
            & $flushPara
            $head = Split-Row $lines[$i]
            $i += 2
            $rows = @()
            while ($i -lt $lines.Count -and $lines[$i].Trim().StartsWith('|')) {
                $rows += ,(Split-Row $lines[$i]); $i++
            }
            $head = @($head | ForEach-Object { Strip-Links $_ })
            $rows = @($rows | ForEach-Object { ,@($_ | ForEach-Object { Strip-Links $_ }) })
            [void]$body.Append((TableXml $head $rows (Get-Widths $head $rows)))
            $script:tableCount++
            continue
        }

        # checklist
        if ($t -match '^[-*]\s+\[[ xX]\]\s*(.*)$') {
            & $flushPara
            $items = @()
            while ($i -lt $lines.Count -and $lines[$i].Trim() -match '^[-*]\s+\[[ xX]\]\s*(.*)$') {
                $items += (Strip-Links $Matches[1]); $i++
            }
            [void]$body.Append((Checklist $items) + (Spacer))
            continue
        }

        # bullets
        if ($t -match '^[-*]\s+(.*)$') {
            & $flushPara
            $items = @()
            while ($i -lt $lines.Count -and $lines[$i].Trim() -match '^[-*]\s+(.*)$') {
                $item = $Matches[1]
                $i++
                # a wrapped continuation line is indented and is not itself a marker
                while ($i -lt $lines.Count -and $lines[$i] -match '^\s{2,}\S' -and $lines[$i].Trim() -notmatch '^([-*]|\d+\.)\s') {
                    $item += ' ' + $lines[$i].Trim(); $i++
                }
                $items += (Strip-Links $item)
            }
            [void]$body.Append((Bullets $items 1) + (Spacer))
            continue
        }

        # numbered
        if ($t -match '^\d+\.\s+(.*)$') {
            & $flushPara
            $items = @()
            while ($i -lt $lines.Count -and $lines[$i].Trim() -match '^\d+\.\s+(.*)$') {
                $item = $Matches[1]
                $i++
                while ($i -lt $lines.Count -and $lines[$i] -match '^\s{2,}\S' -and $lines[$i].Trim() -notmatch '^([-*]|\d+\.)\s') {
                    $item += ' ' + $lines[$i].Trim(); $i++
                }
                $items += (Strip-Links $item)
            }
            [void]$body.Append((Bullets $items 2) + (Spacer))
            continue
        }

        # ordinary prose
        [void]$para.Add((Strip-Links $t))
        $i++
    }

    & $flushPara
    $body.ToString()
}

# ---------------------------------------------------------------------------
# Package parts -- identical to engine.js, minus the image plumbing
# ---------------------------------------------------------------------------
$XMLDECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + $NL
$FONT = '<w:rFonts w:ascii="Segoe UI" w:hAnsi="Segoe UI" w:cs="Segoe UI"/>'

function Style([string]$id, [string]$name, [hashtable]$o) {
    $x = '<w:style w:type="paragraph" w:styleId="' + $id + '"'
    if ($o.default) { $x += ' w:default="1"' }
    $x += '><w:name w:val="' + $name + '"/>'
    if ($o.basedOn) { $x += '<w:basedOn w:val="' + $o.basedOn + '"/>' }
    if ($o.next)    { $x += '<w:next w:val="' + $o.next + '"/>' }
    if ($o.ContainsKey('outline')) {
        $x += '<w:pPr><w:outlineLvl w:val="' + $o.outline + '"/>' + $o.pPr + '</w:pPr>'
    } elseif ($o.pPr) {
        $x += '<w:pPr>' + $o.pPr + '</w:pPr>'
    }
    if ($o.rPr) { $x += '<w:rPr>' + $o.rPr + '</w:rPr>' }
    $x + '</w:style>'
}

function StylesXml {
    $XMLDECL +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:docDefaults><w:rPrDefault><w:rPr>' + $FONT +
    '<w:sz w:val="20"/><w:szCs w:val="20"/><w:color w:val="16202B"/></w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
    '</w:docDefaults>' +
    (Style 'Normal' 'Normal' @{ default = $true }) +
    (Style 'BodyText' 'Body Text' @{ basedOn = 'Normal' }) +
    (Style 'Title' 'Title' @{ basedOn = 'Normal'; next = 'BodyText'
        pPr = '<w:spacing w:before="0" w:after="80"/>'
        rPr = $FONT + '<w:sz w:val="52"/><w:b/><w:color w:val="16202B"/>' }) +
    (Style 'Subtitle' 'Subtitle' @{ basedOn = 'Normal'; next = 'BodyText'
        pPr = '<w:spacing w:after="360"/>'
        rPr = $FONT + '<w:sz w:val="24"/><w:color w:val="5B6875"/>' }) +
    (Style 'Eyebrow' 'Eyebrow' @{ basedOn = 'Normal'; next = 'Title'
        pPr = '<w:spacing w:after="60"/>'
        rPr = $FONT + '<w:sz w:val="16"/><w:b/><w:caps/><w:color w:val="8996A3"/>' }) +
    (Style 'Heading1' 'heading 1' @{ basedOn = 'Normal'; next = 'BodyText'; outline = 0
        pPr = '<w:spacing w:before="360" w:after="140"/><w:keepNext/><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="6" w:color="D4DAE1"/></w:pBdr>'
        rPr = $FONT + '<w:sz w:val="32"/><w:b/><w:color w:val="16202B"/>' }) +
    (Style 'Heading2' 'heading 2' @{ basedOn = 'Normal'; next = 'BodyText'; outline = 1
        pPr = '<w:spacing w:before="280" w:after="100"/><w:keepNext/>'
        rPr = $FONT + '<w:sz w:val="24"/><w:b/><w:color w:val="1F5C8B"/>' }) +
    (Style 'Heading3' 'heading 3' @{ basedOn = 'Normal'; next = 'BodyText'; outline = 2
        pPr = '<w:spacing w:before="220" w:after="80"/><w:keepNext/>'
        rPr = $FONT + '<w:sz w:val="21"/><w:b/><w:color w:val="16202B"/>' }) +
    (Style 'Caption' 'caption' @{ basedOn = 'Normal'; next = 'BodyText'
        pPr = '<w:jc w:val="center"/><w:spacing w:after="240"/>'
        rPr = $FONT + '<w:sz w:val="17"/><w:i/><w:color w:val="5B6875"/>' }) +
    (Style 'CodeBlock' 'Code Block' @{ basedOn = 'Normal'
        pPr = '<w:shd w:val="clear" w:fill="F7F9FA"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:left="120"/>'
        rPr = '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="17"/>' }) +
    (Style 'TableCell' 'Table Cell' @{ basedOn = 'Normal'
        pPr = '<w:spacing w:before="20" w:after="20" w:line="240" w:lineRule="auto"/>'
        rPr = '<w:sz w:val="18"/>' }) +
    (Style 'ListParagraph' 'List Paragraph' @{ basedOn = 'Normal'
        pPr = '<w:ind w:left="360"/><w:contextualSpacing/><w:spacing w:after="60"/>' }) +
    '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/>' +
    '<w:tblPr><w:tblCellMar><w:top w:w="80" w:type="dxa"/><w:left w:w="110" w:type="dxa"/>' +
    '<w:bottom w:w="80" w:type="dxa"/><w:right w:w="110" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
    '</w:styles>'
}

function NumberingXml {
    $lvl = {
        param($i, $fmt, $txt, $font)
        $x = '<w:lvl w:ilvl="' + $i + '"><w:start w:val="1"/><w:numFmt w:val="' + $fmt + '"/>' +
             '<w:lvlText w:val="' + $txt + '"/><w:lvlJc w:val="left"/>' +
             '<w:pPr><w:ind w:left="' + (360 + $i * 360) + '" w:hanging="270"/></w:pPr>'
        if ($font) { $x += '<w:rPr><w:rFonts w:ascii="' + $font + '" w:hAnsi="' + $font + '" w:hint="default"/></w:rPr>' }
        $x + '</w:lvl>'
    }
    $XMLDECL +
    '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>' +
    (& $lvl 0 'bullet' '&#8226;' 'Symbol') + (& $lvl 1 'bullet' 'o' 'Courier New') +
    '</w:abstractNum>' +
    '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>' +
    (& $lvl 0 'decimal' '%1.' $null) + (& $lvl 1 'lowerLetter' '%2.' $null) +
    '</w:abstractNum>' +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
    '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +
    '</w:numbering>'
}

function SettingsXml {
    $XMLDECL +
    '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/>' +
    '<w:updateFields w:val="true"/>' +
    '<w:compat><w:compatSetting w:name="compatibilityMode" ' +
    'w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>' +
    '</w:settings>'
}

function ContentTypesXml {
    $XMLDECL +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
    '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' +
    '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '</Types>'
}

function RootRelsXml {
    $R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
    $XMLDECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="' + $R + 'officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="' + $R + 'extended-properties" Target="docProps/app.xml"/>' +
    '</Relationships>'
}

function DocRelsXml {
    $R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
    $XMLDECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="' + $R + 'styles" Target="styles.xml"/>' +
    '<Relationship Id="rId2" Type="' + $R + 'numbering" Target="numbering.xml"/>' +
    '<Relationship Id="rId3" Type="' + $R + 'settings" Target="settings.xml"/>' +
    '<Relationship Id="rId4" Type="' + $R + 'footer" Target="footer1.xml"/>' +
    '</Relationships>'
}

function FooterXml([string]$text) {
    $XMLDECL +
    '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:p><w:pPr><w:pBdr><w:top w:val="single" w:sz="4" w:space="6" w:color="D4DAE1"/></w:pBdr>' +
    '<w:tabs><w:tab w:val="right" w:pos="9360"/></w:tabs><w:spacing w:after="0"/></w:pPr>' +
    '<w:r><w:rPr><w:sz w:val="15"/><w:color w:val="8996A3"/></w:rPr>' +
    '<w:t xml:space="preserve">' + (Esc $text) + '</w:t></w:r>' +
    '<w:r><w:tab/></w:r>' +
    '<w:r><w:rPr><w:sz w:val="15"/><w:color w:val="8996A3"/></w:rPr><w:t xml:space="preserve">Page </w:t></w:r>' +
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    '<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    '<w:r><w:rPr><w:sz w:val="15"/><w:color w:val="8996A3"/></w:rPr><w:t>1</w:t></w:r>' +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
    '</w:p></w:ftr>'
}

function CorePropsXml([string]$title, [string]$subject, [string]$stamp) {
    $XMLDECL +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    '<dc:title>' + (Esc $title) + '</dc:title>' +
    '<dc:subject>' + (Esc $subject) + '</dc:subject>' +
    '<dc:creator>Orchestrator documentation build</dc:creator>' +
    '<cp:lastModifiedBy>Orchestrator documentation build</cp:lastModifiedBy>' +
    '<dcterms:created xsi:type="dcterms:W3CDTF">' + $stamp + '</dcterms:created>' +
    '<dcterms:modified xsi:type="dcterms:W3CDTF">' + $stamp + '</dcterms:modified>' +
    '</cp:coreProperties>'
}

function AppPropsXml {
    $XMLDECL +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    '<Application>Orchestrator documentation build</Application>' +
    '</Properties>'
}

function DocumentXml([string]$bodyXml) {
    $XMLDECL +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<w:body>' + $bodyXml +
    '<w:sectPr>' +
    '<w:footerReference w:type="default" r:id="rId4"/>' +
    '<w:pgSz w:w="12240" w:h="15840"/>' +
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" ' +
    'w:header="720" w:footer="600" w:gutter="0"/>' +
    '<w:cols w:space="720"/><w:docGrid w:linePitch="360"/>' +
    '</w:sectPr></w:body></w:document>'
}

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
$script:paraCount  = 0
$script:tableCount = 0

$raw = [System.IO.File]::ReadAllText($InPath, [System.Text.Encoding]::UTF8)
$lines = $raw -split "`r?`n"

# The first heading is "<Document> — <Package>"; the words either side of the dash are the
# title and the eyebrow, and the paragraph under it is the subtitle.
$docTitle = [System.IO.Path]::GetFileNameWithoutExtension($InPath)
$eyebrow  = $Package
$start    = 0
if ($lines[0] -match '^#\s+(.*)$') {
    $h = $Matches[1]
    if ($h -match '^(.*?)\s+[' + [char]0x2014 + [char]0x2013 + '-]\s+(.*)$') {
        $docTitle = $Matches[1].Trim(); $eyebrow = $Matches[2].Trim()
    } else { $docTitle = $h.Trim() }
    $start = 1
}

# Subtitle: the prose immediately under the heading, up to the first blank line.
$sub = @()
$j = $start
while ($j -lt $lines.Count -and $lines[$j].Trim() -eq '') { $j++ }
while ($j -lt $lines.Count -and $lines[$j].Trim() -ne '' -and $lines[$j].Trim() -notmatch '^(#|\||>|```|[-*]\s|\d+\.\s|---)') {
    $sub += $lines[$j].Trim(); $j++
}
$subtitle = Strip-Links (($sub -join ' ').Trim())

$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
$srcName = [System.IO.Path]::GetFileName($InPath)

$cover =
    (Para $eyebrow 'Eyebrow') +
    (Para $docTitle 'Title') +
    $(if ($subtitle) { Para $subtitle 'Subtitle' } else { '' }) +
    (MetaTable @(
        @('Document', $docTitle),
        @('Package',  $Package),
        @('Platform', $Platform),
        # Parenthesised deliberately: the comma binds tighter than +, so without these
        # brackets this is a four-element array, not a pair, and the cell gets one backtick.
        @('Source',   ('`' + $srcName + '`'))
    )) +
    (Callout 'Generated file' @(
        'This document is generated from **' + $srcName + '**. Edit the Markdown and rebuild - ' +
        'changes made here are lost the next time it is built.'
    ) 'info') +
    (Toc) +
    (PageBreak)

$bodyXml = $cover + (Convert-Markdown $lines[$j..($lines.Count - 1)])

# ---------------------------------------------------------------------------
# Write the package. [Content_Types].xml must be the first entry in the archive.
# ---------------------------------------------------------------------------
$parts = [ordered]@{
    '[Content_Types].xml'           = ContentTypesXml
    '_rels/.rels'                   = RootRelsXml
    'docProps/core.xml'             = CorePropsXml $docTitle $Package $stamp
    'docProps/app.xml'              = AppPropsXml
    'word/document.xml'             = DocumentXml $bodyXml
    'word/_rels/document.xml.rels'  = DocRelsXml
    'word/styles.xml'               = StylesXml
    'word/numbering.xml'            = NumberingXml
    'word/settings.xml'             = SettingsXml
    'word/footer1.xml'              = FooterXml ($docTitle + '  |  ' + $Package)
}

# Every part must be well-formed before it goes in: a malformed one produces a file that
# Word refuses with a message naming no part in particular.
foreach ($k in $parts.Keys) {
    try { [void][xml]$parts[$k] } catch { throw "malformed XML in part $k : $($_.Exception.Message)" }
}

if ([System.IO.File]::Exists($OutPath)) { [System.IO.File]::Delete($OutPath) }
$enc = New-Object System.Text.UTF8Encoding($false)
$fs  = [System.IO.File]::Open($OutPath, [System.IO.FileMode]::CreateNew)
$zip = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($k in $parts.Keys) {
        $e  = $zip.CreateEntry($k, [System.IO.Compression.CompressionLevel]::Optimal)
        $es = $e.Open()
        $b  = $enc.GetBytes([string]$parts[$k])
        $es.Write($b, 0, $b.Length)
        $es.Dispose()
    }
} finally { $zip.Dispose(); $fs.Dispose() }

# Read it back through the same OPC layer Word uses, as a build-time check.
$pkg = [System.IO.Packaging.Package]::Open($OutPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read)
$partCount = ($pkg.GetParts() | Measure-Object).Count
$pkg.Close()

[pscustomobject]@{
    File       = [System.IO.Path]::GetFileName($OutPath)
    KB         = [Math]::Round((Get-Item -LiteralPath $OutPath).Length / 1KB, 1)
    Parts      = $partCount
    Paragraphs = $script:paraCount
    Tables     = $script:tableCount
}
