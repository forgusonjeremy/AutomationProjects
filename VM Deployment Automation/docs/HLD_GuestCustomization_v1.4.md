# VCF VM Apps Self-Service Deployment — Guest Customization
## High Level Design Document
**Version:** 1.4
**Date:** May 2026
**Status:** Approved for Implementation (pending V1–V8 validation)

---

## 1. Overview

This document describes the guest customization automation layer for the VCF VM Apps self-service deployment solution. It covers the architecture, component responsibilities, execution flow, and design decisions for the three customization sub-workflows and their parent orchestrator.

The customization layer executes post-provisioning, after VCFA (VCF Automation) has completed VM deployment from a catalog blueprint. It performs Day 1 configuration that cannot be accomplished within the blueprint itself:

- Renaming the built-in local administrator account
- Updating the local administrator password
- Initializing, partitioning, formatting, and mounting additional data disks

---

## 2. Architecture

### 2.1 Component Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  VCF Automation (VCFA)                                              │
│  ┌──────────────────────┐    ┌──────────────────────────────────┐  │
│  │  Service Catalog      │    │  Extensibility Subscription      │  │
│  │  (VM Apps Blueprint)  │───▶│  POST_PROVISION → vRO Workflow   │  │
│  └──────────────────────┘    └──────────────┬───────────────────┘  │
└────────────────────────────────────────────-│───────────────────────┘
                                              │ trigger + payload
                                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  VCF Orchestrator (vRO)                                             │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  workflow_VMDeployParent                                     │   │
│  │                                                              │   │
│  │  1. Validate inputs                                          │   │
│  │  2. Resolve VM (vCenter SDK)                                 │   │
│  │  3. Wait: VMware Tools ready                                 │   │
│  │  4. [IF disks] extractDiskUUIDs (Action)                    │   │
│  │  5. ──▶ workflow_RenameLocalAdmin          (nested, sync)   │   │
│  │  6. ──▶ workflow_UpdateLocalAdminPassword  (nested, sync)   │   │
│  │  7. ──▶ workflow_MountFormatDisks_Windows  (nested, sync)   │   │
│  │      OR workflow_MountFormatDisks_Linux    (nested, sync)   │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  Actions (com.vcf.guestcustomization module):                       │
│    extractDiskUUIDs  getBearerToken  getOSVersionList               │
│    getNetworkList    getFolderList   getClusterList                  │
└───────────────────────────────┬─────────────────────────────────────┘
                                │  vCenter Guest Operations API
                                │  (RunProgramInGuest / FileTransfer)
                                ▼
┌───────────────────────────────────────────────────────────────────┐
│  vCenter Server                                                   │
│    VMware Tools  ──▶  Guest OS (Windows / RHEL Linux)            │
└───────────────────────────────────────────────────────────────────┘
```

### 2.2 Technology Stack

| Layer | Component | Version Dependency |
|---|---|---|
| Cloud Management | VCF Automation (VCFA) | VCF 9.0+ |
| Orchestration | VCF Orchestrator (vRO) | VCF 9.0+ |
| Compute | vCenter Server | vSphere 8.x (VCF 9.x) |
| Guest Execution | VMware Tools / open-vm-tools | Current — must be installed on base images |
| vRO Plugin | vCenter Server Plugin | Bundled with VCF Orchestrator |
| vRO Plugin | HTTP-REST Plugin | Bundled with VCF Orchestrator |
| Guest OS: Windows | Windows Server 2019/2022 | PowerShell 5.1+ |
| Guest OS: Linux | RHEL 8.x / 9.x | Bash, parted, mkfs, blkid, lsblk |

---

## 3. Blueprints

### 3.1 Four-Blueprint Structure

| Blueprint ID | OS | Additional Disks | Notes |
|---|---|---|---|
| `windows-vm-deploy` | Windows | 0 | No disk resource block |
| `windows-vm-deploy-with-disks` | Windows | 1–N | SCSI Controller 1, count.index unit numbers |
| `linux-vm-deploy` | Linux | 0 | No disk resource block, no cloudConfig |
| `linux-vm-deploy-with-disks` | Linux | 1–N | SCSI Controller 1, count.index unit numbers |

### 3.2 Blueprint Selection Logic

Blueprint selection is driven by catalog item configuration in VCFA. Two catalog items are published per OS type:

- **Standard Deploy** → zero-disk blueprint
- **Deploy with Data Disks** → with-disks blueprint

The `additionalDisks` input is present on both — it is empty/null on the standard variant and required on the with-disks variant. The parent workflow handles both cases via the `hasDisks` conditional gate.

### 3.3 Key Blueprint Properties

All blueprints must include:

```yaml
# On Cloud.vSphere.Machine resource
name: '${input.vmHostname}'
```

With-disks blueprints must include on the disk resource:

```yaml
type: Cloud.vSphere.Disk
allocatePerInstance: true
count: '${length(input.additionalDisks)}'
properties:
  capacityGb:     '${input.additionalDisks[count.index].sizeGb}'
  SCSIController: SCSI_Controller_1
  unitNumber:     '${count.index}'
```

- OS disk remains on SCSI_Controller_0 (VCFA default from image mapping)
- All additional disks land on SCSI_Controller_1, unit numbers 0–N
- Ordering is deterministic — unit number matches array index

---

## 4. Disk Identification Design

### 4.1 UUID-Based Correlation

VMware exposes the VMDK UUID as the disk serial number in the guest OS when `disk.EnableUUID = TRUE` is set on the base image template. This is the basis for all disk targeting — positional/index-based approaches are unreliable and not used.

**Flow:**

```
Blueprint (count.index) → SCSI Controller 1 (busNumber=1)
                        → extractDiskUUIDs action filters Controller 1 only
                        → Sorted by unitNumber → [{index, uuid, unitNumber}]
                        → Matched positionally to additionalDisks input array
                        → UUID passed into guest script as target identifier
                        → Guest script: serial number match → physical device
```

### 4.2 Filesystem Selection

| OS | Disk Size | Partition Table | Filesystem |
|---|---|---|---|
| Windows | < 2048 GB | MBR | NTFS |
| Windows | ≥ 2048 GB | GPT | NTFS |
| Linux (RHEL) | Any | GPT | ext4 (< 2048 GB) |
| Linux (RHEL) | Any | GPT | xfs (≥ 2048 GB) |

Linux uses GPT for all disk sizes for consistency and future-proofing. MBR is not used on Linux.

### 4.3 Base Image Requirement

`disk.EnableUUID = TRUE` must be set on all base image template VMs before deployment:

```
vCenter: VM > Edit Settings > VM Options > Advanced > Configuration Parameters
Key:   disk.EnableUUID
Value: TRUE
Scope: Template VM — inherited by all deployed VMs at provision time
```

---

## 5. Guest Script Execution

### 5.1 Mechanism

All guest-side operations use VMware Tools Guest Operations API via the vCenter Server plugin:

1. `fileManager.initiateFileTransferToGuest()` — generates upload URL
2. HTTP PUT via transient REST host — uploads script to guest temp directory
3. `processManager.startProgram()` — executes script
4. `processManager.listProcessesInGuest()` — polls for exit code
5. `fileManager.deleteFileInGuest()` — removes script post-execution

### 5.2 Timeout Values

| Workflow | Timeout per Disk/Operation | Rationale |
|---|---|---|
| RenameLocalAdmin | 60 seconds | Single registry/usermod operation |
| UpdateLocalAdminPassword | 60 seconds | Single password set operation |
| MountFormatDisks_Windows | 120 seconds per disk | NTFS format time for large volumes |
| MountFormatDisks_Linux | 180 seconds per disk | xfs format on large volumes |
| VMDeployParent (Tools wait) | 300 seconds | Boot + Tools startup time |

### 5.3 Script Security

- Scripts are uploaded to guest temp directories and deleted immediately after execution
- Passwords are never logged (System.log is not called with password values)
- Linux password scripts use `chpasswd` — password is in script file, deleted post-run
- Windows password scripts use `ConvertTo-SecureString` in-process — not in argument list
- For production: address C4 (credential exposure in extensibility payload) before go-live

### 5.4 Idempotency

| Operation | Idempotent Behaviour |
|---|---|
| Rename admin (Windows) | Checks current name against target — skips if already renamed |
| Rename admin (Linux) | Checks if target account exists — skips if already exists |
| Update password | Re-executes on retry — no state check (safe, no data loss) |
| Mount/format disks (Windows) | Checks PartitionStyle=RAW — exits code 2 if already initialized |
| Mount/format disks (Linux) | Checks mount state and partition count — exits 2/3 if already processed |
| fstab entry (Linux) | Checks for filesystem UUID before appending — no duplicate entries |

---

## 6. Module and Naming Conventions

### 6.1 vRO Module

All actions: `com.vcf.guestcustomization`

### 6.2 Artifact Inventory

| Type | Name | Purpose |
|---|---|---|
| Action | `extractDiskUUIDs` | UUID extraction from Controller 1 |
| Action | `getBearerToken` | VCFA authentication |
| Action | `getOSVersionList` | Image mapping dropdown |
| Action | `getNetworkList` | DVPortgroup dropdown |
| Action | `getFolderList` | VM folder dropdown |
| Action | `getClusterList` | Cluster dropdown |
| Workflow | `workflow_VMDeployParent` | Parent orchestrator |
| Workflow | `workflow_RenameLocalAdmin` | Rename admin account |
| Workflow | `workflow_UpdateLocalAdminPassword` | Set admin password |
| Workflow | `workflow_MountFormatDisks_Windows` | Windows disk initialization |
| Workflow | `workflow_MountFormatDisks_Linux` | Linux disk initialization |

---

## 7. Transient REST Host Pattern

All actions that make REST API calls follow this pattern (C3 fix):

```javascript
var restHost      = RESTHostManager.createHost("vcfa-token-" + vcfaFqdn);
var transientHost = RESTHostManager.createTransientHostFrom(restHost);
RESTHostManager.reloadConfiguration();

transientHost.url              = "https://" + vcfaFqdn;
transientHost.hostVerification = false;

try {
    // ... REST calls ...
} finally {
    try {
        RESTHostManager.removeHost(transientHost);
    } catch (e) {
        System.warn("Host cleanup: " + e.message);
    }
}
```

**Rules:**
- Each action creates, uses, and destroys its own transient host in the same script block
- Transient hosts are never passed between workflow items or actions
- `finally` block is mandatory — ensures cleanup on both success and failure paths
- Justification for explicit cleanup: parallel-request safety and auditability

---

## 8. Outstanding Validation Requirements

| ID | Item | Blocking |
|---|---|---|
| V1 | Test Secret payload masking in extensibility payload | Yes — C4 unresolved |
| V2 | Validate `RESTHostManager.removeHost()` availability in Orchestrator build | Yes |
| V3 | Confirm `disk.EnableUUID=TRUE` inheritance on first test deployments (Windows + Linux) | Yes |
| V4 | Confirm `vimType` values for Folder, ClusterComputeResource, DistributedVirtualPortgroup | Yes |
| V5 | Zero-disk deployment — confirm blueprint deploys cleanly | Yes |
| V6 | With-disks deployment — confirm Controller 1 assignment and UUID extraction end-to-end | Yes |
| V7 | Validate `${secret.*}` and `${propgroup.*}` expression syntax in Assembler | Yes |
| V8 | Confirm VMware Tools version on base images supports VCFA hostname injection | Yes |

---

## 9. Assumptions

| # | Assumption | Risk if Incorrect |
|---|---|---|
| A1 | `VcPlugin.getAllSdkConnections()[0]` returns the correct vCenter in all environments | Wrong vCenter in multi-vCenter deployments — parameterize vcenterFqdn input and resolve connection explicitly |
| A2 | Guest account has local admin / root privileges | All guest scripts fail at disk / user operations |
| A3 | `disk.EnableUUID = TRUE` set on all base image templates | UUID resolution fails — disks not found in guest |
| A4 | VMware Tools running at workflow execution time | All RunProgramInGuest calls fail — parent workflow has 5-minute wait loop |
| A5 | Linux base images include parted, mkfs.ext4, mkfs.xfs, blkid, lsblk | Linux disk script fails at tool invocation |
| A6 | Windows PowerShell ExecutionPolicy permits `-ExecutionPolicy Bypass` via process flag | Script blocked by GPO — coordinate with AD team |
| A7 | File transfer URL from initiateFileTransferToGuest reachable from Orchestrator | Upload fails if firewall blocks Orchestrator → vCenter guest network path |
| A8 | All clusters use DVPortgroup (no standard vSwitch portgroups) | getNetworkList returns empty — S1 accepted per design |
| A9 | Built-in Windows Administrator account is enabled on base images (Server OS default) | RenameLocalAdmin Windows branch will not find SID-500 account |

---

## 10. Risk Register

| ID | Severity | Item | Status |
|---|---|---|---|
| C1 | Critical | `for each` deprecated syntax | Closed — replaced with standard `for` loops |
| C2 | Critical | `instanceof` type checks unreliable | Accepted — `vimType` used; V4 validation required |
| C3 | Critical | Transient REST host constructor incorrect | Closed — correct pattern implemented |
| C4 | Critical | Secret values in extensibility payload | Open — V1 test required; Option B (Config Element) must be specced before V1 |
| C5 | Critical | `count: 0` on disk resource | Closed — four-blueprint structure resolves this |
| S1 | Significant | getNetworkList DVPortgroup-only filter | Accepted — DVS-only confirmed |
| S2 | Significant | Disk-to-device correlation unreliable | Closed — UUID-based with Controller 1 filter |
| S3 | Significant | additionalDisks array serialization | Accepted — defensive JSON.parse in all actions |
| S4 | Significant | cloudConfig hostname injection unreliable | Closed — name: property used; V8 added |
| M1–M4 | Minor | Various | Closed or accepted per review |
