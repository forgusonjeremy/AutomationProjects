# Architecture document generator

Builds the two `05_Architecture.docx` files that ship inside the packages.

```powershell
.\build.ps1
```

Then copy the output over the two `Documentation/05_Architecture.docx` files.

---

## Why this exists rather than a Word template

There is no Word, pandoc or LibreOffice on the build machine. The documents are therefore
assembled as OOXML directly — which is no worse, and has one real advantage: the content
lives in a reviewable text file next to the rest of the documentation, so a change to the
architecture is a diff rather than a tracked change in a binary.

| File | What it is |
|---|---|
| `engine.js` | The OOXML writer: styles, headings, tables, callouts, code blocks, figures, table of contents |
| `images.js` | Where the two figures come from, and their pixel dimensions |
| `content-move.js` | The Move Archived Logs document, as an array of blocks |
| `content-remove.js` | The Remove Old Archived Logs document, likewise |
| `build.js` | Stages one document's package parts into `stage-<name>/` |
| `build.ps1` | Runs the staging, then zips each into a `.docx` and validates it |

## Two things to know before editing

**Backslashes are written as `¦`.** The content modules use the broken-bar character
wherever a backslash belongs, and `engine.js` swaps it back at render time. This keeps UNC
paths readable in the source and stops them being mangled by any shell or editor in
between. Write `¦¦fileserver¦archived-logs`, not the real thing.

**Inline markup is `**bold**` and `` `code` ``, and it nests.** Bold containing code is
parsed recursively, so `**the `psHost` attribute**` renders correctly. A missing closing
marker is left as literal text rather than throwing, so proof-read the output — `build.ps1`
does not check for it, but the paragraph count and a look at the file will show it.

## Zip ordering matters

`[Content_Types].xml` must be the **first entry** in the archive. `build.js` writes an
`.order.txt` naming every part in the order it must be added, and `build.ps1` follows it.
`Compress-Archive` and `ZipFile.CreateFromDirectory` do not guarantee that order, which is
why neither is used.

Each build reads the finished file back through `System.IO.Packaging`, the same OPC layer
Word uses, and fails if the package will not open or a relationship does not resolve.
