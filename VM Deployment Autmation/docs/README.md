# VCF VM Apps Guest Customization — Artifact Package
**Version:** 1.4 | **Date:** May 2026

---

## Package Contents

```
vcf-guest-customization/
├── actions/
│   ├── extractDiskUUIDs.js          Action: UUID extraction from SCSI Controller 1
│   ├── getBearerToken.js            Action: VCFA authentication
│   ├── getOSVersionList.js          Action: Image mapping dropdown
│   ├── getNetworkList.js            Action: DVPortgroup dropdown
│   ├── getFolderList.js             Action: VM folder dropdown
│   └── getClusterList.js            Action: Cluster dropdown
├── workflows/
│   ├── workflow_VMDeployParent.js   Parent orchestrator — import last
│   ├── workflow_RenameLocalAdmin.js Sub-workflow: rename admin/root account
│   ├── workflow_UpdateLocalAdminPassword.js  Sub-workflow: set admin password
│   ├── workflow_MountFormatDisks_Windows.js  Sub-workflow: Windows disk init
│   └── workflow_MountFormatDisks_Linux.js    Sub-workflow: Linux disk init
└── docs/
    ├── HLD_GuestCustomization_v1.4.md        High Level Design
    ├── Implementation_Guide_v1.4.md          Implementation Guide (start here)
    └── README.md                             This file
```

---

## Quick Start

1. Read `docs/Implementation_Guide_v1.4.md` — Section 1 (Prerequisites) fully before importing anything
2. Complete all prerequisite checklist items
3. Import actions → sub-workflows → parent workflow (in that order)
4. Execute V1–V8 validation tests before connecting to VCFA extensibility subscription
5. Configure extensibility subscription (Implementation Guide Section 4)

---

## vRO Module

All actions belong to module: `com.vcf.guestcustomization`

---

## Import Order (mandatory)

```
1. extractDiskUUIDs.js         (action — no dependencies)
2. getBearerToken.js           (action — no dependencies)
3. getOSVersionList.js         (action — depends on getBearerToken output, not the action itself)
4. getNetworkList.js           (action — no dependencies)
5. getFolderList.js            (action — no dependencies)
6. getClusterList.js           (action — no dependencies)
7. workflow_RenameLocalAdmin.js
8. workflow_UpdateLocalAdminPassword.js
9. workflow_MountFormatDisks_Windows.js
10. workflow_MountFormatDisks_Linux.js
11. workflow_VMDeployParent.js  (depends on all above)
```

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| Sub-workflows are separate | Single responsibility, independently testable, reusable |
| Synchronous nested workflow calls | Sequential dependency chain (rename → password → disks must be ordered) |
| VMware Tools / RunProgramInGuest | No WinRM/SSH required; no firewall exceptions beyond vCenter |
| UUID-based disk targeting | Positional disk matching unreliable; UUID guaranteed unique per VMDK |
| GPT for all Linux disks | Consistent, future-proof, avoids MBR 2TB limit handling |
| Size-based filesystem selection | ext4/NTFS below 2048GB; xfs/GPT+NTFS at or above 2048GB |
| Script deleted post-execution | Credentials not left on disk |
| Idempotent guest scripts | Safe to re-run after partial failure |

---

## Open Items Before Production

| ID | Item | Owner |
|---|---|---|
| C4 / V1 | Test Secret payload masking; implement Option B if not masked | Platform team |
| V2 | Validate RESTHostManager.removeHost() availability | Orchestrator admin |
| V3 | Confirm disk.EnableUUID inheritance on test deployments | VM team |
| V4 | Confirm vimType values in target vCenter SDK version | Orchestrator dev |
| V5 | Zero-disk blueprint deployment test | QA |
| V6 | With-disks end-to-end deployment test | QA |
| V7 | Blueprint expression syntax validation | VCFA admin |
| V8 | VMware Tools hostname injection validation | VM team |

---

## Sources

- Broadcom TechDocs VCF 9.0/9.1
- VMware reference implementation (trisharia/executeTransientRESTOperation.js)
- Broadcom KB 321338 (disk UUID guest info, vSphere 7.0+)
- Design Review Summary v1.3 → v1.4
