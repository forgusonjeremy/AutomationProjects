# Markdown to Word

Builds the Word copies of the numbered documentation — `01_User-Guide.docx` through
`04_Testing-Plan.docx` — from the Markdown that is already the source of truth for them.

```powershell
.\build.ps1
```

On a machine where Group Policy blocks running `.ps1` files from disk — this one does, with
*"blocked by software restriction policies"* — run it as a script block instead, which the
policy does not cover. Use an absolute path: `ReadAllText` resolves a relative one against
.NET's working directory, which `Set-Location` does not change.

```powershell
$dir = 'C:\...\Tools\markdown-docx'
$c = [System.IO.File]::ReadAllText("$dir\build.ps1", [System.Text.Encoding]::UTF8)
& ([ScriptBlock]::Create($c))
```

The Markdown stays authoritative. Re-run this after editing any of it; the `.docx` files are
outputs and hand-edits to them are lost on the next build. Each cover page says so.

---

## Why this exists rather than a converter

Nothing on the build machine will do it. There is no pandoc and no Node. Word *is* installed,
but Office policy opens HTML read-only, which closes the usual Markdown → HTML → Word route —
`Documents.Open` returns a document that will not accept a page-setup change or a `SaveAs`.
So the `.docx` is assembled as OOXML directly, the same approach `../architecture-docx` takes.

The styles are deliberately the same ones `../architecture-docx/engine.js` defines, so every
file in `Documentation/` looks like it belongs to one set: same Segoe UI and Consolas, same
`1F5C8B` blue, same table and callout treatment.

| File | What it is |
|---|---|
| `md2docx.ps1` | The converter: Markdown parser front end, OOXML writer back end |
| `build.ps1` | Runs it over all four documents and reports what came out |

---

## How Markdown maps onto the page

| Markdown | Becomes |
|---|---|
| `# Title — Package` | Cover page: *Package* as the eyebrow, *Title* as the title |
| First paragraph | Subtitle, under the title |
| `##` / `###` / `####` | Heading 1 / 2 / 3 — Heading 1 and 2 are what the contents page picks up |
| `> quote` | A callout: a tinted panel with a coloured left bar |
| `> **Label.** text` | The same, with *Label* as the panel's heading |
| ` ```fenced``` ` | Code block, blue left rule, Consolas |
| Pipe table | Table with a blue header row, zebra striping, repeating header across pages |
| `- [ ]` | A checklist with an open box, sized to be ticked in pen |
| `- ` / `1. ` | Bulleted / numbered list |
| `---` | Nothing — Heading 1 already carries a rule, so a second one is noise |
| `[text](file.md)` | Just *text*. Word cannot follow a relative Markdown path, and the files travel together anyway |
| `**bold**`, `*italic*`, `` `code` `` | As you would expect, and they nest |

Column widths are set from the widest cell in each column, damped by a square root — a column
holding a sentence gets more room than one holding a word, but not proportionally more.

Every blockquote becomes an *info* callout. The engine also has warning and success tones, but
Markdown has no marker to tell them apart, so guessing from the wording would be inventing
information the source does not carry.

---

## Two things that will bite you

**The comma binds tighter than `+`.** In PowerShell, `@('Source', 'a' + $b + 'c')` is a
*four*-element array, not a pair — the concatenation never happens. Parenthesise any element of
an array literal that is built by concatenation. This cost a build: the cover page's Source row
rendered as a lone backtick.

**A scriptblock cannot clear a variable in its caller.** `& $flush` runs in a child scope, so
`$para = @()` inside it creates a local and leaves the outer array untouched — every flush then
re-emits everything before it. The accumulator is an `ArrayList` cleared through its own
reference for exactly this reason. Symptom: a 13 KB Markdown file producing a 119-page document.

---

## Checks the build makes

Every XML part is parsed before it goes into the package, and the finished file is read back
through `System.IO.Packaging` — the same OPC layer Word uses — so a malformed part fails the
build rather than producing a file Word refuses to open.

What it does **not** check is whether the output reads well. Look at the result. In particular
`build.ps1` prints the Word word count beside the Markdown word count; they should be close,
and the `.docx` slightly lower, since Markdown's own punctuation counts as words in the
comparison and not in Word.
