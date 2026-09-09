# Move Windows Event Logs — Ansible to Orchestrator

**Replaces:** five Ansible playbooks with two Orchestrator workflows
**Platform:** VCF Operations Orchestrator 9
**Status:** built, not yet deployed

---

## What this does

Windows servers write their event logs out to `Archive-*.evtx` files and leave them on
the C: drive. Two jobs keep that under control:

| Workflow | Job |
|---|---|
| **Move Archived Logs** | Take those files off every server in an AD group and put them on a central share, in a folder named after the server |
| **Remove Old Archived Logs** | Delete files from that share once they are past their retention period |

Ansible did both. This package does both in Orchestrator instead.

---

## The shape of it

```
                                      ┌──────────────────────────┐
   Operator picks an AD group  ───►   │      Orchestrator        │
   from a tree. Nothing typed.        │                          │
                                      │  AD plug-in  ────────────┼──►  Domain controllers
                                      │  (which servers?)        │     (one endpoint per domain)
                                      │                          │
                                      │  PowerShell plug-in  ────┼──►  PowerShell host
                                      └──────────────────────────┘          │
                                                                            │ UNC
                                                                            ▼
                                                            \\server\C$  ──►  \\share\<server>
```

Two rules decide where every piece of logic lives:

- **Anything that ran on Windows** is in a PowerShell script, held in Orchestrator,
  copied to the PowerShell host at run time, run, and deleted.
- **Anything Ansible did itself** — mainly the Active Directory lookup — is now an
  Orchestrator plug-in call.

Nothing in this package accepts a username or a password. The AD plug-in uses the
account stored against each domain endpoint; the PowerShell plug-in uses the account
stored against the host. Neither one crosses the network from a workflow.

---

## Files

```
Move Windows Event Logs/
├── README.md                        ← you are here
│
├── _Shared/                         used by both workflows
│   ├── Code/
│   │   ├── runPowerShellScript.js       copies a script to the host, runs it, reads the result
│   │   ├── resolveAdGroup.js            accepts a picked group or a typed name
│   │   ├── findAdHostForDn.js           works out the domain, and so the endpoint, from a name
│   │   ├── selectPowerShellHost.js      only asks which host when there is a real choice
│   │   └── probeAdPlugin.js             one-off check that this Orchestrator can do all of the above
│   └── Documentation/
│       ├── 02_Design-Decisions.md       what was standardised, and why
│       ├── 03_Implementation-Guide.md   how to build it in Orchestrator
│       └── 04_Testing-Plan.md           how to prove it works
│
├── Move-ArchivedLogs/
│   ├── Code/
│   │   ├── Move-ArchivedLogs.ps1            the Windows-side work
│   │   ├── getGroupComputers.js             expands the AD group, nested groups included
│   │   └── workflow_Move-ArchivedLogs.js    the workflow's scriptable task
│   └── Documentation/
│       └── 01_User-Guide.md
│
├── Remove-OldArchivedLogs/
│   ├── Code/
│   │   ├── Remove-OldArchivedLogs.ps1
│   │   └── workflow_Remove-OldArchivedLogs.js
│   └── Documentation/
│       └── 01_User-Guide.md
│
└── Reference/                       source material, kept for the record
    ├── ansible-source-playbooks.md
    ├── New-ArchiveLogTestData.ps1
    └── com.broadcom.pso.cvs-dt.conus.eventlogarchivesmove.package
```

Ten code files in total: two PowerShell scripts, five shared actions, one action for the
move workflow, and one scriptable task per workflow.

---

## Where to start

1. **[02_Design-Decisions.md](_Shared/Documentation/02_Design-Decisions.md)** — read this
   first if you knew the playbooks. It explains what changed and why, including four
   places where the old behaviour was wrong and has been corrected.
2. **[03_Implementation-Guide.md](_Shared/Documentation/03_Implementation-Guide.md)** —
   building it. Starts with the `probeAdPlugin` check, which will save you time.
3. **[04_Testing-Plan.md](_Shared/Documentation/04_Testing-Plan.md)** — proving it.
4. The two **User Guides** — for whoever runs it day to day.

---

## Before anything else

Run the `probeAdPlugin` action once. It changes nothing and prints exactly what this
Orchestrator's plug-ins offer, which is the fastest way to find out whether the AD
endpoints and the PowerShell host are set up the way these workflows expect. Everything
in [03_Implementation-Guide.md](_Shared/Documentation/03_Implementation-Guide.md) assumes
you have done it.
