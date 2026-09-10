# As Deployed — Move Archived Logs

What was actually built, taken from the workflow export. Where this differs from the
Implementation Guide, **this document is the record of what exists** and the guide
describes what to build from scratch.

Export the workflow from Orchestrator itself for a redeployable artifact; this is the
readable summary, not a substitute for it.

---

## Identity

| | |
|---|---|
| **Display name** | `Move Archived Logs By AD Group` |
| **Workflow ID** | `d6f9b6c3-422c-41c7-89b8-6906f89c796d` |
| **Orchestrator** | `cvsd26vcfauto01.connect.lab` |
| **Editor version** | 2.0 |

---

## Inputs

| Name | Type | Form control | Required |
|---|---|---|---|
| `groupDn` | `string` | text field | **No** — see *Known gaps* |
| `olderThanDays` | `number` | decimal, min 0, step 1 | No |
| `reportOnly` | `boolean` | checkbox, **default true** | No |
| `overwriteExisting` | `boolean` | checkbox | No |

The `AD:UserGroup` tree picker described in the User Guide was **not** built. Operators
supply the group's distinguished name as text. The Implementation Guide's optional
decision-element variant is how to add the picker later if it is wanted.

---

## Attributes

| Name | Type | Value as deployed |
|---|---|---|
| `scriptElement` | `ResourceElement` | `4aa3a0c9-57f8-44c6-8371-426d40faad2d` |
| `psHost` | `PowerShell:PowerShellHost` | `0c675c7a-137b-40c3-af36-6f36223dfa59` |
| `logsFilePath` | `string` | `C$\Windows\System32\winevt\Logs` |
| `fileFilter` | `string` | `Archive-*.evtx` |
| `fileServerPath` | `string` | `\\iaaslabdc.vcf.lab\archived-logs` — FQDN, correct |
| `adHost` | `AD:AdHost` | empty; carries element 1 → 2 |
| `adGroup` | `AD:UserGroup` | empty; carries element 2 → 3 |
| `computerNames` | `Array/string` | empty; carries element 3 → 4 |
| `scriptParameters` | `Properties` | empty; carries element 4 → 5 |
| `scriptRunResult` | `Properties` | empty; carries element 5 → 6 |

---

## Outputs

**None declared.** See *Known gaps*.

---

## Schema

Six elements, wired exactly as the Implementation Guide describes.

| # | Item | Element | Module |
|---|---|---|---|
| 1 | `item1` | `findAdHostForDn` | `com.broadcom.pso.vcf.activedirectory` |
| 2 | `item2` | `resolveAdGroup` | `com.broadcom.pso.vcf.activedirectory` |
| 3 | `item3` | `getGroupComputers` | `com.broadcom.pso.vcf.activedirectory` |
| 4 | `item5` | `Create Script Parameters` | scriptable task |
| 5 | `item4` | `runPowerShellScript` | `com.broadcom.pso.vcfa.vm.guestScripting` |
| 6 | `item6` | `Parse Result` | scriptable task |
| — | `item0` | end | |

> The item numbers are not in execution order — `item4` runs fifth and `item5` fourth.
> That is normal; Orchestrator numbers elements as they are created, and the `out-name`
> chain is what defines the order. Read `root-name: item1` and follow `out-name`.

`resolveAdGroup` takes `adHost` as its second input, bound from `findAdHostForDn`'s
output, rather than looking the endpoint up itself. The schema therefore shows that the
same endpoint flowed into both steps.

---

## Known gaps

Neither of these stops the workflow working. Both are worth fixing if it is picked up again.

### 1. No outputs are declared

`Parse Result` assigns `success`, `transcript`, `serversProcessed` and `filesMoved`, but
the workflow declares `output: {}` and the task's OUT tab is empty. The values are
computed and then discarded.

Nothing fails and nothing warns. A parent workflow, a schedule or an API caller gets
nothing back, and the run looks successful with no numbers attached. The transcript is
still visible in the run log, so this matters only when something needs to *consume* the
result.

**Fix:** declare the four outputs on the workflow, then bind them on `Parse Result`'s OUT
tab. `Code/task_ParseResult.js` documents the four.

### 2. `Create Script Parameters` uses the short boolean conversion

As deployed:

```javascript
scriptParameters.put("ReportOnly", reportOnly ? "yes" : "no");
scriptParameters.put("OverwriteExisting", overwriteExisting ? "yes" : "no");
```

**This is correct while the inputs are booleans, which they are.** It is listed here
because it silently stops being correct if either input is ever redeclared as a string:
every non-empty string is truthy in JavaScript, so `"no"` becomes `"yes"` — turning
`OverwriteExisting` on for an operator who turned it off, and pinning `ReportOnly` on so
nothing ever moves. Nothing in the log would say so. That has happened here before.

**Fix:** paste `Code/task_CreateScriptParameters.js`, which uses a `yesNo()` helper that
reads the value rather than testing it for truth, and which also validates the server
list, warns on an IP destination, and rejects the old Ansible `-1` retention.

### 3. `groupDn` is not marked required

The input form has `required: false`, but `resolveAdGroup` cannot run without it. A run
with it empty fails with a clear message rather than doing anything harmful, so this is
cosmetic — but marking it required moves the error to the form, where it belongs.
