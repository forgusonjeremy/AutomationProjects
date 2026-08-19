# AAP Template Inventory — Project List

Source: `Doc1.docx` (191 screenshots + 5,061-row job-run history), parsed 2026-08-19.
Full per-template detail: `AAP-Template-Inventory.csv`

## Summary

| | Count |
|---|---|
| Job templates (from screenshots) | **185** |
| Workflow templates | 1 (`1A-Service-Account-PW-Changes`, 8 nodes) |
| AAP projects | 12 |
| Distinct playbooks | ~120 |
| Job runs in log | 5,061 (4,282 success / 748 failed / 28 canceled / 3 error) |
| Templates with run history | 104 |
| Templates never run | **81** |

## Projects

| AAP Project | Templates | Runs | Never run | What it covers |
|---|---:|---:|---:|---|
| `1P_PSScript-Project` | 76 | 3,570 | 24 | Windows ops via PowerShell wrappers — reboots, disk clean, log archival, AD/PKI reports, TLS hardening |
| `1N_Network-Project` | 37 | 241 | 14 | Cisco Nexus 9k — staging, upgrades, backups, SNMP accounts, discovery, CLI |
| `1A_Admins-Project` | 27 | 81 | 15 | Account/credential lifecycle — service-account rotation, RHEL local accounts, Satellite registration, DNF updates, port tests |
| `1D_DEV-Project` | 12 | 20 | 9 | Dev/test — MDE for RHEL, PowerFlex credential ops, Zabbix token renewal |
| `1S_STIG-Project` | 9 | 34 | 8 | STIG compliance — vCenter 8, RHEL 8/9, PowerFlex SLES15 |
| `1R_RHEL-Project` | 6 | 6 | 4 | RHEL firewall rich-rules, kernel install, MDE definitions |
| `1V_VMops-Project` | 5 | 617 | 0 | vCenter snapshot removal (5 vCenters) |
| `1E_ESXI-STIG-Project` | 5 | 38 | 2 | ESXi STIG per-vCenter |
| `Dynatrace` | 4 | 18 | 3 | OneAgent install, ActiveGate, KMS, iPost SCC fix |
| `2A_Aria-Project` | 2 | 0 | 2 | Aria Operations firewall (proxy + cluster) |
| `vxrail-harden` | 1 | 22 | 0 | VxRail Manager hardening (test) |

## Highest-volume templates

| Template | Runs | Success | Failed |
|---|---:|---:|---:|
| `1P_ConvergedL3_file-move_with-UNCPath_AD-Group-connect` | 251 | 227 | 23 |
| `1P_EMAT_file-move_with-UNCPath_AD-Group` | 246 | 147 | **99** |
| `Hourly Health Check` | 239 | 237 | 2 |
| `1P_DPT_Action-BIMC-OW_Archives.Files.Move_WinServer` | 139 | 109 | 30 |
| `1P_DPT_CONNECT__BMIC_OW_file-move_with-UNCPath_AD-Group` | 126 | 111 | 14 |
| `1V_ConvergedL3_esocoewvcs02_Snapshot_removal` | 123 | 59 | **64** |
| `1P_EMAT_file-move_with-LocalPath_Inventory` | 122 | 63 | **59** |

## Most-reused playbooks (consolidation candidates)

Each of these backs many templates that differ only in extra-vars — prime targets for survey-driven consolidation during the Orchestrator transition.

| Playbook | Templates |
|---|---:|
| `servers_reboot.yml` | 10 |
| `servers_reboot_report-ByCN.yml` | 9 |
| `command.yml` | 9 |
| `servers_diskclean.yml` | 8 |
| `nexus_upgrades/staging-with-scp.yml` | 8 |
| `file-move_with-UNCPath_AD-Group.yml` | 7 |
| `vm_remove_snapshot.yml` | 5 |
| `esxi-stig.yml`, `TLS-fix.yml`, `nexus_upgrades/upgrade_64.yml` | 5 each |

## Execution environments

`cvs-core` (145) · `ee-validated` (36, all network) · `ee-supported-rhel9` (2) · `vxrail` (1)

## Gaps

Ten names appear in the run log with no matching screenshot. Four are ad-hoc launch variants (`… @ HH:MM:SS`), not separate templates. The other six look like real templates missing from the capture:

- `1D_DEV_MDE_RHEL_Clean`
- `1E-ConvergedL3-ESXI-STIG@ESOCZM1VCS67`
- `1N_NET_HST_Nex9k_backup-sshkey`
- `1N_NET_MDC_Nex9k_Upgrade_10.3.9`
- `1N_NET_MDC_Nex9k_backup`
- `RHEL_SSH_Limit`
- `1P_SEC_Admin_Accounts_Status-v3 (test)`

## Data-handling notes

- `1P_ConvergedL3_Cluster_Failover` was screenshotted twice (images 79, 80) — deduplicated.
- Five images are scroll-continuation fragments of the preceding template (143, 158, 159, 166, 167) — merged into their parent.
- Some `admin_ips` / `var_list_vm` values were manually blacked out before capture; recorded as `REDACTED-BY-USER`.
