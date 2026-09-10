'use strict';
const fs = require('fs'), path = require('path');

const BS = String.fromCharCode(92);
const EMU_PER_INCH = 914400;
const CONTENT_WIDTH_EMU = Math.round(6.5 * EMU_PER_INCH); // Letter, 1in margins

// Content is authored with the broken-bar character standing in for a backslash, so no
// literal backslash ever has to survive a shell heredoc on the way into this file.
function unbar(s) { return String(s).split('¦').join(BS); }

function esc(s) {
  return unbar(s)
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;');
}

// ---------------------------------------------------------------------------
// Inline markup: **bold** and `code`. Hand-scanned rather than regex-parsed so
// the source of this file needs no escape sequences of its own.
// ---------------------------------------------------------------------------
const CODE_RPR = '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/>' +
                 '<w:shd w:val="clear" w:fill="EEF1F4"/>';

// Nested markup is handled by recursion: a bold span is re-parsed with <w:b/> folded into
// the base run properties, so `code` inside **bold** keeps both. Parsing the bold body as
// one literal buffer -- the obvious first cut -- leaves the backticks on the page.
function runs(text, baseRPr) {
  baseRPr = baseRPr || '';
  const out = [];
  let buf = '', i = 0;
  const s = String(text);

  const flushPlain = () => {
    if (buf === '') return;
    out.push('<w:r><w:rPr>' + baseRPr + '</w:rPr><w:t xml:space="preserve">' + esc(buf) + '</w:t></w:r>');
    buf = '';
  };

  while (i < s.length) {
    if (s[i] === '*' && s[i + 1] === '*') {
      const end = s.indexOf('**', i + 2);
      if (end > -1) {
        flushPlain();
        out.push(runs(s.slice(i + 2, end), baseRPr + '<w:b/>'));
        i = end + 2;
        continue;
      }
    }
    if (s[i] === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > -1) {
        flushPlain();
        out.push('<w:r><w:rPr>' + baseRPr + CODE_RPR + '</w:rPr><w:t xml:space="preserve">' +
                 esc(s.slice(i + 1, end)) + '</w:t></w:r>');
        i = end + 1;
        continue;
      }
    }
    buf += s[i];
    i++;
  }

  flushPlain();
  return out.join('');
}

function para(text, style, extraPPr) {
  const pPr = (style ? '<w:pStyle w:val="' + style + '"/>' : '') + (extraPPr || '');
  return '<w:p>' + (pPr ? '<w:pPr>' + pPr + '</w:pPr>' : '') + runs(text) + '</w:p>';
}

// ---------------------------------------------------------------------------
// Block renderers
// ---------------------------------------------------------------------------
const B = {
  title:    (t) => para(t, 'Title'),
  subtitle: (t) => para(t, 'Subtitle'),
  h1:       (t) => para(t, 'Heading1'),
  h2:       (t) => para(t, 'Heading2'),
  h3:       (t) => para(t, 'Heading3'),
  p:        (t) => para(t, 'BodyText'),
  caption:  (t) => para(t, 'Caption'),
  pagebreak: () => '<w:p><w:r><w:br w:type="page"/></w:r></w:p>',
  spacer:   () => '<w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>',
};

function bullets(items, numId) {
  return items.map((t) =>
    '<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/>' +
    '<w:numId w:val="' + (numId || 1) + '"/></w:numPr></w:pPr>' + runs(t) + '</w:p>'
  ).join('');
}

function code(lines) {
  const arr = Array.isArray(lines) ? lines : String(lines).split(String.fromCharCode(10));
  return arr.map((ln, idx) => {
    const first = idx === 0, last = idx === arr.length - 1;
    const bdr =
      '<w:pBdr>' +
      '<w:left w:val="single" w:sz="18" w:space="6" w:color="1F5C8B"/>' +
      (first ? '<w:top w:val="single" w:sz="2" w:space="4" w:color="D4DAE1"/>' : '') +
      (last ? '<w:bottom w:val="single" w:sz="2" w:space="4" w:color="D4DAE1"/>' : '') +
      '</w:pBdr>';
    return '<w:p><w:pPr><w:pStyle w:val="CodeBlock"/>' + bdr +
      '<w:spacing w:before="' + (first ? 120 : 0) + '" w:after="' + (last ? 160 : 0) + '"/>' +
      '</w:pPr><w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="17"/></w:rPr>' +
      '<w:t xml:space="preserve">' + esc(ln === '' ? ' ' : ln) + '</w:t></w:r></w:p>';
  }).join('');
}

function callout(label, text, tone) {
  const fill = tone === 'warn' ? 'F6E7DD' : (tone === 'good' ? 'DDEDE7' : 'EAF0F5');
  const bar = tone === 'warn' ? 'B04A16' : (tone === 'good' ? '2C7C68' : '1F5C8B');
  const cells = [];
  if (label) {
    cells.push('<w:p><w:pPr><w:spacing w:after="40"/></w:pPr>' +
      runs(label, '<w:b/><w:caps/><w:color w:val="' + bar + '"/><w:sz w:val="16"/>') + '</w:p>');
  }
  const body = Array.isArray(text) ? text : [text];
  body.forEach((t, i) => {
    cells.push('<w:p><w:pPr><w:spacing w:after="' + (i === body.length - 1 ? 0 : 100) + '"/></w:pPr>' + runs(t) + '</w:p>');
  });
  return '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/>' +
    '<w:tblBorders>' +
    '<w:top w:val="none" w:sz="0" w:space="0" w:color="auto"/>' +
    '<w:bottom w:val="none" w:sz="0" w:space="0" w:color="auto"/>' +
    '<w:left w:val="single" w:sz="18" w:space="0" w:color="' + bar + '"/>' +
    '<w:right w:val="none" w:sz="0" w:space="0" w:color="auto"/>' +
    '<w:insideH w:val="none" w:sz="0" w:space="0" w:color="auto"/>' +
    '<w:insideV w:val="none" w:sz="0" w:space="0" w:color="auto"/>' +
    '</w:tblBorders>' +
    '<w:tblCellMar><w:top w:w="120" w:type="dxa"/><w:left w:w="180" w:type="dxa"/>' +
    '<w:bottom w:w="120" w:type="dxa"/><w:right w:w="180" w:type="dxa"/></w:tblCellMar>' +
    '</w:tblPr><w:tr><w:tc><w:tcPr><w:shd w:val="clear" w:fill="' + fill + '"/></w:tcPr>' +
    cells.join('') + '</w:tc></w:tr></w:tbl>' + B.spacer();
}

function table(spec) {
  // spec: { head: [..], rows: [[..]], widths: [pct..], zebra: bool }
  const widths = spec.widths || spec.head.map(() => Math.round(100 / spec.head.length));
  const grid = widths.map((w) => '<w:gridCol w:w="' + Math.round(w * 93.6) + '"/>').join('');

  const cell = (txt, opts) => {
    opts = opts || {};
    const shd = opts.fill ? '<w:shd w:val="clear" w:fill="' + opts.fill + '"/>' : '';
    const rpr = opts.head ? '<w:b/><w:color w:val="FFFFFF"/><w:sz w:val="17"/>' : '<w:sz w:val="18"/>';
    return '<w:tc><w:tcPr><w:tcW w:w="' + Math.round((opts.w || 0) * 93.6) + '" w:type="dxa"/>' + shd +
      '<w:vAlign w:val="center"/></w:tcPr>' +
      '<w:p><w:pPr><w:pStyle w:val="TableCell"/></w:pPr>' + runs(txt, rpr) + '</w:p></w:tc>';
  };

  let xml = '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/>' +
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
    '</w:tblPr><w:tblGrid>' + grid + '</w:tblGrid>';

  xml += '<w:tr><w:trPr><w:tblHeader/></w:trPr>' +
    spec.head.map((h, i) => cell(h, { head: true, fill: '1F5C8B', w: widths[i] })).join('') + '</w:tr>';

  spec.rows.forEach((r, ri) => {
    const fill = (ri % 2 === 1) ? 'F2F4F6' : null;
    xml += '<w:tr>' + r.map((c, i) => cell(c, { fill: fill, w: widths[i] })).join('') + '</w:tr>';
  });

  return xml + '</w:tbl>' + B.spacer();
}

function figure(img, caption, note) {
  const cy = Math.round(CONTENT_WIDTH_EMU * img.h / img.w);
  let xml =
    '<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="160" w:after="80"/></w:pPr><w:r><w:drawing>' +
    '<wp:inline distT="0" distB="0" distL="0" distR="0">' +
    '<wp:extent cx="' + CONTENT_WIDTH_EMU + '" cy="' + cy + '"/>' +
    '<wp:effectExtent l="0" t="0" r="0" b="0"/>' +
    '<wp:docPr id="' + img.id + '" name="Figure ' + img.id + '" descr="' + esc(img.alt || caption) + '"/>' +
    '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:pic><pic:nvPicPr><pic:cNvPr id="' + img.id + '" name="' + img.file + '"/><pic:cNvPicPr/></pic:nvPicPr>' +
    '<pic:blipFill><a:blip r:embed="' + img.rid + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
    '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + CONTENT_WIDTH_EMU + '" cy="' + cy + '"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
    '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
  xml += B.caption(caption);
  if (note) xml += callout('What this document covers', note, 'info');
  return xml;
}

function metaTable(pairs) {
  return table({
    head: ['', ''],
    rows: pairs,
    widths: [30, 70],
  }).replace('<w:tr><w:trPr><w:tblHeader/></w:trPr>' +
    '<w:tc><w:tcPr><w:tcW w:w="2808" w:type="dxa"/><w:shd w:val="clear" w:fill="1F5C8B"/><w:vAlign w:val="center"/></w:tcPr>' +
    '<w:p><w:pPr><w:pStyle w:val="TableCell"/></w:pPr></w:p></w:tc>' +
    '<w:tc><w:tcPr><w:tcW w:w="6552" w:type="dxa"/><w:shd w:val="clear" w:fill="1F5C8B"/><w:vAlign w:val="center"/></w:tcPr>' +
    '<w:p><w:pPr><w:pStyle w:val="TableCell"/></w:pPr></w:p></w:tc></w:tr>', '');
}

function toc() {
  return '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' + runs('Contents') + '</w:p>' +
    '<w:p><w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>' +
    '<w:r><w:instrText xml:space="preserve"> TOC ' + BS + 'o "1-2" ' + BS + 'h ' + BS + 'z ' + BS + 'u </w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    '<w:r><w:rPr><w:i/><w:color w:val="5B6875"/></w:rPr>' +
    '<w:t xml:space="preserve">Right-click here and choose Update Field to build the contents.</w:t></w:r>' +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>';
}

// Redefined cleanly: a two-column key/value block with no header row. Declared after the
// first version on purpose -- function declarations hoist, so this one wins.
function metaTable(pairs) {
  const cell = (txt, w, opts) => {
    opts = opts || {};
    return '<w:tc><w:tcPr><w:tcW w:w="' + Math.round(w * 93.6) + '" w:type="dxa"/>' +
      (opts.fill ? '<w:shd w:val="clear" w:fill="' + opts.fill + '"/>' : '') +
      '<w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr><w:pStyle w:val="TableCell"/></w:pPr>' +
      runs(txt, opts.rpr || '<w:sz w:val="18"/>') + '</w:p></w:tc>';
  };
  let xml = '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/>' +
    '<w:tblBorders>' +
    '<w:top w:val="single" w:sz="4" w:space="0" w:color="B2BDC7"/>' +
    '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="B2BDC7"/>' +
    '<w:left w:val="none" w:sz="0" w:space="0" w:color="auto"/>' +
    '<w:right w:val="none" w:sz="0" w:space="0" w:color="auto"/>' +
    '<w:insideH w:val="single" w:sz="2" w:space="0" w:color="D4DAE1"/>' +
    '<w:insideV w:val="none" w:sz="0" w:space="0" w:color="auto"/>' +
    '</w:tblBorders><w:tblCellMar><w:top w:w="90" w:type="dxa"/><w:left w:w="0" w:type="dxa"/>' +
    '<w:bottom w:w="90" w:type="dxa"/><w:right w:w="110" w:type="dxa"/></w:tblCellMar></w:tblPr>' +
    '<w:tblGrid><w:gridCol w:w="2620"/><w:gridCol w:w="6740"/></w:tblGrid>';
  pairs.forEach((p) => {
    xml += '<w:tr>' +
      cell(p[0], 28, { rpr: '<w:b/><w:caps/><w:sz w:val="15"/><w:color w:val="5B6875"/>' }) +
      cell(p[1], 72) + '</w:tr>';
  });
  return xml + '</w:tbl>' + B.spacer();
}

// ---------------------------------------------------------------------------
// Package parts
// ---------------------------------------------------------------------------
const XMLDECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + String.fromCharCode(10);

function stylesXml() {
  const st = (id, name, opts) =>
    '<w:style w:type="paragraph" w:styleId="' + id + '"' + (opts.default ? ' w:default="1"' : '') + '>' +
    '<w:name w:val="' + name + '"/>' +
    (opts.basedOn ? '<w:basedOn w:val="' + opts.basedOn + '"/>' : '') +
    (opts.next ? '<w:next w:val="' + opts.next + '"/>' : '') +
    (opts.outline !== undefined ? '<w:pPr><w:outlineLvl w:val="' + opts.outline + '"/>' + (opts.pPr || '') + '</w:pPr>'
      : (opts.pPr ? '<w:pPr>' + opts.pPr + '</w:pPr>' : '')) +
    (opts.rPr ? '<w:rPr>' + opts.rPr + '</w:rPr>' : '') + '</w:style>';

  const FONT = '<w:rFonts w:ascii="Segoe UI" w:hAnsi="Segoe UI" w:cs="Segoe UI"/>';

  return XMLDECL +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:docDefaults><w:rPrDefault><w:rPr>' + FONT +
    '<w:sz w:val="20"/><w:szCs w:val="20"/><w:color w:val="16202B"/></w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
    '</w:docDefaults>' +
    st('Normal', 'Normal', { default: true }) +
    st('BodyText', 'Body Text', { basedOn: 'Normal' }) +
    st('Title', 'Title', {
      basedOn: 'Normal', next: 'BodyText',
      pPr: '<w:spacing w:before="0" w:after="80"/>',
      rPr: FONT + '<w:sz w:val="52"/><w:b/><w:color w:val="16202B"/>',
    }) +
    st('Subtitle', 'Subtitle', {
      basedOn: 'Normal', next: 'BodyText',
      pPr: '<w:spacing w:after="360"/>',
      rPr: FONT + '<w:sz w:val="24"/><w:color w:val="5B6875"/>',
    }) +
    st('Eyebrow', 'Eyebrow', {
      basedOn: 'Normal', next: 'Title',
      pPr: '<w:spacing w:after="60"/>',
      rPr: FONT + '<w:sz w:val="16"/><w:b/><w:caps/><w:color w:val="8996A3"/>',
    }) +
    st('Heading1', 'heading 1', {
      basedOn: 'Normal', next: 'BodyText', outline: 0,
      pPr: '<w:spacing w:before="360" w:after="140"/><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="6" w:color="D4DAE1"/></w:pBdr>',
      rPr: FONT + '<w:sz w:val="32"/><w:b/><w:color w:val="16202B"/>',
    }) +
    st('Heading2', 'heading 2', {
      basedOn: 'Normal', next: 'BodyText', outline: 1,
      pPr: '<w:spacing w:before="280" w:after="100"/>',
      rPr: FONT + '<w:sz w:val="24"/><w:b/><w:color w:val="1F5C8B"/>',
    }) +
    st('Heading3', 'heading 3', {
      basedOn: 'Normal', next: 'BodyText', outline: 2,
      pPr: '<w:spacing w:before="220" w:after="80"/>',
      rPr: FONT + '<w:sz w:val="21"/><w:b/><w:color w:val="16202B"/>',
    }) +
    st('Caption', 'caption', {
      basedOn: 'Normal', next: 'BodyText',
      pPr: '<w:jc w:val="center"/><w:spacing w:after="240"/>',
      rPr: FONT + '<w:sz w:val="17"/><w:i/><w:color w:val="5B6875"/>',
    }) +
    st('CodeBlock', 'Code Block', {
      basedOn: 'Normal',
      pPr: '<w:shd w:val="clear" w:fill="F7F9FA"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:left="120"/>',
      rPr: '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="17"/>',
    }) +
    st('TableCell', 'Table Cell', {
      basedOn: 'Normal',
      pPr: '<w:spacing w:before="20" w:after="20" w:line="240" w:lineRule="auto"/>',
      rPr: '<w:sz w:val="18"/>',
    }) +
    st('ListParagraph', 'List Paragraph', {
      basedOn: 'Normal',
      pPr: '<w:ind w:left="360"/><w:contextualSpacing/><w:spacing w:after="60"/>',
    }) +
    '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/>' +
    '<w:tblPr><w:tblCellMar><w:top w:w="80" w:type="dxa"/><w:left w:w="110" w:type="dxa"/>' +
    '<w:bottom w:w="80" w:type="dxa"/><w:right w:w="110" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
    '</w:styles>';
}

function numberingXml() {
  const lvl = (i, fmt, txt, font) =>
    '<w:lvl w:ilvl="' + i + '"><w:start w:val="1"/><w:numFmt w:val="' + fmt + '"/>' +
    '<w:lvlText w:val="' + txt + '"/><w:lvlJc w:val="left"/>' +
    '<w:pPr><w:ind w:left="' + (360 + i * 360) + '" w:hanging="270"/></w:pPr>' +
    (font ? '<w:rPr><w:rFonts w:ascii="' + font + '" w:hAnsi="' + font + '" w:hint="default"/></w:rPr>' : '') +
    '</w:lvl>';
  return XMLDECL +
    '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>' +
    lvl(0, 'bullet', '&#8226;', 'Symbol') + lvl(1, 'bullet', 'o', 'Courier New') +
    '</w:abstractNum>' +
    '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>' +
    lvl(0, 'decimal', '%1.') + lvl(1, 'lowerLetter', '%2.') +
    '</w:abstractNum>' +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
    '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +
    '</w:numbering>';
}

function settingsXml() {
  // updateFields makes Word offer to build the table of contents when the file opens.
  return XMLDECL +
    '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/>' +
    '<w:updateFields w:val="true"/>' +
    '<w:compat><w:compatSetting w:name="compatibilityMode" ' +
    'w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>' +
    '</w:settings>';
}

function contentTypesXml() {
  return XMLDECL +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
    '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' +
    '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '</Types>';
}

function rootRelsXml() {
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
  return XMLDECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="' + R + 'officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="' + R + 'extended-properties" Target="docProps/app.xml"/>' +
    '</Relationships>';
}

function docRelsXml(images) {
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
  let xml = XMLDECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="' + R + 'styles" Target="styles.xml"/>' +
    '<Relationship Id="rId2" Type="' + R + 'numbering" Target="numbering.xml"/>' +
    '<Relationship Id="rId3" Type="' + R + 'settings" Target="settings.xml"/>' +
    '<Relationship Id="rId4" Type="' + R + 'footer" Target="footer1.xml"/>';
  images.forEach((im) => {
    xml += '<Relationship Id="' + im.rid + '" Type="' + R + 'image" Target="media/' + im.file + '"/>';
  });
  return xml + '</Relationships>';
}

function footerXml(text) {
  return XMLDECL +
    '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:p><w:pPr><w:pBdr><w:top w:val="single" w:sz="4" w:space="6" w:color="D4DAE1"/></w:pBdr>' +
    '<w:tabs><w:tab w:val="right" w:pos="9360"/></w:tabs><w:spacing w:after="0"/></w:pPr>' +
    '<w:r><w:rPr><w:sz w:val="15"/><w:color w:val="8996A3"/></w:rPr>' +
    '<w:t xml:space="preserve">' + esc(text) + '</w:t></w:r>' +
    '<w:r><w:tab/></w:r>' +
    '<w:r><w:rPr><w:sz w:val="15"/><w:color w:val="8996A3"/></w:rPr><w:t xml:space="preserve">Page </w:t></w:r>' +
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    '<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    '<w:r><w:rPr><w:sz w:val="15"/><w:color w:val="8996A3"/></w:rPr><w:t>1</w:t></w:r>' +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
    '</w:p></w:ftr>';
}

function corePropsXml(meta) {
  const now = new Date().toISOString().replace(/\.[0-9]+Z$/, 'Z');
  return XMLDECL +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    '<dc:title>' + esc(meta.title) + '</dc:title>' +
    '<dc:subject>' + esc(meta.subject || '') + '</dc:subject>' +
    '<dc:creator>' + esc(meta.author || '') + '</dc:creator>' +
    '<cp:lastModifiedBy>' + esc(meta.author || '') + '</cp:lastModifiedBy>' +
    '<dcterms:created xsi:type="dcterms:W3CDTF">' + now + '</dcterms:created>' +
    '<dcterms:modified xsi:type="dcterms:W3CDTF">' + now + '</dcterms:modified>' +
    '</cp:coreProperties>';
}

function appPropsXml(meta) {
  return XMLDECL +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    '<Application>Orchestrator documentation build</Application>' +
    '<Company>' + esc(meta.company || '') + '</Company>' +
    '</Properties>';
}

// ---------------------------------------------------------------------------
// Assemble
// ---------------------------------------------------------------------------
function renderBlocks(blocks) {
  return blocks.map((b) => {
    const k = Object.keys(b)[0], v = b[k];
    switch (k) {
      case 'eyebrow':   return para(v, 'Eyebrow');
      case 'title':     return B.title(v);
      case 'subtitle':  return B.subtitle(v);
      case 'h1':        return B.h1(v);
      case 'h2':        return B.h2(v);
      case 'h3':        return B.h3(v);
      case 'p':         return B.p(v);
      case 'bullets':   return bullets(v, 1) + B.spacer();
      case 'numbers':   return bullets(v, 2) + B.spacer();
      case 'code':      return code(v);
      case 'table':     return table(v);
      case 'meta':      return metaTable(v);
      case 'figure':    return figure(v.img, v.caption, v.note);
      case 'callout':   return callout(v.label, v.text, v.tone);
      case 'toc':       return toc();
      case 'pagebreak': return B.pagebreak();
      case 'spacer':    return B.spacer();
      default: throw new Error('unknown block: ' + k);
    }
  }).join('');
}

function documentXml(blocks) {
  return XMLDECL +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<w:body>' + renderBlocks(blocks) +
    '<w:sectPr>' +
    '<w:footerReference w:type="default" r:id="rId4"/>' +
    '<w:pgSz w:w="12240" w:h="15840"/>' +
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" ' +
    'w:header="720" w:footer="600" w:gutter="0"/>' +
    '<w:cols w:space="720"/><w:docGrid w:linePitch="360"/>' +
    '</w:sectPr></w:body></w:document>';
}

// Writes the unzipped package into stageDir and returns the ordered entry list.
// [Content_Types].xml must be the first entry in the archive, so the order matters.
function stage(stageDir, doc) {
  const w = (rel, content) => {
    const full = path.join(stageDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    return rel;
  };

  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  const order = [];
  order.push(w('[Content_Types].xml', contentTypesXml()));
  order.push(w('_rels/.rels', rootRelsXml()));
  order.push(w('docProps/core.xml', corePropsXml(doc.meta)));
  order.push(w('docProps/app.xml', appPropsXml(doc.meta)));
  order.push(w('word/document.xml', documentXml(doc.blocks)));
  order.push(w('word/_rels/document.xml.rels', docRelsXml(doc.images)));
  order.push(w('word/styles.xml', stylesXml()));
  order.push(w('word/numbering.xml', numberingXml()));
  order.push(w('word/settings.xml', settingsXml()));
  order.push(w('word/footer1.xml', footerXml(doc.meta.footer || doc.meta.title)));

  doc.images.forEach((im) => {
    const rel = 'word/media/' + im.file;
    const full = path.join(stageDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.copyFileSync(im.src, full);
    order.push(rel);
  });

  fs.writeFileSync(path.join(stageDir, '..', path.basename(stageDir) + '.order.txt'),
    order.join(String.fromCharCode(10)), 'utf8');
  return order;
}

module.exports = { stage, documentXml, unbar, CONTENT_WIDTH_EMU };
