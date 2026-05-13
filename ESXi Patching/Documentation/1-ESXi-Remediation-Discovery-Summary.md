# ESXi Remediation Workflow — Discovery Phase Summary
**Project**: Automated ESXi Host Patching via VCF Automation 9 Service Catalog  
**Reference**: Dell KB 000345284 (VxRail manual ESXi patching — bypassed in Dell-supported fashion)  
**Phase**: Discovery Complete → Architecture Phase Next  
**Document Purpose**: Full context transfer for architecture phase

---

## 1. Platform & Environment

| Item | Value |
|------|-------|
| Automation Platform | VCF Automation 9 (embedded Orchestrator) |
| Orchestrator | Embedded vRO (identical between vRA 8.x and VCF 9) |
| Target ESXi Version | 8.0 U3 |
| vCenter Version | vSphere 8 |
| Cluster Types | vSAN (VxRail-managed) + VMFS (PowerFlex) |
| SDDC Manager | Not in scope — hosts are NOT VCF-managed workload domains |
| VxRail Manager | Present but bypassed — this is an out-of-band patching method per Dell KB |

---

## 2. Confirmed Requirements

### Concurrency & Locking
1. Only a single host per cluster remediated at a time (serial within cluster)
2. Multiple clusters can run in parallel (across vCenters and within the same vCenter)
3. Only one active "Remediate ESXi Cluster" workflow per cluster at any time — no concurrent runs against the same cluster
4. Multiple clusters within the same vCenter can be remediated concurrently
5. **Lock store**: vRO Configuration Elements (with `LockingSystem.lockAndWaitFor` around read-modify-write to prevent race conditions)

### Host Remediation Rules
6. Host must be confirmed reconnected to vCenter (polled) before proceeding
7. Host must be returned to pre-remediation state (except patch installed) before next host is touched
8. Patch must be compatible with ESXi version on cluster hosts (precheck)
9. Cluster must remain in a supported state throughout — no violating vSAN FTT or HA admission control thresholds at any point
10. If a host is **already in Maintenance Mode** at workflow start: skip it, include in final report
11. If a **pinned VM** (DRS rules, host-affinity, vTPM, PCI passthrough) blocks MM entry: auto-fail that host, do not attempt mitigation
12. **vCLS**: ESXi 8.0 U3 uses embedded vCLS (no VMs); retreat mode not needed. If legacy vCLS VMs are found on target host (upgraded-from-7.x edge case), log warning and proceed — vSphere will migrate/recreate

### Safety & Supported State Rules
- **vSAN clusters**: FTT headroom must support one host in MM before entering MM
- **VMFS/PowerFlex clusters**: Rely on HA admission control thresholds; no storage-side checks
- **HA admission control settings**: Must NOT be changed — precheck must validate sufficient headroom exists before proceeding
- **DRS**: No changes to DRS automation level; rely on DRS to evacuate VMs
- **3-node vSAN clusters**: Hard block by default; requires explicit user override flag on form

### Failure & Rollback
- On any failure: reverse all changes made to enable/conduct remediation (see Rollback Scope below)
- If changes cannot be reversed OR host is in an unrecoverable state (not connected to vCenter, HA cannot be re-enabled): **immediately send email alert** AND include in final report
- If cluster cannot continue (e.g., 4-node vSAN FTT1 with a host that failed to come back online): halt cluster remediation, do not proceed to next host

### Rollback Scope (per host, on failure)
1. Remove temporary local account created on the host
2. Remove Admin permission assigned to that account
3. Stop SSH + ESXi Shell services on host
4. Exit Maintenance Mode (attempt)
5. Verify HA agent re-enabled on host (`dasHostState.state == connectedToMaster`)
6. If HA fails to re-enable: **immediately send email**, flag host in report
7. Release cluster lock

---

## 3. Patch Source & Install Method

### Patch Format
- **Offline bundle ZIP** hosted in a **Content Library within each vCenter**
- Bundles are pre-staged (not subscribed-on-demand) in the Content Library
- Bundle accessible from hosts via datastore path (`/vmfs/volumes/<ds>/contentlib-<uuid>/...`)

### Install Method: ESXi CLI via Temporary Local Account (Option C)
Dell KB requires `esxcli software vib install` from ESXi shell. No ESXi root passwords are known. Resolution:

1. **Enable SSH + ESXi Shell** on target host via vCenter (`HostServiceSystem.StartService`)
2. **Create temporary local user** (`vcf-remediation-<runId>`) with a strong randomly-generated password via `HostLocalAccountManager.CreateUser` (vCenter-mediated, no root required)
3. **Grant Admin role** on host via `AuthorizationManager.SetEntityPermissions`
4. **SSH from vRO** (vRO SSH Plugin) to host using temp account credentials
5. **Resolve bundle datastore path** via Content Library API → datastore backing path
6. Execute: `esxcli software sources profile list -d <bundle-path>` (validate), then `esxcli software vib install -d <bundle-path>`
7. **Reboot** via vCenter API (`HostSystem.RebootHost_Task`) — not via CLI
8. **Post-reboot cleanup**: delete temp account, remove permission, stop SSH/Shell services

### Patch Compatibility Check
- **Step 1**: Check `PatchCompatibilityMatrix` Configuration Element (key = bundle SHA256, value = JSON `{supportedBuilds:[], lastValidated}`)
- **Step 2**: If no matrix entry found, parse bundle metadata (`metadata.zip` → `vmware.xml` + bulletin XMLs) to extract supported ESXi build numbers
- **Step 3**: Write result back to `PatchCompatibilityMatrix` Configuration Element for future use
- Check is performed against actual host build numbers in the selected clusters

---

## 4. Precheck Requirements (Form-Time, Before Submit)

All prechecks run as **vRO action bindings** on the Service Catalog form. Form gates submit until all checks pass.

| Precheck | Method |
|----------|--------|
| Patch compatible with cluster ESXi builds | Compatibility matrix → bundle metadata fallback |
| Cluster currently locked (active remediation) | Read `ClusterLocks` Config Element |
| vCenter active remediation tasks (vLCM, active MM, DRS evacuations) | vSphere task API scan |
| vSAN FTT headroom: can one host go into MM? | `vSanClusterHealthSystem` + FTT policy query |
| HA admission control headroom: can one host go into MM? | `ClusterComputeResource` admission control config |
| 3-node vSAN: block unless override flag checked | Cluster host count check |
| Host-affinity / pinned VMs present in cluster | DRS rule scan |

---

## 5. Notification & Reporting

- **SMTP relay**: Pre-configured in vRO Mail Plugin (no credentials management needed in workflow)
- **Immediate alerts**: Send email when host enters unrecoverable state (not reconnected to vCenter, HA re-enable failure)
- **Summary report**: Sent at end of workflow run covering all clusters; includes:
  - Hosts successfully patched
  - Hosts skipped (already in MM)
  - Hosts failed (with reason)
  - Hosts in unrecoverable state
  - Clusters where remediation was halted early
  - Rollback actions taken per failed host

---

## 6. Configuration Elements

| Config Element | Path | Purpose |
|---------------|------|---------|
| `ClusterLocks` | `com.company.remediation/ClusterLocks` | Key=clusterMoRef, Value=runId+timestamp; tracks active cluster locks |
| `PatchCompatibilityMatrix` | `com.company.remediation/PatchCompatibilityMatrix` | Key=bundleSHA256, Value=JSON {supportedBuilds, lastValidated} |
| `RemediationDefaults` | `com.company.remediation/Defaults` | Timeouts, retry counts, default SMTP recipients, polling intervals |
| `SMTPConfig` | Pre-configured in vRO Mail Plugin | Not a custom Config Element; use existing vRO mail config |

---

## 7. Workflow Architecture (High-Level)

```
Service Broker Form (Service Catalog)
  └─ vRO Action Bindings: vCenter → Cluster(s) → Bundle → Override flags → Prechecks
         │ (on submit — all prechecks pass)
         ▼
Workflow: Remediate-ESXi-Clusters [PARENT]
  ├─ Validate + acquire cluster locks (Config Element, LockingSystem)
  ├─ Fork: Remediate-ESXi-Cluster [per cluster, PARALLEL]
  │    └─ For each host (SERIAL):
  │         ├─ Pre-host: skip if already in MM (log)
  │         ├─ Pre-host: re-validate FTT/HA headroom
  │         ├─ Pre-host: check for pinned VMs → auto-fail if found
  │         └─ Remediate-ESXi-Host [sub-workflow]
  │              ├─ Enable SSH + ESXi Shell
  │              ├─ Create temp local account + Admin permission
  │              ├─ Enter Maintenance Mode (Ensure Accessibility for vSAN)
  │              ├─ SSH → resolve bundle path → esxcli install
  │              ├─ Reboot via vCenter API
  │              ├─ Poll: wait for reconnect (connectionState=connected, powerState=poweredOn)
  │              ├─ Validate build number incremented
  │              ├─ Exit Maintenance Mode
  │              ├─ Validate HA agent (dasHostState.state = connectedToMaster)
  │              ├─ Cleanup: remove account, permission, stop SSH/Shell
  │              └─ [On any failure]: rollback → log → alert if unrecoverable
  ├─ Aggregate results from all cluster workflows
  ├─ Release all cluster locks
  └─ Send summary email report
```

---

## 8. vRO Actions (Planned — not yet coded)

All actions under `com.company.remediation.actions`:

**Form / Precheck Actions**
- `getVCenters()` → Available vCenter connections
- `getClustersForVcenter(vc)` → Clusters in vCenter
- `getContentLibraryBundles(vc)` → Offline bundle items in CL
- `parseBundleMetadata(vc, libraryItemId)` → Compatible builds, bulletin ID
- `checkCompatibility(bundleHash, clusters)` → Compatible / incompatible split
- `checkClusterLocks(clusters)` → Locked / free split
- `checkClusterSupportability(clusters, override3Node)` → Can remediate / blocked + reasons

**Lock Management**
- `acquireLocks(clusters, runId)` → boolean
- `releaseLocks(clusters, runId)` → void

**Host Operations**
- `enableHostSSH(host)` / `disableHostSSH(host)`
- `createTempHostUser(host, username, password)` / `removeTempHostUser(host, username)`
- `assignAdminRoleOnHost(host, principal)` / `removeRoleOnHost(host, principal)`
- `resolveBundleDatastorePath(vc, libraryItemId, host)` → string (VMFS path)
- `installPatchViaSSH(host, username, password, bundlePath)` → {success, output}
- `rebootHostAndWait(host, timeoutMinutes)` → boolean
- `enterMaintenanceMode(host, evacuationMode, timeout)` / `exitMaintenanceMode(host)`

**Validation**
- `validateHAAgentHealthy(host)` → boolean
- `validateVsanHeadroom(cluster)` → {canRemoveHost: boolean, fttRemaining: int}
- `getHAAdmissionHeadroom(cluster)` → {canRemoveHost: boolean, details}
- `getPinnedVmsOnHost(host)` → VM[] (DRS rules, vTPM, PCI passthrough, host-affinity)
- `getHostBuildNumber(host)` → string

**Reporting**
- `sendMail(recipients, subject, htmlBody)` → void
- `buildSummaryReport(clusterResults[])` → htmlBody string

---

## 9. Service Account Permissions Required

vRO service account in vCenter needs:

| Privilege | Purpose |
|-----------|---------|
| `Host.Config.Maintenance` | Enter/exit MM |
| `Host.Config.Patch` | Patch operations (belt-and-suspenders) |
| `Host.Config.Connection` | Reconnect host |
| `Host.Local.CreateUser` / `RemoveUser` | Temp account lifecycle |
| `Authorization.ModifyPermissions` | Grant/remove Admin role |
| `Host.Config.NetService` | Enable/disable SSH + ESXi Shell |
| `Host.Inventory.EditCluster` | Cluster-level operations |
| `Datastore.Browse` | Resolve CL bundle datastore path |
| `ContentLibrary.ReadStorage` | Read CL item metadata |
| `VirtualMachine.Interact.PowerOff` | Legacy vCLS VM edge case (8.0 < U3) |
| `Global.Licenses` | (Verify not required — document if it is) |

---

## 10. Network Requirements

- vRO appliance must reach **all ESXi management IPs on TCP/22** (SSH)
- Precheck should attempt SSH connect to first host in cluster before bulk run to validate network path

---

## 11. Risk Register

| Risk | Severity | Mitigation |
|------|----------|------------|
| SSH blocked (firewall) between vRO and ESXi | High | Network precheck on form submission |
| Temp account leaked on vRO crash | Medium | Orphan-account sweeper action (on-demand) |
| Config Element race condition (lock acquire) | Medium | `LockingSystem.lockAndWaitFor` around CE read-modify-write |
| MM hangs on pinned VM | High | Auto-detect pinned VMs precheck; auto-fail if found |
| vSAN resync in progress at host exit-MM | Medium | Poll `vSanClusterHealthSystem` resync state; wait up to configured threshold |
| Reboot exceeds expected window | Medium | Configurable timeout (default 30 min); on timeout → mark failed, alert |
| 3-node vSAN cluster | High | Hard block in precheck; explicit override flag on form |
| HA fails to re-enable post-MM-exit | High | Immediate email; host flagged; cluster remediation halts |
| Cluster FTT violated during multi-host failure | High | Re-validate FTT headroom before each host; halt cluster if threshold breached |
| vRO workflow restart mid-run | Low | vRO checkpoints between elements; locks survive in Config Elements |
| Legacy vCLS VMs on upgraded cluster | Low | Log warning; vSphere migrates automatically; no action needed |

---

## 12. Decisions Made (Closed Items)

| Question | Decision |
|----------|----------|
| ESXi shell access without root | Option C: temp local account via `HostLocalAccountManager` (vCenter-mediated) |
| vLCM vs. esxcli | esxcli (Dell KB method); vCenter API not used for install |
| Cluster lock store | vRO Configuration Elements |
| Patch source | Content Library offline bundle ZIP per vCenter |
| Compatibility check | Matrix-first (Config Element), fallback to bundle metadata parse, write-back |
| 3-node vSAN | Hard block + explicit override flag |
| Pinned VMs | Auto-fail host, no mitigation attempted |
| vCLS on host (8.0 U3) | Embedded vCLS — no retreat mode, no VM power-off needed |
| HA admission control | No changes — precheck validates headroom |
| PowerFlex/VMFS storage checks | Rely on HA + DRS; no storage-side API calls |
| Hosts already in MM | Skip + include in report |
| Notification method | Pre-configured SMTP relay via vRO Mail Plugin |
| Service Catalog integration | Service Broker → vRO Content Source; form uses vRO action bindings |
| SDDC Manager | Out of scope |
| Workflow runtime / timeout | vRO has no hard workflow timeout; async pattern acceptable; individual scriptable tasks need timeout raised for SSH install steps |

---

## 13. Open Items for Architecture Phase

1. **vRO workflow structure**: Confirm whether `Remediate-ESXi-Cluster` is a nested workflow or a scheduled action within the parent — nested workflow preferred for clean state isolation and checkpointing
2. **Parallel cluster fork mechanism**: Confirm use of `WorkflowToken` async execution vs. `Workflow.executeInParallel` (vRO 8.x capability)
3. **Service Broker form**: Confirm custom form schema (ABX action vs. vRO action bindings for each field)
4. **Orphan account sweeper**: Define as separate catalog item or admin-only vRO workflow
5. **Report delivery**: Email only, or also written to a datastore/log location?
6. **vRO SSH plugin version compatibility**: Verify `SSHSession` API surface in embedded vRO for VCF Automation 9
7. **Patch staging bandwidth**: Per-host download from CL datastore (confirmed); validate CL datastore is accessible from all host management paths
8. **Build number validation post-reboot**: Compare `HostSystem.config.product.build` before vs. after — confirm field availability in vRO vCenter plugin

---

## 14. Next Phase: Architecture

Deliverables for architecture phase:
- Detailed component diagram
- Workflow state machine (per-host, per-cluster, parent)
- Configuration Element schemas (full property definitions)
- Form schema and action binding map
- vCenter permission set (final, validated)
- Error state taxonomy (every failure mode, expected behavior)
- Implementation sequencing plan

**Do not begin code generation until architecture is reviewed and approved.**
