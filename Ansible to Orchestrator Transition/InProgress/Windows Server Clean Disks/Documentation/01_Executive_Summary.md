# Executive Summary — Windows Server Disk Cleans

## Business objective

Keep Windows servers from running out of disk space by regularly deleting aged,
disposable files, chiefly the SCCM download cache (`c:\Windows\ccmcache`), and by
clearing stale user profiles on the servers that need it. The Ansible playbook that does
this today (`servers_diskclean.yml`) is being replaced by a VCF Operations Orchestrator
workflow, **Windows Server Disk Cleans**, as part of the Ansible → Orchestrator
transition.

## Scope

- **Targets:** the enabled computer accounts that are **direct** members of an Active
  Directory security group. Physical servers and virtual machines are handled
  identically; nothing depends on vCenter.
- **What runs:** one PowerShell script, `Invoke-ServerDiskClean.ps1`, executed on a
  PowerShell host. The host reaches every target through its administrative share
  (`\\server\c$`).
- **Production use today:** eight Ansible templates. Six clean the SCCM cache
  (`c:\Windows\ccmcache`, older than 1 day). Two clear user profiles (`c:\users`,
  everything, including read-only items).

## What gets deleted (at a glance)

| Setting on the request form | Effect |
|---|---|
| **Folder(s)** | Where to clean, e.g. `c:\Windows\ccmcache`. The folder itself is never removed |
| **File name filter** | Which files, e.g. `*.*` (all) or `*.tmp` |
| **Older than N days** | Only items last written more than N days ago. `0` means everything up to now |
| **Delete read-only items** | Also removes read-only files |
| **Delete folders as well** | Removes whole sub-folders older than the cutoff, **only** when the filter matches every file **and** read-only deletion is on. Otherwise only matching files are cleaned and the report says so |
| **Report Only / Report and Delete** | **Report Only is the default.** It lists what would be deleted and changes nothing |

Always kept: the live VMware Tools log (`vmware-vmsvc-SYSTEM.log`), anything newer than
the cutoff, and the target folder itself. System folders such as `\Windows\System32`,
`\Program Files` and `\ProgramData` are refused as targets. Only known cache folders
inside them are allowed.

## Key improvements over the Ansible automation

| Area | Ansible today | Orchestrator |
|---|---|---|
| Safety | Always deleted; no preview | **Report Only** by default; a live run is a deliberate choice |
| Folder deletion | A narrow filter silently kept every folder, or a folder took everything with it | Folders are deleted only when explicitly and fully requested; otherwise declined and reported |
| System folders | No guard | Drive roots and OS folders refused before anything runs |
| Targeting | All group members, including users and disabled accounts | Direct, enabled computer accounts only; nested groups named in a warning |
| Failures | Silent: an unreachable server looked like a clean run | Each server's outcome recorded and reported with the reason |
| Reporting | None | Per-server HTML email: items, space freed, free space before and after |
| Script delivery | Whole script folder copied on every run | Script kept in Orchestrator and copied to the host **only when it has changed**, verified by SHA-256 |
| Host selection | Fixed inventory host | Least-busy PowerShell host picked automatically |

## Benefits

- **Lower risk.** Preview by default, system-folder guard, and no automatic widening of
  a request.
- **Visibility.** Every run ends with a per-server account of what was, or would have
  been, removed and why anything was skipped.
- **One source of truth.** The script lives in Orchestrator and the host copy can never
  drift from it.
- **Operates the same way as the other transitioned workflows.** It shares their
  AD, host-selection, staging and email building blocks.

## Key risks / decisions

| Item | Status |
|---|---|
| **Cache templates and folder deletion.** The six cache templates run with folders on but read-only deletion off. Under the new rule they clean files only and leave the cache's package folders | **Decision needed:** enable "Delete read-only items" for those templates, or accept file-only cleaning |
| **Second hop.** The PowerShell host must reach `\\server\c$` on every target with delegated credentials | Prerequisite: Kerberos delegation (same as the other transitioned workflows) |
| **Mail relay path.** Reports are sent **by Orchestrator**, so every Orchestrator appliance needs network access to the SMTP relay | Prerequisite: firewall / relay allow-list for the appliance addresses |
| **Long runs.** A large cache over SMB is slow and runs as one PowerShell call | WinRM and plug-in timeouts must exceed the longest run; prove with a Report Only run first |
| **Folder removed whole.** A folder older than the cutoff goes with everything in it, including newer files inside it | By design (the profile templates depend on it); documented in the User Guide |

## Status

Built and validated in the lab against real SMB admin shares: script behaviour, staging,
host selection, the folder rule and the system-folder guard. Remaining before production:
the workflow changes listed in the Implementation Guide §3, the production mail and
host settings, and the cache-template decision above.
