# Change Register — Server Reboot Report (vRO)

Records every deliberate change made transitioning the Ansible pending-reboot report
to the vRO **Get Server Reboot Report** workflow. `R-#` = change; `P-#` = process/design
decision.

## Source (Ansible) being transitioned
Two report playbooks in `InProgress/psscript/Servers Reboot Report by CN/`, both
**read-only** (no reboot):

| Playbook | vars | Script action | Group input | Resolver |
|---|---|---|---|---|
| `servers_reboot_report-ByCN.yml` | `variables.txt` | `Get-ServerRebootReportStatus-ByCN` | `-SecurityGroup_CN` (DN) | `Get-ListOfServers-ByCN` — recursive, filtered |
| `servers_pending_reboot_report.yml` | `vars.txt` | `Get-ServerPendingRebootStatus` | `-ADGroupMember` (name) | `Get-ListOfServers` — non-recursive, **unfiltered** |

Both then: resolve → `Get-RebootStatus` (remote WMI/registry/SCCM) → count pending →
`GenerateReportServerPendingRebootStatus` (HTML + optional mail).

**Behaviours preserved deliberately**
- Read-only — no server is ever rebooted.
- Pending state is determined by remote WMI/registry (CBS `RebootPending`, WU
  `RebootRequired`, SCCM `DetermineIfRebootPending`).
- Mail is gated by `-eMailReport`.

## Changes to targeting / resolver

| # | Area | Change | Reason | Impact |
|---|------|--------|--------|--------|
| **R-1** | Report action | Consolidate **both** Ansible variants onto **`Get-ServerRebootReportStatus-ByCN`** (resolver `Get-ListOfServers-ByCN`: **recursive**, `objectClass -eq 'computer'`, `Enabled -eq $true`, per-object `try/catch`, group-level failure terminates). The legacy `Get-ServerPendingRebootStatus` / `Get-ListOfServers` path is **not** used by the workflow. | One hardened lookup for both use cases. Recursion is correct for a **read-only** report — expanding a nested group only makes the picture more complete, never triggers an action (the deliberate opposite of Invoke-ServerReboot / S-7, which stays non-recursive because rebooting is destructive). | **Behaviour change for the customer's former `-ADGroupMember` report:** nested sub-groups are now expanded; disabled / non-computer members are now excluded. Validate group membership before cutover. No change to `cvs_functions.ps1` — the ByCN action already existed. |

## Changes to `cvs_functions.ps1` (shared script)

| # | Function | Change | Reason | Deployment impact |
|---|----------|--------|--------|-------------------|
| **R-2** | `SendMail` | **CC made optional.** `Send-MailMessage` now built via splatting; `-Cc` is included **only** when a real recipient survives filtering (blank/whitespace entries from `$MailCcString.split(',')` are dropped and trimmed). Attachments handled the same way. | **Defect.** An empty `-MailCcString` yields `@('')`, and `Send-MailMessage -Cc @('')` throws *"Cannot validate argument on parameter 'Cc'."* — which failed **every** emailed report, not just this workflow's. | Redeploy `cvs_functions.ps1` to the PS host. Applied to **both** repo copies (InProgress and `Completed/_Shared References`). Backward-compatible when a CC is present. |
| **R-3** | mail defaults / `$Global:MailFrom` | Lab-domain standardization **`corp.local` → `vcf.lab`** in script defaults and the derived FROM address. | Align delivered artifacts with the lab/test domain. | The `@<domain>` is environment-specific — customers must set it to their domain (Implementation Guide §2). |
| **R-5** | `SendMail` + `GenerateReportServerPendingRebootStatus` | **Prevent report-file accumulation on the PS host.** Two parts: (a) `ServerPendingRebootStatus_result.html` is now written with **overwrite** (was `-append`), bounding it to a single run's size; (b) `SendMail` sets `$Global:MailSent`, and the report function **deletes** both generated HTML files (`…\ServerPendingRebootStatus_result.html` and the per-run `Report.html`) after a **confirmed successful send**. On a report-only run (`eMailReport=no`) or a failed send, the file is kept (single-run size) and a `Warn:` is logged. | The result file was written in **append** mode and grew every run — a drive-fill risk on the PS host, with no guarantee that a scheduled external cleanup exists. Overwrite bounds worst case to one file; post-email delete leaves nothing after an emailed run. | Redeploy `cvs_functions.ps1`. Applied to **both** repo copies. Uses a new `$Global:MailSent` flag — `SendMail`'s return contract is unchanged, so other callers are unaffected. |

## New vRO action

| # | Component | Change | Reason |
|---|-----------|--------|--------|
| **R-4** | Action **buildServerRebootReportInvocation** (`com.broadcom.pso.vcf.vm.guestOps.windows.reboot`) | New action that builds the validated PowerShell invocation for `Get-ServerRebootReportStatus-ByCN`. Notables: **derives `-HeaderNotesSubstr` from `groupDN`** (not a separate input); **`toCsv` recipient normalization** accepts an Array or a CSV string; **char-split guard** throws on a recipient token with no `@`; single-quote `psQuote` escaping; DN nudge; email-opt-in validation; `*>&1 \| Out-String -Width 4096` stream capture so the vRO plug-in returns the transcript to `parseScriptOutput`. | One validated builder; removes a redundant header input; robust to how `mailTo`/`mailCc` are typed; guarantees the plug-in can parse the output. |

## Process / design decisions

| # | Decision | Notes |
|---|----------|-------|
| **P-1** | **Log marker** via `System.setLogMarker("Workflow:" + workflow.name + "-WorkflowRunId:" + workflow.id)` in the root **Set Log Marker** task. | `workflow.id` returns the **run (token) id** in this vRO version (confirmed by run logs: per-run GUID ≠ workflow definition id). vRO then prepends the marker to every log line in the run. |
| **P-2** | **PowerShell host is a pre-bound workflow *attribute* (`host`), not an input.** | Re-point it per environment in the workflow (Implementation Guide §4). Removes a per-run selection and a mandatory input. |
| **P-3** | **`mailTo` / `mailCc` are `Array/string`.** | Enter one address per element. Binding a scalar string into an Array input makes vRO char-split it — the R-4 guard converts that silent corruption into a clear error. |
| **P-4** | **No `rebootMode` / safety gate, no delay/verify inputs.** | The workflow is read-only; there is nothing to gate. |
| **P-5** | **Failure path is a `Throw Error` task** (`throw err_0`) on the PS-link catch → End. | Simpler than a dedicated handler; a terminating PS failure surfaces as a Failed end state. Per-server read failures are non-terminating and land in Completed with Errors. |

## As-built reference
- Workflow: **Get Server Reboot Report**, id `9fe2e6c5-0186-45a8-94c2-575c926836e9`.
- Reused dependency: `parseScriptOutput` from `com.broadcom.pso.vcf.vm.guestOps.files.windows.logs`.
- Full schema and per-task code: `Code/Get-ServerRebootReport_spec.js`.
