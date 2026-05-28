# VCF VM Apps Guest Customization — Implementation Guide
**Version:** 1.4
**Date:** May 2026

---

## 1. Prerequisites Checklist

Complete all items before importing any code into Orchestrator.

### 1.1 vCenter — Base Image Templates

For each base image template VM (Windows and Linux):

```
[ ] disk.EnableUUID = TRUE
    vCenter → VM → Edit Settings → VM Options → Advanced → Configuration Parameters
    Key: disk.EnableUUID   Value: TRUE

[ ] VMware Tools / open-vm-tools installed and current
    Windows: VMware Tools installer
    Linux:   open-vm-tools package (dnf install open-vm-tools)

[ ] Built-in Administrator account ENABLED (Windows only)
    Default on Windows Server — verify before templating

[ ] Linux base image packages present:
    parted, util-linux (mkfs.ext4), xfsprogs (mkfs.xfs), util-linux (blkid, lsblk)
    Command: dnf install -y parted xfsprogs util-linux
```

### 1.2 VCF Orchestrator — Plugins

```
[ ] vCenter Server plugin configured and connected
    Orchestrator → Administration → Integrations → vCenter Server
    Verify: at least one vCenter connection active

[ ] HTTP-REST plugin available
    Bundled with VCF Orchestrator — verify plugin is enabled
    Orchestrator → Administration → Extensions → HTTP-REST

[ ] RESTHostManager.removeHost() available (V2 validation)
    Test: create a minimal workflow that calls RESTHostManager.removeHost(null)
    in a try/catch — verify no ClassNotFoundException
```

### 1.3 VCFA — Required Configuration

```
[ ] Cloud Zone ID known (needed for getOSVersionList)
[ ] Image mappings configured for Windows and Linux base images
[ ] Extensibility subscription endpoint available (for POST_PROVISION trigger)
[ ] Secret or Config Element created for guest credentials (pending C4/V1 resolution)
```

---

## 2. Import Sequence

Import artifacts into VCF Orchestrator in this order. Dependencies must exist before dependents.

### Step 1 — Create Module

In Orchestrator → Design → Actions:
- Create module: `com.vcf.guestcustomization`

### Step 2 — Import Actions (order-independent within this group)

Import each `.js` file as an Action in module `com.vcf.guestcustomization`:

| File | Action Name | Return Type |
|---|---|---|
| `actions/extractDiskUUIDs.js` | `extractDiskUUIDs` | `string` |
| `actions/getBearerToken.js` | `getBearerToken` | `string` |
| `actions/getOSVersionList.js` | `getOSVersionList` | `string` |
| `actions/getNetworkList.js` | `getNetworkList` | `string` |
| `actions/getFolderList.js` | `getFolderList` | `string` |
| `actions/getClusterList.js` | `getClusterList` | `string` |

**For each action:**
1. Orchestrator → Design → Actions → Right-click module → Add action
2. Paste JS content into the scripting tab
3. Add inputs as defined in each file's header comment
4. Set return type as above
5. Save and close

#### Action Input Reference

**extractDiskUUIDs:**
| Input | Type |
|---|---|
| vm | VC:VirtualMachine |
| diskCount | number |

**getBearerToken:**
| Input | Type |
|---|---|
| vcfaFqdn | string |
| username | string |
| password | string |

**getOSVersionList:**
| Input | Type |
|---|---|
| vcfaFqdn | string |
| bearerToken | string |
| cloudZoneId | string |

**getNetworkList:**
| Input | Type |
|---|---|
| clusterName | string |
| datacenterName | string |

**getFolderList:**
| Input | Type |
|---|---|
| datacenterName | string |

**getClusterList:**
| Input | Type |
|---|---|
| datacenterName | string |

### Step 3 — Import Sub-Workflows

Import each workflow `.js` file. Each file is a scriptable task implementation — it maps to one scriptable task element in a vRO workflow.

**For each sub-workflow:**
1. Orchestrator → Design → Workflows → New workflow
2. Name as shown below
3. Add inputs (see Workflow Input Reference)
4. Add one Scriptable Task element
5. Paste the workflow JS into the scriptable task
6. Map all inputs to the scriptable task
7. Add output binding for `executionResult` / `executionSummary`
8. Validate and save

| File | Workflow Name |
|---|---|
| `workflows/workflow_RenameLocalAdmin.js` | `workflow_RenameLocalAdmin` |
| `workflows/workflow_UpdateLocalAdminPassword.js` | `workflow_UpdateLocalAdminPassword` |
| `workflows/workflow_MountFormatDisks_Windows.js` | `workflow_MountFormatDisks_Windows` |
| `workflows/workflow_MountFormatDisks_Linux.js` | `workflow_MountFormatDisks_Linux` |

#### Workflow Input Reference

**workflow_RenameLocalAdmin:**
| Input | Type | Notes |
|---|---|---|
| vm | VC:VirtualMachine | |
| osType | string | "windows" or "linux" |
| guestUsername | string | |
| guestPassword | SecureString | |
| newAdminName | string | |

Output: `executionResult` (string)

**workflow_UpdateLocalAdminPassword:**
| Input | Type | Notes |
|---|---|---|
| vm | VC:VirtualMachine | |
| osType | string | |
| guestUsername | string | Post-rename name |
| guestPassword | SecureString | Current password |
| newPassword | SecureString | New password |

Output: `executionResult` (string)

**workflow_MountFormatDisks_Windows:**
| Input | Type | Notes |
|---|---|---|
| vm | VC:VirtualMachine | |
| guestUsername | string | Post-rename name |
| guestPassword | SecureString | Post-update password |
| additionalDisks | string | JSON: [{driveLetter, driveLabel, sizeGb}] |
| diskUuidMapJson | string | JSON from extractDiskUUIDs |

Output: `executionSummary` (string)

**workflow_MountFormatDisks_Linux:**
| Input | Type | Notes |
|---|---|---|
| vm | VC:VirtualMachine | |
| guestUsername | string | Post-rename name |
| guestPassword | SecureString | Post-update password |
| additionalDisks | string | JSON: [{mountPoint, driveLabel, sizeGb}] |
| diskUuidMapJson | string | JSON from extractDiskUUIDs |

Output: `executionSummary` (string)

### Step 4 — Import Parent Workflow

1. Create new workflow: `workflow_VMDeployParent`
2. Add inputs:

| Input | Type | Notes |
|---|---|---|
| vmName | string | From VCFA extensibility payload |
| osType | string | "windows" or "linux" |
| vcenterFqdn | string | vCenter FQDN |
| guestUsername | string | Pre-rename admin name |
| guestPassword | SecureString | Pre-update password |
| newAdminName | string | Target admin name |
| newPassword | SecureString | New password |
| additionalDisks | string | JSON array or empty string |

Output: `deploymentSummary` (string)

3. Add workflow elements in sequence (see Section 3 below)
4. Link sub-workflows as nested Workflow elements

---

## 3. Parent Workflow — vRO Editor Construction

The `workflow_VMDeployParent.js` file contains the logic and binding documentation as comments. In the vRO editor, construct the workflow as follows:

```
[Start]
    │
    ▼
[Scriptable Task: validateAndResolveVM]
    │   - Input validation
    │   - VcPlugin.getAllVirtualMachines() VM lookup
    │   - Output: vm (VC:VirtualMachine)
    │
    ▼
[Scriptable Task: waitForTools]
    │   - Polls vm.guest.toolsRunningStatus
    │   - Max 300 seconds, 10-second poll
    │   - Throws if timeout
    │
    ▼
[Decision: hasDisks?]  ← (additionalDisks != null && additionalDisks != "[]")
    │               │
   YES              NO
    │               │
    ▼               │
[Action: extractDiskUUIDs]
    │   Module: com.vcf.guestcustomization
    │   IN: vm, diskCount (= disks.length)
    │   OUT: diskUuidMapJson
    │               │
    └───────────────┤
                    ▼
         [Workflow: workflow_RenameLocalAdmin]
              IN: vm, osType, guestUsername, guestPassword, newAdminName
              OUT: renameResult
                    │
                    ▼
         [Workflow: workflow_UpdateLocalAdminPassword]
              IN: vm, osType, guestUsername=newAdminName,
                  guestPassword, newPassword
              OUT: passwordResult
              NOTE: guestUsername must be newAdminName (post-rename)
                    │
                    ▼
         [Decision: hasDisks AND osType?]
              │               │
           windows           linux          (no disks — branch to End)
              │               │
              ▼               ▼
   [Workflow:            [Workflow:
    MountFormatDisks_Win] MountFormatDisks_Linux]
    IN: vm,               IN: vm,
        newAdminName,         newAdminName,
        newPassword,          newPassword,
        additionalDisks,      additionalDisks,
        diskUuidMapJson       diskUuidMapJson
    OUT: diskSummary      OUT: diskSummary
              │               │
              └───────────────┘
                    │
                    ▼
         [Scriptable Task: logSummary]
                    │
                    ▼
                 [End]
```

**Critical binding note:** Between Step 5 (RenameLocalAdmin) and Step 6 (UpdateLocalAdminPassword), the `guestUsername` binding changes from the original admin name to `newAdminName`. The account has been renamed — authentication for password update must use the new name.

**Critical binding note:** Between Step 6 (UpdateLocalAdminPassword) and Step 7/8 (MountFormatDisks), the `guestPassword` binding changes from the original password to `newPassword`. The disk workflows authenticate with the updated credentials.

---

## 4. VCFA Extensibility Subscription

### 4.1 Subscription Configuration

In VCFA → Extensibility → Subscriptions:

| Field | Value |
|---|---|
| Name | `PostProvision_GuestCustomization` |
| Event topic | `compute.provision.post` |
| Condition | (optional) filter by blueprint name or project |
| Type | Orchestrator Workflow |
| Workflow | `workflow_VMDeployParent` |
| Blocking | Yes (ensures customization completes before deployment marked success) |
| Timeout | 900 seconds (15 minutes — covers all sub-workflows) |

### 4.2 Payload Mapping

Map VCFA extensibility payload properties to workflow inputs:

| Workflow Input | VCFA Payload Source | Notes |
|---|---|---|
| `vmName` | `resourceNames[0]` | VM display name from blueprint `name:` property |
| `osType` | Custom input or blueprint property | Set at catalog request time |
| `additionalDisks` | `customProperties.additionalDisks` | Serialized JSON from blueprint input |

Credentials (`guestPassword`, `newPassword`) must be sourced from Secret or Config Element — not from the extensibility payload until C4/V1 is resolved.

### 4.3 C4 Credential Handling — Pending Resolution

**Do not pass credentials in extensibility payload until V1 test completes.**

**Option A (if payload masking confirmed):** Pass credentials as Secret references in the VCFA deployment request. Map from `${secret.guestPassword}` in blueprint.

**Option B (if masking not confirmed or not acceptable):** Store credentials in a vRO Config Element:
1. Orchestrator → Configuration → Config Element → New
2. Path: `com.vcf.guestcustomization/credentials`
3. Attributes: `defaultGuestPassword` (SecureString), `defaultNewPassword` (SecureString)
4. In `workflow_VMDeployParent` add a scriptable task at the start that reads these values:
   ```javascript
   var configPath = "com.vcf.guestcustomization/credentials";
   var configElement = Server.getConfigurationElementByPath(configPath);
   var guestPassword = configElement.getAttributeWithKey("defaultGuestPassword").value;
   var newPassword   = configElement.getAttributeWithKey("defaultNewPassword").value;
   ```

---

## 5. Blueprint Token Replacement (M1)

Before deploying any blueprint, replace all `{{placeholder}}` tokens:

| Token | Replace With |
|---|---|
| `{{datacenter}}` | vCenter datacenter name |
| `{{cluster}}` | vCenter cluster name |
| `{{network}}` | DVPortgroup name |
| `{{folder}}` | Full folder path (e.g. `Datacenter/vm/Production`) |
| `{{imageMapping}}` | VCFA image mapping name |
| `{{projectId}}` | VCFA project ID |

---

## 6. Validation Test Plan

Execute in sequence. Do not proceed to production until all pass.

### V1 — Secret Payload Masking
1. Create a test VCFA Secret containing a dummy value
2. Deploy a test VM using a blueprint that references `${secret.testSecret}`
3. In Orchestrator → Workflow Runs → locate the extensibility-triggered run
4. Inspect the input payload received by the workflow
5. **Pass:** Secret value is masked (asterisks) in the payload log
6. **Fail:** Secret value appears in plaintext → implement Option B (Config Element)

### V2 — RESTHostManager.removeHost() Availability
1. Create a minimal test workflow with one scriptable task:
   ```javascript
   var host = RESTHostManager.createHost("test-cleanup");
   var transient = RESTHostManager.createTransientHostFrom(host);
   RESTHostManager.reloadConfiguration();
   RESTHostManager.removeHost(transient);
   System.log("Cleanup: OK");
   ```
2. Run workflow
3. **Pass:** Completes without error, "Cleanup: OK" in log
4. **Fail:** ClassNotFoundException or method not found → check HTTP-REST plugin version; may require plugin update

### V3 — disk.EnableUUID Inheritance
1. Set `disk.EnableUUID = TRUE` on Windows and Linux base image templates
2. Deploy a test VM from each blueprint (zero-disk variant)
3. In vCenter → VM → Monitor → Configuration → Advanced → check `disk.EnableUUID`
4. In the guest, run:
   - Windows: `Get-Disk | Select SerialNumber`
   - Linux: `lsblk -o NAME,SERIAL` or `ls /dev/disk/by-id/`
5. **Pass:** SerialNumber / by-id entries contain VMDK UUID values
6. **Fail:** SerialNumber empty → UUID not propagated; recheck template setting and re-deploy

### V4 — vimType Values
1. Create a test workflow that logs vimType for one folder, one cluster, one DVPortgroup:
   ```javascript
   var folders = VcPlugin.getAllFolders();
   System.log("Folder vimType: " + (folders.length > 0 ? folders[0].vimType : "NONE"));
   var clusters = VcPlugin.getAllClusterComputeResources();
   System.log("Cluster vimType: " + (clusters.length > 0 ? clusters[0].vimType : "NONE"));
   var networks = VcPlugin.getAllNetworks();
   System.log("Network vimType: " + (networks.length > 0 ? networks[0].vimType : "NONE"));
   ```
2. **Pass:** Values match: `Folder`, `ClusterComputeResource`, `DistributedVirtualPortgroup`
3. **Fail:** Values differ → update filter conditions in getNetworkList, getFolderList, getClusterList

### V5 — Zero-Disk Deployment
1. Deploy test VM using zero-disk blueprint variant (Windows and Linux)
2. **Pass:** VM provisions, boots, Tools running — no disk resource errors in VCFA
3. Trigger `workflow_VMDeployParent` manually with `additionalDisks = ""`
4. **Pass:** Workflow skips disk steps, completes RenameLocalAdmin and UpdateLocalAdminPassword only

### V6 — With-Disks Deployment End-to-End
1. Deploy test VM using with-disks blueprint with 2 disks (one < 2048GB, one ≥ 2048GB)
2. Verify in vCenter: both disks on SCSI Controller 1
3. Run `extractDiskUUIDs` action — verify 2-entry JSON with unit numbers 0 and 1
4. Run `workflow_MountFormatDisks_Windows` (or Linux) with test inputs
5. **Pass Windows:** Both drive letters available, correct partition style per size, NTFS format
6. **Pass Linux:** Both mount points active in `df -h`, correct filesystem per size, fstab entries present

### V7 — Blueprint Expression Syntax
1. Open blueprint in VCFA Assembler code editor
2. Verify `${secret.*}` and `${propgroup.*}` expressions are accepted (no red errors)
3. **Pass:** Expressions resolve without syntax errors in the editor
4. **Fail:** Expression syntax differs — check VCFA version-specific expression documentation

### V8 — VMware Tools Hostname Injection
1. Deploy test VM using zero-disk blueprint (name: property set to test hostname)
2. After provisioning, check guest hostname:
   - Windows: `hostname` command
   - Linux: `hostname` command
3. **Pass:** Guest hostname matches the `name:` property value from the blueprint
4. **Fail:** Hostname is auto-generated/different → VMware Tools version insufficient for VCFA hostname injection; update Tools on base image

---

## 7. Operational Notes

### Logs
All workflow and action steps write to Orchestrator workflow execution logs via `System.log`, `System.warn`, and `System.error`. Access via:
- Orchestrator → Monitoring → Workflow Runs → Select run → Logs tab

### Re-run Safety
All customization sub-workflows are designed to detect already-configured state and exit cleanly (not throw). A failed deployment can be re-triggered once the root cause is resolved without risk of data loss or duplicate configuration.

### Credential Rotation
If `defaultGuestPassword` (initial admin password on base images) changes across base image versions, update the Config Element attribute. All new deployments will use the updated value. Existing VMs are unaffected.

### Multi-vCenter Environments
The current implementation uses `VcPlugin.getAllSdkConnections()[0]` which targets the first registered vCenter. For multi-vCenter environments, add `vcenterFqdn` as an input to `workflow_VMDeployParent` and resolve the correct SDK connection by matching the FQDN before obtaining the `serviceInstance`.
