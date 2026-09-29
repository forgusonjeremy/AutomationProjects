# Ansible to Orchestrator Transition — repository layout

## The rule

| Folder | What it is | Who writes to it |
|---|---|---|
| **`InProgress/`** | The **working tree**: **every** project, finished and active, plus the shared code and the programme-level documents | You. All editing happens here. |
| **`Completed/`** | A **snapshot** of the finished projects as they were when last promoted, plus the shared code and programme documents they were finished against | Only `Promote-Project.ps1`. Nobody edits it by hand. |

`InProgress` is always a superset of `Completed`. When a project is finished, promote it:

```powershell
cd 'InProgress\_Shared\Tools'
.\Promote-Project.ps1 -Project 'Windows Server Clean Disks' -WhatIf   # preview: every file copied or deleted
.\Promote-Project.ps1 -Project 'Windows Server Clean Disks'           # do it
git status -- ..\..\..\Completed                                      # review, then commit
```

Promotion **mirrors** `InProgress\<Project>`, `InProgress\_Shared` and `InProgress\_Programme`
into `Completed`. Files that are no longer in `InProgress` are removed from `Completed`, and the
history stays in git. The script refuses to run if `Completed` has uncommitted edits, because a
mirror would overwrite them.

To fix a shared action that finished projects already use, edit it in `InProgress\_Shared`,
then run `.\Promote-Project.ps1 -SharedOnly`.

## Layout

```
InProgress/
  _Shared/
    Code/            ONE copy of every shared vRO action (runPowerShellScript, stageScriptOnHost,
                     invokeStagedScript, selectPowerShellHost, sendHtmlEmail, findAdHostForDn,
                     resolveAdGroup, getGroupComputersDirect, probeAdPlugin, ...)
    PowerShell/      shared PowerShell: cvs_functions.ps1, ownership_w2k.ps1
    Documentation/   shared designs + PowerShell Host Build Guide
    Tools/           Build-ResourceElement.ps1, Promote-Project.ps1
  _Programme/        Master-Change-Register.md, presentation material
  <Project>/         Code/, Documentation/, lab/, Ansible Code/, .package
Completed/
  _Shared/  _Programme/  <finished projects>      (same layout, snapshot)
GitLab-Repos-Sanitized/                            the customer's Ansible estate, as received
```

**Project folders do not carry copies of shared actions.** A project's build sheet names each
shared action and points to `InProgress/_Shared/Code/`. The project's `.package` export bundles
the actions it uses, so the package still installs on its own. Copies inside project folders
drifted apart before this layout was adopted (2026-09-29), which is why they were removed.
