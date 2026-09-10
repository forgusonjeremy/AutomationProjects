# As Deployed — Remove Old Archived Logs

What was actually built, taken from the workflow export. Where this differs from the
Implementation Guide, **this document is the record of what exists** and the guide
describes what to build from scratch.

Export the workflow from Orchestrator itself for a redeployable artifact; this is the
readable summary, not a substitute for it.

> **There is one defect to fix before this runs in anger.** See *Defect 1* below. It does
> not delete the wrong files and it does not lose data — it misreports every successful
> run as having done nothing.

---

## Identity

| | |
|---|---|
| **Display name** | `Clean Archived Event Logs from File Share` |
| **Workflow ID** | `b453f157-9cc7-48c5-855e-b1f666141897` |
| **Orchestrator** | `cvsd26vcfauto01.connect.lab` |
| **Editor version** | 2.0 |

The deployed name differs from the name used throughout this package
(*Remove Old Archived Logs*). Same workflow.

---

## Inputs

| Name | Type | Form control | Notes |
|---|---|---|---|
| `olderThanDays` | `number` | decimal, **min 1**, step 1 | The form enforces the retention guard as well as the script |
| `reportOnly` | `boolean` | checkbox, **default true** | |

Only two. Everything else is an attribute, which is the intended shape: an operator checks
two values and submits.

---

## Attributes

| Name | Type | Value as deployed |
|---|---|---|
| `scriptElement` | `ResourceElement` | `3b6aec84-7e78-4f61-b0ec-bc1b1ab8e8f7` |
| `psHost` | `PowerShell:PowerShellHost` | `0c675c7a-137b-40c3-af36-6f36223dfa59` — the same host the move workflow uses |
| `fileFilter` | `string` | `Archive-*.evtx` |
| `fileServerPath` | `string` | `\\iaaslabdc\archived-logs` — **short name, see Defect 2** |
| `scriptParameters` | `Properties` | empty; carries element 1 → 2 |
| `scriptRunResult` | `Properties` | empty; carries element 2 → 3 |

The share path attribute is named `fileServerPath` here, matching the move workflow, not
`sharePath` as earlier drafts of this package called it. The code in `Code/` uses the
deployed name.

---

## Outputs

**None declared.** See *Defect 3*.

---

## Schema

Three elements, wired as the Implementation Guide describes. `root-name` is `item5`.

| # | Item | Element | Module |
|---|---|---|---|
| 1 | `item5` | `Create Script Parameters` | scriptable task |
| 2 | `item4` | `runPowerShellScript` | `com.broadcom.pso.vcfa.vm.guestScripting` |
| 3 | `item6` | `Parse Result` | scriptable task |
| — | `item0` | end | |

No Active Directory anywhere, as intended.

---

## Defect 1 — `Parse Result` reads the move workflow's field names

**This is the one to fix.**

The deployed `Parse Result` is the move workflow's task, pasted in unchanged:

```javascript
serversProcessed = reported.get("serversProcessed");
filesMoved       = reported.get("moved");
...
System.log("Finished. " + filesMoved + " file(s) across " + serversProcessed + " server(s).");
```

`Remove-OldArchivedLogs.ps1` does not report any of those. It reports:

| Reported by the remove script | Reported by the move script |
|---|---|
| `matched`, `deleted`, `freedMB` | `serversProcessed`, `serversRequested`, `moved`, `skipped` |
| `reportOnly`, `errorCount`, `errors` | `reportOnly`, `errorCount`, `errors` |

So `serversProcessed`, `moved` and `serversRequested` all come back **null**, and every
successful run logs:

```
Finished. null file(s) across null server(s).
```

Nothing throws and nothing warns. A run that correctly deleted four hundred files reports
`null`, and a run that deleted nothing reports `null` too — the log cannot tell them
apart. The transcript still holds the truth, so this is a reporting defect rather than a
destructive one, but it makes the workflow's own output worthless.

**Fix:** replace the `Parse Result` script with `Code/task_ParseResult.js`. It reads
`deleted`, `freedMB` and `matched`, reports report-only and live runs differently, and
carries a header explaining why the two workflows' tasks cannot be swapped.

---

## Defect 2 — the share is addressed by short name, not FQDN

Deployed: `\\iaaslabdc\archived-logs`
Move workflow: `\\iaaslabdc.vcf.lab\archived-logs`

This is **not** the IP-address trap — a short host name usually has a Kerberos SPN
registered alongside the FQDN one, so this will normally authenticate and work.

It is still worth aligning:

- It depends on the DNS suffix search order resolving `iaaslabdc` to the right host, which
  is an assumption about client configuration rather than a statement of intent
- In a multi-domain estate a short name is ambiguous where an FQDN is not
- The two workflows now point at the same share by two different names, so a search for
  one will not find the other

**Fix:** set `fileServerPath` to `\\iaaslabdc.vcf.lab\archived-logs`, matching the move
workflow. Test 4.4 in the Testing Plan covers the IP case; this one just needs changing.

---

## Defect 3 — no outputs are declared

`Parse Result` assigns `success` and `transcript`, but the workflow declares `output: {}`
and the task's OUT tab is empty. The values are computed and discarded.

Nothing fails and nothing warns. A schedule or an API caller gets nothing back. Given that
this workflow deletes files, being able to read `filesDeleted` and `spaceFreedMB` from a
scheduled run afterwards is worth having.

**Fix:** declare `success`, `filesDeleted`, `spaceFreedMB`, `filesMatched` and
`transcript` as workflow outputs, then bind them on `Parse Result`'s OUT tab.
`Code/task_ParseResult.js` assigns all five.

---

## What is correct, and worth not breaking

- `Create Script Parameters` **is** this package's task, adapted properly — it validates
  the path, warns on an IP address before the share is touched, uses the `yesNo()` helper
  rather than `? :`, and refuses a retention below 1
- `reportOnly` defaults to true, and the form enforces `min-value: 1` on the retention
- `psHost` and `scriptElement` are bound attributes, so nothing is looked up by name
- Only `runPowerShellScript` is called as an action, and it is the shared one
