# Build & Binding Sheet — Server Reboot Automation (vRO client)

Implementation-ready reference for building the module, actions, and both
workflows by hand in the VCF Orchestrator client. Types are vRO parameter types.
Launch model: **unlimited concurrency** (children staggered by `interServerDelaySec`,
no in-flight cap).

Build order: **1) Action module → 2) Child workflow → 3) Parent workflow.**

---

## 1) Action module: `com.corp.serverreboot`

Create the module, then add each action with the exact name, inputs, and return
type below. Paste the matching file from `actions/` as the script body.

| Action | Inputs (name : type) | Return type |
|---|---|---|
| `getAdGroupComputers` | `adGroupName : string` | `Array/Properties` |
| `buildVmNameIndex` | *(none)* | `Array/Properties` |
| `resolveVm` | `dnsHostName : string`, `cn : string`, `nameIndex : Array/Properties` | `Properties` |
| `precheckReboot` | `vm : VC:VirtualMachine` | `Properties` |
| `rebootGuestSafe` | `vm : VC:VirtualMachine` | `Properties` |
| `waitForGuestBack` | `vm : VC:VirtualMachine`, `timeoutSec : number`, `pollIntervalSec : number`, `downConfirmSec : number` | `Properties` |
| `buildHtmlReport` | `results : Array/Properties`, `headerNote : string` | `string` |

Notes:
- `resolveVm` returns `{ vm:VC:VirtualMachine, matchedBy:string, ambiguous:boolean }`
  inside a `Properties` (a Properties can carry a plugin object — this survives being
  passed into an async child `execute()`).
- All `Properties` result objects use string keys shown in each action's JSDoc.

---

## 2) Child workflow: `Reboot-And-Track-Server`

One async unit of work per server. Script body = `workflow/Reboot-And-Track-Server.main.js`
in a single scriptable task.

### Input parameters
| Name | Type | Default | Notes |
|---|---|---|---|
| `vm` | `VC:VirtualMachine` | — | resolved by the parent |
| `adName` | `string` | — | for reporting |
| `fqdn` | `string` | — | for reporting |
| `postRebootTimeoutSec` | `number` | `600` | down→up budget |
| `pollIntervalSec` | `number` | `15` | Tools/heartbeat poll cadence |

### Output parameters
| Name | Type | Notes |
|---|---|---|
| `result` | `Properties` | `{adName,fqdn,matchedVmName,status,reason,message,elapsedSec,timestamp}` |

### Scriptable task bindings (single element)
- **IN:**  `vm`, `adName`, `fqdn`, `postRebootTimeoutSec`, `pollIntervalSec`
- **OUT:** `result`  (bind directly to the workflow output parameter)

No workflow attributes are required — the script reads inputs and writes the one output.

---

## 3) Parent workflow: `Invoke-ServerReboot`

Orchestrator. Script body = `workflow/Invoke-ServerReboot.main.js` in a single
scriptable task.

### Input parameters
| Name | Type | Default | Required | Notes |
|---|---|---|:--:|---|
| `adGroupName` | `string` | — | ✔ | e.g. `Security-Reboot-Servers` |
| `rebootWorkflow` | `Workflow` | **set to `Reboot-And-Track-Server`** | ✔ | child reference |
| `interServerDelaySec` | `number` | `10` |  | delay **between launches** |
| `postRebootTimeoutSec` | `number` | `600` |  | passed to child |
| `pollIntervalSec` | `number` | `15` |  | passed to child |
| `monitorPollSec` | `number` | `15` |  | parent state-poll cadence |
| `overallTimeoutSec` | `number` | `0` |  | 0 = wait indefinitely |
| `emailReport` | `boolean` | `true` |  | send the HTML report |
| `smtpServer` | `string` | `mailrelay.corp.local` |  | |
| `mailFrom` | `string` | `vro-reboots@corp.local` |  | |
| `mailTo` | `Array/string` | — |  | recipients (array of strings) |
| `mailCc` | `Array/string` | — |  | optional |
| `mailSubject` | `string` | `VCF Orchestrator: Server Reboot Report` |  | |
| `headerNote` | `string` | `Security-Reboot-Servers` |  | report header note |

### Output parameters
| Name | Type | Notes |
|---|---|---|
| `results` | `Array/Properties` | structured audit record (all servers) |
| `reportHtml` | `string` | rendered report |
| `summary` | `string` | e.g. `Total 12 | Success 10 | Failed 1 | Skipped 1` |

### Scriptable task bindings (single element)
- **IN:**  `adGroupName`, `rebootWorkflow`, `interServerDelaySec`,
  `postRebootTimeoutSec`, `pollIntervalSec`, `monitorPollSec`, `overallTimeoutSec`,
  `emailReport`, `smtpServer`, `mailFrom`, `mailTo`, `mailCc`, `mailSubject`,
  `headerNote`
- **OUT:** `results`, `reportHtml`, `summary`  (bind directly to workflow outputs)

### Presentation (input form) — recommended
- **Mandatory:** `adGroupName`, `rebootWorkflow`.
- **Group "Timing":** `interServerDelaySec`, `postRebootTimeoutSec`, `pollIntervalSec`,
  `monitorPollSec`, `overallTimeoutSec`.
- **Group "Reporting":** `emailReport`, then `smtpServer`, `mailFrom`, `mailTo`,
  `mailCc`, `mailSubject`, `headerNote`.
- Optional: show the Reporting mail fields only when `emailReport == true`
  (presentation property "Display" / conditional visibility).

---

## Wiring diagram

```
Invoke-ServerReboot (parent)
  IN  adGroupName, rebootWorkflow, timing*, reporting*
  │
  ├─ scriptable task "orchestrate"
  │     getAdGroupComputers ─┐
  │     resolveVm / buildVmNameIndex (lazy)
  │     rebootWorkflow.execute(vm, adName, fqdn, timeouts)  ──async──►  Reboot-And-Track-Server (child)
  │     poll token.state until terminal                                   IN vm, adName, fqdn, timeouts
  │     readChildResult(token) ◄──────────────────────────────────────── OUT result (Properties)
  │     buildHtmlReport → EmailMessage.sendMessage()
  │
  OUT results, reportHtml, summary
```

## Pre-flight checklist (mirror of README "Validate before go-live")
- [ ] AD plugin host configured; `getAdGroupComputers` returns **direct computer**
      members only (non-recursive) — validate the method names in API Explorer.
- [ ] All target vCenters registered (`VcPlugin.allSdkConnections`).
- [ ] vCenter service account has `VirtualMachine.Interact.Reset` on targets.
- [ ] `rebootWorkflow` input default points at `Reboot-And-Track-Server`.
- [ ] `WorkflowToken.getOutputParameters()` return shape and `token.state` terminal
      values confirmed for your vRO version.
- [ ] Orchestrator appliance can reach `smtpServer` (relay permitted).
- [ ] Test path run (single VM) green before running against the full AD group.
```
