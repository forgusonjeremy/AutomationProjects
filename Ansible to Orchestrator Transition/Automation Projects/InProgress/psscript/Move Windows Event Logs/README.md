# Windows Archive Log Management — Package Index

**Project:** Ansible → VCF Orchestrator transition — "Move Windows Event Logs"
**Platform:** VCF Automation 9 / VCF Operations Orchestrator 9
**Status:** Phase 1

This project replaces the retiring Ansible automation for Windows event-log
archives with VCF Orchestrator 9 workflows, reusing the proven `cvs_functions.ps1`
toolbox. It is delivered as **two independent deliverables** that share a common set
of components.

---

## Deliverables

| Deliverable | Purpose | Folder |
|---|---|---|
| **Move-ArchivedLogs-ByADGroup** | Move `Archive-*.evtx` off every enabled member of an AD group to a central archive share (per-server subfolder) | `Move-ArchivedLogs-ByADGroup/` |
| **Remove-OldFiles-UNCShare** | Delete files on the archive share older than a retention threshold (safe report-only default) | `Remove-OldFiles-UNCShare/` |

Each deliverable is a self-contained set: `Code/` (its action + workflow spec) and
`Documentation/` (`01_Executive_Summary` → `05_Validation_and_Testing_Plan`, plus
the Config Element definition for Remove).

---

## Structure

```
Move Windows Event Logs/
├── README.md                         ← this index
├── Move-ArchivedLogs-ByADGroup/
│   ├── Code/                          buildMoveByADGroupInvocation.js, *_spec.js
│   └── Documentation/                 01_Executive_Summary … 05_Validation_and_Testing_Plan
├── Remove-OldFiles-UNCShare/
│   ├── Code/                          buildRemoveFilesInvocation.js, *_spec.js
│   └── Documentation/                 01 … 05 + WindowsLogManagement-Config_definition
└── _Shared/                          ← used by BOTH deliverables
    ├── Code/                          parseScriptOutput.js, handlePSFailure_scriptableTask.js, cvs_functions.ps1
    └── Documentation/                 Shared-Components.md, Change-Register.md, Ansible-to-vRO-MappingTable.md

Automation Projects/_Shared References/  ← cross-project library
└── PowerShell Host Build Guide/
    ├── How-To-Build-a-PowerShell-Host.md   (with embedded Configure-vROPSHost.ps1)
    └── Configure-vROPSHost.ps1
```

---

## Shared components (read before either deliverable)

Documented once in `_Shared/Documentation/` and referenced by both sets:

- **[Shared-Components.md](_Shared/Documentation/Shared-Components.md)** — `cvs_functions.ps1`,
  the OOTB *Invoke a PowerShell script* workflow, the `parseScriptOutput` action
  (incl. the ` *>&1 | Out-String -Width 4096` stream-capture contract and CLIXML
  decode → `Properties{success, outputText, errorText}`), `handlePSFailure`, the
  shared failure-handling contract, and the second-hop requirement.
- **[Change-Register.md](_Shared/Documentation/Change-Register.md)** — every change to
  `cvs_functions.ps1` (S-1…S-5), build tooling (T-1…T-3), and process (P-1…P-8).
- **[Ansible-to-vRO-MappingTable.md](_Shared/Documentation/Ansible-to-vRO-MappingTable.md)** —
  playbook → workflow conversion reference (7 playbooks → 2 workflows).

**Cross-project reference:** the PowerShell host build/registration is a reusable
library at `Automation Projects/_Shared References/PowerShell Host Build Guide/`.
Any project needing a PS host references it. The Windows-side automation script
`Configure-vROPSHost.ps1` is embedded in that guide (Appendix A) and shipped beside it.

---

## Deployment order

1. **Shared foundation (once):** build + register the PS host per the shared
   **How to Build a PowerShell Host** guide; deploy the updated `cvs_functions.ps1`
   (S-1…S-5) to the host; deploy the shared `parseScriptOutput` action and the
   `handlePSFailure` scriptable task.
2. **Per deliverable:** follow that deliverable's `03_Implementation_Guide.md` to
   import its `build*Invocation` action, build its workflow, set inputs/forms, and
   run its `05_Validation_and_Testing_Plan.md`.

The two deliverables are independent — deploy either first, or only one.

---

## Notes

- **Move-ArchivedLogs-ByADGroup** uses plain input parameters with defaults set
  directly on each input — **no Configuration Element**.
- **Remove-OldFiles-UNCShare** uses the `WindowsLogManagement-Config` Configuration
  Element for `defaultScriptPath` and `defaultLogRetentionDays` (see its Config
  definition doc).
- The previous **combined** `code/` and `documentation/` folders are **superseded**
  by this split layout and can be archived/removed once the split is confirmed.
