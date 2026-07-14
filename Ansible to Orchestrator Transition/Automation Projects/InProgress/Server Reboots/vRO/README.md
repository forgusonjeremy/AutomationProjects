# Server Reboot Automation — VCF Orchestrator

Migration of the Ansible `servers_reboot.yml` playbook (WinRM + PowerShell
`Invoke-ServerReboot`) to native VCF Orchestrator. **Simple, resilient, reportable.**

## What it does

Reboots the servers listed in an **AD group** via **graceful VMware Tools guest
reboots** through vCenter. The parent launches **one asynchronous child workflow
per server** (sequentially, with a delay between each launch), then monitors every
child run to completion and emails a consolidated report.

- **No WinRM, no Kerberos, no per-server credentials.** vCenter does the reboot.
- **Never hard-boots.** Only `rebootGuest()` is ever called. No Tools running → the
  server is **skipped**, not reset. Forced-power-off corruption is impossible.
- **Async per-server tracking.** Each reboot+return is tracked by its own child run;
  the parent aggregates only after all children reach a terminal state.
- **Continue-on-failure.** One bad server never aborts the run.
- **Confirmed reboots.** Each host must go down and return (Tools + heartbeat) within
  `postRebootTimeoutSec` (default 600s), else `FAILED / NOT_RETURNED`.

## Design at a glance

```
Invoke-ServerReboot  (PARENT / orchestrator)
  1. AD group (authoritative list)
       └─ resolveVm  →  SearchIndex.findByDnsName across ALL vCenters (Tools DNS)
                        ↳ lazy name-index fallback (reporting precision only)
  2. LAUNCH (sequential, delay between each):
       └─ rebootWorkflow.execute(...)  → async child token, one per resolvable VM
             Reboot-And-Track-Server (CHILD):
               precheckReboot → rebootGuestSafe → waitForGuestBack → OUTPUT result
       unresolvable members → recorded SKIPPED directly (no child)
  3. MONITOR: poll every child token.state until ALL terminal
             (completed / failed / canceled)
  4. AGGREGATE child results → buildHtmlReport → email mailTo[] (+ mailCc[])
```

Every server ends in exactly one bucket with a specific `reason`
(`REBOOTED`, `NOT_RETURNED`, `TOOLS_NOT_RUNNING`, `POWERED_OFF`, `NO_VM`,
`AMBIGUOUS_MATCH`, `REBOOT_ERROR`, `UNEXPECTED_ERROR`, `CHILD_FAILED`,
`CHILD_CANCELED`, `MONITOR_TIMEOUT`).

### Why the child never throws on a failed reboot
The child **completes** in all handled cases, carrying a structured `result`. A
*failed* workflow run may not bind its output parameters, so the parent could not
reliably read a reason from it. Instead the child encodes SUCCESS/FAILED/SKIPPED in
`result`, and the parent's monitor still treats `failed`/`canceled` as terminal and
synthesizes a FAILED entry from `token.exception` for any child that dies
unexpectedly. Result: "ended in success *or* failure" is fully covered, with
accurate reporting.

## Components

| File | vRO object | Type |
|---|---|---|
| `actions/getAdGroupComputers.js` | `com.corp.serverreboot/getAdGroupComputers` | Action |
| `actions/resolveVm.js` | `com.corp.serverreboot/resolveVm` | Action |
| `actions/buildVmNameIndex.js` | `com.corp.serverreboot/buildVmNameIndex` | Action |
| `actions/precheckReboot.js` | `com.corp.serverreboot/precheckReboot` | Action |
| `actions/rebootGuestSafe.js` | `com.corp.serverreboot/rebootGuestSafe` | Action |
| `actions/waitForGuestBack.js` | `com.corp.serverreboot/waitForGuestBack` | Action |
| `actions/buildHtmlReport.js` | `com.corp.serverreboot/buildHtmlReport` | Action |
| `workflow/Reboot-And-Track-Server.main.js` | `Reboot-And-Track-Server` | Workflow (CHILD) |
| `workflow/Invoke-ServerReboot.main.js` | `Invoke-ServerReboot` | Workflow (PARENT) |

## Child workflow — `Reboot-And-Track-Server`

| Input | Type | Notes |
|---|---|---|
| `vm` | `VC:VirtualMachine` | resolved by the parent |
| `adName` | string | for reporting |
| `fqdn` | string | for reporting |
| `postRebootTimeoutSec` | number | e.g. 600 |
| `pollIntervalSec` | number | e.g. 15 |
| **Output** `result` | `Properties` | `{adName,fqdn,matchedVmName,status,reason,message,elapsedSec,timestamp}` |

## Parent workflow — `Invoke-ServerReboot`

| Old Ansible var | Parent input | Notes |
|---|---|---|
| `var_ADGroupMember` | `adGroupName` | source of truth |
| *(new)* | `rebootWorkflow` (`Workflow`) | reference to `Reboot-And-Track-Server` |
| `var_RebootIt_DelayBetweenServer` | `interServerDelaySec` | delay **between launches**, default 10 |
| *(new)* | `postRebootTimeoutSec` | default 600 (10 min) |
| *(new)* | `pollIntervalSec` | child down/up poll, default 15 |
| *(new)* | `monitorPollSec` | parent state-poll cadence, default 15 |
| *(new)* | `overallTimeoutSec` | safety cap; 0 = wait indefinitely |
| `var_eMailReport` | `emailReport` (boolean) | default true |
| `var_SMTPServer` | `smtpServer` | |
| *(new)* | `mailFrom` | e.g. `vro-reboots@corp.local` |
| `var_MailToString` | `mailTo` (**Array/string**) | recipients array |
| `var_MailCcString` | `mailCc` (**Array/string**) | optional |
| `var_MailSubjectstring` | `mailSubject` | |
| `var_HeaderNotesSubstr` | `headerNote` | report header |
| `var_DomainName`, `var_OUPath` | *(dropped)* | AD plugin uses membership directly |
| `var_ps_*`, `var_parameter_action`, `var_RebootIt`, `var_cleanup_temporary_folder` | *(dropped)* | no script delivery |

**Parent outputs:** `results` (Array/Properties audit record), `reportHtml` (string),
`summary` (string).

## Import / build steps

1. **Action module** `com.corp.serverreboot` — add each action with the input
   signature in its JSDoc (types: `string`, `number`, `boolean`,
   `VC:VirtualMachine`, `Array/Properties`).
2. **Child workflow** `Reboot-And-Track-Server` — inputs + `result` output above;
   paste `Reboot-And-Track-Server.main.js` into one scriptable task, bind params.
3. **Parent workflow** `Invoke-ServerReboot` — inputs + outputs above; paste
   `Invoke-ServerReboot.main.js`. Set the `rebootWorkflow` input's default to the
   child workflow so operators don't pick it each run.
4. **Plugins** — register all target vCenters (reachable via
   `VcPlugin.allSdkConnections`); configure the Active Directory plugin host.
5. **Mail** — Orchestrator appliance must reach `smtpServer` with relay permitted.

## Validate before go-live (do not skip)

1. **AD plugin member enumeration (non-recursive)** — `getAdGroupComputers.js` is the
   one version-sensitive spot. Confirm in the vRO **API Explorer** how your AD plugin
   lists a group's **direct computer** members. **Requirement:** process only
   TOP-LEVEL computer accounts — do **not** expand nested sub-groups. Both code paths
   are strictly direct-membership; if you swap in a different method, verify it does
   not recurse (never use the `1.2.840.113556.1.4.1941` chain matching rule).
   Downstream only needs `{cn, dnsHostName}`.
2. **`WorkflowToken.getOutputParameters()` shape** — the parent's `readChildResult`
   handles both `Properties` and `Attribute[]`; confirm which your version returns
   and that `result` is readable after `completed`.
3. **`token.state` values** — confirm terminal states are `completed` / `failed` /
   `canceled` in your version (the monitor keys on these).
4. **vCenter permission** — Orchestrator's vCenter account needs
   `VirtualMachine.Interact.Reset` on targets, or `rebootGuest()` throws.
5. **`guest.hostName` shape** and **property freshness** in `waitForGuestBack`
   (Tools status / heartbeat refreshing across polls).

## Testing (recommended order)

1. **Resolver dry-run** — point the parent at the real group but temporarily give it
   a child that only logs its inputs; confirm each member resolves to the right VM
   and correct SKIP reasons for no-VM/ambiguous.
2. **Single server** — group of one test VM; confirm child SUCCESS and parent
   aggregation/report.
3. **Concurrency/stagger** — group of 3–4; confirm launches are spaced by
   `interServerDelaySec` while children run in parallel, and the parent waits for all.
4. **Negative cases** — powered-off (`SKIPPED/POWERED_OFF`), Tools stopped
   (`SKIPPED/TOOLS_NOT_RUNNING`), bogus AD entry (`SKIPPED/NO_VM`), slow boot with a
   low `postRebootTimeoutSec` (`FAILED/NOT_RETURNED`).
5. **Email** — `mailTo` array of 2+ addresses; confirm HTML renders and all receive it.

## Operational considerations / known risks

- **Runtime** — reboots now run **concurrently** (tracking is async), so wall-clock is
  roughly `postRebootTimeoutSec` + launch stagger, not `N × timeout`. Bounded by the
  vCenter/guest boot time, not serialized waiting.
- **Thread usage** — each child holds a workflow thread while polling
  (`System.sleep`). For very large groups, add a launch-window / max-in-flight cap in
  the parent's launch loop (the token list makes this a small change).
- **`overallTimeoutSec`** — leave 0 to always wait for every child; set a cap if you
  need a hard bound (remaining children are reported `MONITOR_TIMEOUT`, not silently
  dropped).
- **Scope** — only VMs in registered vCenters are reboot-eligible; physical /
  off-vCenter hosts report `SKIPPED/NO_VM` by design.
- **Scheduling** — on-demand today; attach the vRO scheduler for recurring runs.
```
