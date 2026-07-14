# Configuration Element — WindowsLogManagement-Config

**Deliverable:** Remove-OldFiles-UNCShare
**Project:** Ansible → VCF Orchestrator transition — "Move Windows Event Logs"
**Platform:** VCF Automation 9 / VCF Operations Orchestrator 9
**Path:** `VCF/WindowsLogManagement/WindowsLogManagement-Config`

Create this Configuration Element in the vRO Configuration tab **before** deploying
the Remove-OldFiles-UNCShare workflow.

> **Scope:** this element is used **only by Remove-OldFiles-UNCShare**. The separate
> Move-ArchivedLogs-ByADGroup deliverable does **not** use this element (its inputs
> use defaults set directly on each input). Do not recreate the retired move-only
> attributes (`defaultDomainName`, `defaultFileShareTarget`, `defaultFileFilter`,
> `defaultFileAgeDays`).

---

## Prerequisite

The PS host must be built, its certificate trusted by Orchestrator, and the host
registered in vRO **before** the workflow that consumes this element can run. Full
procedure is in the shared **"How to Build a PowerShell Host"** guide (WinRM HTTPS
5986, Base-64/PEM cert import to the SSL Trust Manager, authentication, host
registration).

---

## Attributes

| Attribute | Type | Example | Description |
|---|---|---|---|
| `defaultScriptPath` | string | `C:\PSO\Scripts\cvs_functions.ps1` | Full path to `cvs_functions.ps1` on the PS host. Supplies the `scriptPath` default. Must match the deployed path exactly (verify: `Test-Path '<path>'`) |
| `defaultLogRetentionDays` | number | `370` | Default retention age. Files older than this many days are deletion candidates (subject to `whatIf`). `370` ≈ 13 months. **Minimum enforced: 1.** Maps to `-OlderThanDays` |

No attribute exists for `whatIf` — it is set on the workflow custom form with a
default of `yes` and a `yes` / `no` dropdown. Operators must explicitly change it to
`no` to delete files (see the `whatIf` note below).

---

## How to create in the vRO UI

1. Open **vRO → Configuration** tab.
2. Navigate to (or create) folder: `VCF / WindowsLogManagement`.
3. Click **New Configuration Element**. Name: `WindowsLogManagement-Config`.
4. Add each attribute (Add attribute → Name, Type, Value):
   - `defaultScriptPath` (string)
   - `defaultLogRetentionDays` (number)
5. **Save.**

---

## How to bind to the workflow inputs (Remove-OldFiles-UNCShare)

For each input that has a Config Element default:

1. Open **Remove-OldFiles-UNCShare** → **Edit → Inputs**.
2. Select the input (e.g. `scriptPath`).
3. In **Default value**, click the binding icon.
4. Select **Configuration Element → `VCF/WindowsLogManagement/WindowsLogManagement-Config`**.
5. Select the matching attribute (e.g. `defaultScriptPath`).
6. **Save.**

The custom form pre-populates the field with the Config Element value; the operator
can override it at run time.

---

## Workflow-to-attribute mapping

| Workflow | Input | Config Element attribute |
|---|---|---|
| Remove-OldFiles-UNCShare | `scriptPath` | `defaultScriptPath` |
| Remove-OldFiles-UNCShare | `olderThanDays` | `defaultLogRetentionDays` |

`uncSharePath` and `whatIf` are **not** bound to this element: `uncSharePath` is a
per-run value with no default; `whatIf` defaults to `yes` on the custom form.

---

## whatIf behaviour (context)

The `Delete-OldFiles-UNC-Share` switch in `cvs_functions.ps1` maps:
- `whatIf='yes'` → `Remove-OldFiles-UNCPath … -ReportOnly $true` (lists candidate
  files, deletes nothing, runs non-interactively).
- `whatIf='no'` → `… -Force $true` (live delete, no prompt).

This requires the **updated `cvs_functions.ps1`** with `-ReportOnly` (change S-1)
deployed on the PS host. On an older (un-patched) script, `whatIf='yes'` hits a
blocking `Read-Host` prompt under vRO — confirm `-ReportOnly` is present (Validation
Plan A11). Deletions are permanent; `whatIf` is the sole safety control.
