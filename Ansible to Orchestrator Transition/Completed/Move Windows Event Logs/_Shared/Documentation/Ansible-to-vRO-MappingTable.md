# Ansible → VCF Orchestrator Mapping Table

**Project:** Ansible → VCF Orchestrator transition — "Move Windows Event Logs"
**Scope:** Covers **both** deliverables (Move-ArchivedLogs-ByADGroup and Remove-OldFiles-UNCShare) — the Ansible-to-Orchestrator conversion is one shared history.

> Fixed-width conversion reference (playbook → workflow, task-level, component
> disposition, variable mapping, and gaps). Preserved as originally authored.

```text
╔══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════╗
║  ANSIBLE → VCF ORCHESTRATOR MAPPING TABLE                                                                                                      ║
║  Windows Archive Log Management — Phase 1 Conversion                                                                                           ║
╚══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════╝

───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
SECTION 1 — PLAYBOOK-TO-WORKFLOW MAPPING
───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

Ansible Playbook                            Target vRO Workflow                    Notes
──────────────────────────────────────────  ─────────────────────────────────────  ────────────────────────────────────────────────────────────────
file-move_with-UNCPath_AD-Group             Move-ArchivedLogs-ByADGroup            AD group targeting; resolved via Get-ListOfServers-ByCN
file-move_with-UNCPath_AD-Group-TEST        Move-ArchivedLogs-ByADGroup            Explicit credential passing replaced by PS host plugin credentials
file-move_with-UNCPath_AD-Group-TEST(1)     Move-ArchivedLogs-ByADGroup            Recursive + Enabled-only resolution with -Server domain targeting
move-win-archived-logs                      Move-ArchivedLogs-ByADGroup            Deploy+invoke pattern replaced; script pre-staged
file-move_with-LocalPath_AD-Group           Move-ArchivedLogs-ByADGroup            Former local-execution hosts are AD group members; covered here
file-move_with-LocalPath_Inventory          Move-ArchivedLogs-ByADGroup            Former local-execution hosts are AD group members; covered here
remove-OldFiles-UNCPath                     Remove-OldFiles-UNCShare               Deploy+invoke pattern replaced; script pre-staged

NOTE: Phase 1 consolidated the two AD-group move workflows (ByADGroupName /
ByADGroupCN) into a single Move-ArchivedLogs-ByADGroup using the recursive +
Enabled-only resolution path (Get-ListOfServers-ByCN), and removed the separate
LocalHost workflow.  The Windows servers that executed scripts locally under
Ansible are members of the AD group in the Orchestrator model, so they are
covered by Move-ArchivedLogs-ByADGroup.  Both invoked actions
(move-archived-logs-ByCN and Delete-OldFiles-UNC-Share) already exist in the
deployed script; the cvs_functions.ps1 changes are limited to S-1 (report-only),
S-2..S-4 (parameterised filter/age + resilient, logged per-server failure
handling for the AD-group move), and S-5 (removal of the orphaned
move-archived-logs-ByHostList action).  See Change-Register.md.

───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
SECTION 2 — TASK-LEVEL MAPPING
───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

Ansible Task / Module                 Purpose                                vRO Equivalent                        Required Inputs                         Idempotency Approach                   Notes / Risks
────────────────────────────────────  ─────────────────────────────────────  ────────────────────────────────────  ──────────────────────────────────────  ─────────────────────────────────────  ─────────────────────────────────────────────────────────
win_copy / copy — cvs_functions.ps1   Stage script on PS host                ELIMINATED — script pre-staged        None                                    Pre-deployment assumption               Phase 1 assumes script exists at defaultScriptPath
ansible.windows.win_shell             Invoke PS script with -Action param    OOTB: Invoke a PowerShell script      psHost, invocationString                Script's Move-files checks file age     No per-task idempotency in vRO; relies entirely on script
ansible.windows.win_command           Same as win_shell                      OOTB: Invoke a PowerShell script      psHost, invocationString                Same as above                          win_command vs win_shell distinction is irrelevant post-conversion
vars / group_vars / host_vars         Variable injection                     Workflow inputs + Config Element      Per-workflow input set                  Config Element provides stable defaults  All vars become explicit inputs or Config Element attributes
inventory file (hosts)                Target host selection                  psHost plugin object (PS host only)   PowerShell:PowerShellHost               Managed by vRO PS host plugin           No inventory concept in vRO; PS host is the single execution target
AD group targeting (recursive)        Resolve group members recursively      Script-internal (Get-ListOfServers-ByCN) groupDN, domainName                  Script handles recursion + Enabled filter (disabled skipped + logged; per-object isolation)  vRO does not replicate AD resolution; script owns this
loop / with_items (per-server)        Iterate servers and move files         Script-internal foreach loop          (none — handled by script)              Script iterates; no vRO loop needed     One workflow execution = one script invocation
handlers                              Post-task notification (not used)      Not applicable                        —                                       —                                      Source playbooks do not use handlers
become / credential passing           Privilege escalation / runas           PS host plugin service account        Configured on PowerShell:PowerShellHost  PS plugin handles auth context          Explicit credential vars in TEST playbooks are replaced by plugin SA
when conditions                       Conditional task execution             buildRemoveFilesInvocation whatIf     whatIf input (yes/no)                   whatIf='yes' prevents deletion          The whatIf guard is the primary safety mechanism for Remove workflow
register + debug                      Capture and display output             parseScriptOutput action              psRawOutput (PSObject)                  Parsed into Properties; logged          Method names on PSObject require environment validation

───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
SECTION 3 — COMPONENT DISPOSITION
───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

Ansible Concept                        vRO Disposition
─────────────────────────────────────  ───────────────────────────────────────────────────────────────────────────────────────
Playbook                               Workflow
Role / tasks/main.yml                  Reusable Action (invocation builders) + OOTB PS workflow
defaults/main.yml                      Configuration Element (WindowsLogManagement-Config)
vars/                                  Workflow inputs (operator-supplied or Config Element default)
group_vars / host_vars                 Workflow inputs (no inventory concept in vRO)
inventory / hosts file                 PowerShell:PowerShellHost plugin object (single execution target)
Vault secrets / become password        PS host plugin service account credentials (managed in vRO)
handlers                               Not used in source; not converted
tags                                   Not applicable (vRO does not have task tags)
win_copy (script staging)              Eliminated; script is pre-staged in Phase 1
win_shell / win_command                OOTB: Library/PowerShell/Invoke a PowerShell script
register (capture output)              Workflow attribute: psRawOutput (PowerShell:PowerShellRemotePSObject)
debug (print output)                   parseScriptOutput action → System.log / System.error
failed_when / ignore_errors            Decision element on parsedResult.get("success")
rescue block                           Exception path on OOTB PS workflow → handlePSFailure scriptable task

───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
SECTION 4 — VARIABLE MAPPING
───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

Ansible Variable                       vRO Equivalent                              Default Source
─────────────────────────────────────  ──────────────────────────────────────────  ───────────────────────────────────────────────────────
script_path / ps_script_path           Workflow input: scriptPath                  Move: input default set directly on input; Remove: Config Element defaultScriptPath
file_share_target / archive_dest       Workflow input: fileShareTarget             Move workflow input default set directly on input (no Config Element)
group_dn / ad_group / group_name       Workflow input: groupDN                     Operator-supplied (no default); DN preferred; passed to script as -SecurityGroup_CN
domain_name / domain                   Workflow input: domainName                  Move workflow input default set directly on input (no Config Element)
file_filter / filter_on                Workflow input: fileFilter                  Move workflow input default set directly on input (Archive-*.evtx); passed to script as -FilterOn
days_old / file_age                    Workflow input: fileAgeDays                 Move workflow input default set directly on input (-1); passed to script as -NumberOfDays
unc_share_path / share_path            Workflow input: uncSharePath                Operator-supplied (no default)
older_than_days / retention_days       Workflow input: olderThanDays               Config Element: defaultLogRetentionDays (370) [Remove workflow]
what_if / dry_run                      Workflow input: whatIf (yes/no dropdown)    Hard default: yes (safe)
ansible_host / inventory hostname      Derived from psHost.name (FQDN)             PowerShell:PowerShellHost plugin object
ansible_user / ansible_password        PS host plugin service account              Configured in vRO PS host configuration

───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
SECTION 5 — GAPS AND ITEMS NOT CONVERTED
───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

Gap                                    Impact                                      Mitigation
─────────────────────────────────────  ──────────────────────────────────────────  ───────────────────────────────────────────────────────
No Ansible inventory in vRO            Cannot address multiple PS hosts            All workflows use a single psHost plugin object (intended)
No per-server vRO loop                 Cannot report per-server status in vRO      Script logs per-server status; vRO reads aggregate stdout
$env:COMPUTERNAME pattern              Would require local PS execution, not UNC   Resolved by UNC standardization decision
Ansible vault secret management        vRO has no vault equivalent                 Secrets managed via PS host plugin service account in vRO
Email reporting on completion          Not confirmed in scope                       Deferred to Phase 2
AD query within vRO (native)           Would require AD plugin or REST calls       Script handles AD; not replicated in vRO in Phase 1
Per-server rollback                    Script does not support undo                No rollback implemented; monitor destination share post-run
Parallel execution across servers      Ansible can fork; vRO invokes script once   Script iterates serially; acceptable for Phase 1 volume

```
