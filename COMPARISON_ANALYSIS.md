# Automation Projects Comparison Analysis
**Analysis Date:** 2026-08-13  
**Scope:** Completed Orchestrator Packages vs. GitLab-Repos-Sanitized (Latest Ansible Code)

---

## Executive Summary

| Finding | Count | Status |
|---------|-------|--------|
| **Completed Projects Reviewed** | 7 | ✓ All found |
| **Key Defects Fixed (S-6, S-8, S-9, S-12, S-13)** | 5/5 | ✓ Applied to cvs_functions.ps1 |
| **Playbook Parameter Discrepancies** | 2 | ⚠ NEEDS ATTENTION |
| **NEW Playbooks in GitLab (No Completed Match)** | Multiple | ⚠ REQUIRES REVIEW |
| **Master-Change-Register Applied** | Partial | ⚠ See details below |

---

## 1. Project-by-Project Comparison

### 1.1 Admin Accounts Report

| Aspect | Completed | GitLab-Repos-Sanitized | Status |
|--------|-----------|----------------------|--------|
| **Playbook File** | `admin_accounts_report-v2.yml` | `admin_accounts_report-v2.yml` | ✓ MATCH |
| **gather_facts** | `yes` | `yes` | ✓ MATCH |
| **PowerShell Parameters** | -Action, -eMailReport, -SMTPServer, -MailToString, -MailCcString, -DomainOUsFile, -MailSubjectstring | Same | ✓ MATCH |
| **Task Structure** | Create tempdir → Copy Scripts → Check file → Run PowerShell → Cleanup | Same | ✓ MATCH |
| **Content Identical** | Yes | Yes | ✓ **VERIFIED IDENTICAL** |
| **Needs Update** | **NO** | | |

**Notes:**
- This playbook is synchronized across both locations
- All tasks, parameters, and flow are identical
- No changes required

---

### 1.2 Service Account Expiration Reporting

| Aspect | Completed | GitLab-Repos-Sanitized | Status |
|--------|-----------|----------------------|--------|
| **Playbook File** | `service_accounts_report.yml` | `service_accounts_report.yml` | ✓ MATCH |
| **gather_facts** | `yes` | `yes` | ✓ MATCH |
| **PowerShell Parameters** | -Action, -eMailReport, -SMTPServer, -MailToString, -MailCcString, -OUPath, -MailSubjectstring, -DomainName | Same | ✓ MATCH |
| **Key Difference from Admin Report** | Uses `-OUPath` and `-DomainName` | Uses `-OUPath` and `-DomainName` | ✓ MATCH |
| **Notes in Comments** | References variables like `-HeaderNotesSubstr`, `-ADGroupMember` | References same | ✓ MATCH |
| **Needs Update** | **NO** | | |

**Notes:**
- Uses different parameter set than Admin Accounts Report
- Uses `-OUPath` (single OU) instead of `-DomainOUsFile` (JSON OU map)
- This is intentional - different action requires different parameters
- Synchronized across both locations

---

### 1.3 Windows Server Clean Disks

| Aspect | Completed | GitLab-Repos-Sanitized | Status |
|--------|-----------|----------------------|--------|
| **Playbook File** | `servers_diskclean.yml` | `servers_diskclean.yml` | ✓ MATCH |
| **gather_facts** | `no` | `no` | ✓ MATCH |
| **PowerShell Parameters** | -Action, -ADGroupMember, -FolderTarget, -FolderIncluded, -ForceEnable, -NumberOfDays, -FilterOn, -DomainName | Same | ✓ MATCH |
| **Content Identical** | Yes | Yes | ✓ **VERIFIED IDENTICAL** |
| **Needs Update** | **NO** | | |

**Notes:**
- Disk cleanup uses a different parameter set (server-focused, not mail-focused)
- Synchronized across both locations
- No changes required

---

### 1.4 Server Reboots

| Aspect | Completed | GitLab-Repos-Sanitized | Status |
|--------|-----------|----------------------|--------|
| **Playbook File** | `servers_reboot.yml` (in `Ansible Code/` subdir) | `servers_reboot.yml` | ✓ MATCH |
| **gather_facts** | `no` | `no` | ✓ MATCH |
| **PowerShell Parameters** | -Action, -eMailReport, -SMTPServer, -MailToString, -MailCcString, -MailSubjectstring, **-HeaderNotesSubstr**, -ADGroupMember, **-RebootIt**, **-RebootIt_DelayBetweenServer**, -DomainName | Same | ⚠ **ISSUE** |
| **Master-Change-Register Requirement (P-13)** | HeaderNotesSubstr should be DROPPED | | |
| **Current Status** | BOTH versions still have the problematic parameters | | |
| **Needs Update** | **YES - BOTH locations** | | |

**DETAILED FINDING:**
According to the Master-Change-Register, section P-13 states:
> "HeaderNotesSubstr dropped as an input — it is only a report-header label, so it is **derived from `groupDN`** in the build action. No script change."

**CURRENT ISSUE:**
Both the Completed and GitLab-Repos-Sanitized versions STILL pass these parameters:
```yaml
-HeaderNotesSubstr "{{var_HeaderNotesSubstr}}"
-RebootIt "{{var_RebootIt}}"
-RebootIt_DelayBetweenServer "{{var_RebootIt_DelayBetweenServer}}"
```

**WHAT SHOULD CHANGE:**
- `-HeaderNotesSubstr` parameter should be REMOVED from the playbook (it should be derived in the vRO build action)
- `-RebootIt_RunPreRebootScript` parameter should be ADDED (this is the S-13 security gate)

---

### 1.5 Servers Reboot Report by CN — `servers_pending_reboot_report.yml`

| Aspect | Completed | GitLab-Repos-Sanitized | Status |
|--------|-----------|----------------------|--------|
| **Playbook File** | `servers_pending_reboot_report.yml` | `servers_pending_reboot_report.yml` | ✓ MATCH |
| **gather_facts** | `yes` | `yes` | ✓ MATCH |
| **PowerShell Parameters** | -Action, -eMailReport, -SMTPServer, -MailToString, -MailCcString, -MailSubjectstring, -HeaderNotesSubstr, -ADGroupMember, -DomainName | Same | ✓ MATCH |
| **Content Identical** | Yes | Yes | ✓ **VERIFIED IDENTICAL** |
| **Needs Update** | **NO** | | |

**Notes:**
- Report-only variant (no actual reboots)
- This is used for the "Get-ServerPendingRebootStatus" action
- No reboot parameters needed here (no -RebootIt, -RebootIt_DelayBetweenServer, -RebootIt_RunPreRebootScript)
- Correct to have gather_facts: yes (needs system info for reporting)

---

### 1.6 Servers Reboot Report by CN — `servers_reboot_report-ByCN.yml`

| Aspect | Completed | GitLab-Repos-Sanitized | Status |
|--------|-----------|----------------------|--------|
| **Playbook File** | `servers_reboot_report-ByCN.yml` | `servers_reboot_report-ByCN.yml` | ✓ MATCH |
| **gather_facts** | `yes` | `yes` | ✓ MATCH |
| **PowerShell Parameters** | -Action, -eMailReport, -SMTPServer, -MailToString, -MailCcString, -MailSubjectstring, -HeaderNotesSubstr, **-SecurityGroup_CN**, -DomainName | Same | ✓ MATCH |
| **Key Difference** | Uses `-SecurityGroup_CN` instead of `-ADGroupMember` | Uses `-SecurityGroup_CN` instead of `-ADGroupMember` | ✓ MATCH |
| **Content Identical** | Yes | Yes | ✓ **VERIFIED IDENTICAL** |
| **Needs Update** | **NO** | | |

**Notes:**
- Report-only variant for the "Get-ServerRebootReportStatus-ByCN" action
- Uses `-SecurityGroup_CN` to identify the group by Common Name instead of raw member targeting
- Synchronized across both locations

---

### 1.7 VM Snapshots Cleanup

| Aspect | Completed | GitLab-Repos-Sanitized | Status |
|--------|-----------|----------------------|--------|
| **Playbook File** | None (vCenter-native package) | None (vCenter-native package) | ✓ N/A |
| **Implementation** | Delivered as `com.broadcom.pso.vc.snapshotmanagement` package | | |
| **Orchestrator Package** | Yes | | |
| **Ansible Playbook** | NO | NO | |
| **Notes** | No PowerShell host dependency; uses vCenter directly | | |
| **Needs Update** | **NO** | | |

**Notes:**
- Master-Change-Register confirms: "Snapshot Cleanup — Completed — `com.broadcom.pso.vc.snapshotmanagement` — **No** — vCenter-native; no PowerShell host dependency"
- No changes needed as this is not a PowerShell/Ansible-based workflow

---

### 1.8 Move Windows Event Logs

| Aspect | Completed | GitLab-Repos-Sanitized | Status |
|--------|-----------|----------------------|--------|
| **Playbook Files** | Multiple (in `Ansible Code/` subdir) | Multiple in psscript folder | ⚠ STRUCTURE DIFFERS |
| **Implementation** | Orchestrator package: `com.broadcom.pso.cvs-dt.conus.eventlogarchivesmove` | Ansible playbooks | |
| **Master-Change-Register** | S-1 through S-5 applied; Delivered (completed) | | |
| **Notes** | Uses Move-ArchivedLogs-ByADGroup and Remove-OldFiles-UNCShare workflows | | |
| **Needs Update** | **NO** — Delivered and completed | | |

**Notes:**
- This project has already been delivered to the customer
- Master-Change-Register confirms completion with all S-1…S-5 changes applied to cvs_functions.ps1
- The delivery is a Veiw of 6 Ansible playbooks → **1 unified Orchestrator workflow** (P-2)
- No further updates needed for this delivered project

---

## 2. Master-Change-Register Verification

### 2.1 Shared PowerShell Script Changes (S-Series)

**Status of Changes in `Completed/_Shared References/psscript/files/cvs_functions.ps1`:**

| # | Project | Function | Change | Status |
|---|---------|----------|--------|--------|
| S-1 | Move Event Logs | Remove-OldFiles-UNCPath, Delete-OldFiles-UNC-Share | Read-Host replaced with -ReportOnly | ✓ APPLIED |
| S-2 | Move Event Logs | move-archived-logs-ByCN | Parameterised filters, AD guards, per-server try/catch | ✓ APPLIED |
| S-3 | Move Event Logs | Move-files | Fixed catch message, added -ErrorAction Stop | ✓ APPLIED |
| S-4 | Move Event Logs | Get-ListOfServers-ByCN | Isolation, disabled server skip+log | ✓ APPLIED |
| S-5 | Move Event Logs | $Action ValidateSet, move-archived-logs-ByHostList | Removed orphaned action | ✓ APPLIED |
| **S-6** | **Server Reboots** | **Get-ScriptDirectory** | **$global:PSScriptRoot → $PSScriptRoot** | **✓ APPLIED** |
| **S-7** | **Server Reboots** | **New Get-ListOfServers-Direct** | **Direct + computer-only + enabled resolution** | **✓ APPLIED** |
| **S-8** | **Server Reboots** | **Invoke-ServerReboot case** | **Reboot only on PendingReboot -eq 'True'** | **✓ APPLIED** |
| **S-9** | **Server Reboots** | **Invoke-ServerReboot function** | **Capture shutdown.exe output + test $LASTEXITCODE** | **✓ APPLIED** |
| **S-10** | **Server Reboots** | **New Wait-ServersBackOnline** | **Post-reboot verification via LastBootUpTime** | **✓ APPLIED** |
| **S-11** | **Server Reboots** | **New GenerateReportServerReboot** | **Per-server HTML report + optional mail** | **✓ APPLIED** |
| **S-12** | **Server Reboots** | **Invoke-Module** | **-ErrorAction Stop + missing return $true** | **✓ APPLIED** |
| **S-13** | **Server Reboots** | **New -RebootIt_RunPreRebootScript** | **Opt-in pre-reboot script, default OFF** | **✓ APPLIED** |

**⚠ CRITICAL NOTE:**
Master-Change-Register Section 2 states a **two-copy policy**:
- **In-Progress copy**: `InProgress/psscript/files/cvs_functions.ps1` (working copy)
- **Completed copy**: `Completed/_Shared References/psscript/files/cvs_functions.ps1` (shipped)

> **Current deviation (2026-07-17):** the Completed copy carries S-6…S-12 for the in-flight Server Reboots project, because those edits were applied before this policy was set. It therefore does **not** currently represent the shipped state. This self-corrects at promotion, when the In-Progress copy overwrites it.

**IMPLICATION:** The Completed cvs_functions.ps1 is NOT the current shipped version — it's an intermediate development state. The true shipped version would be from before S-6 (the pre-S-6 baseline is recoverable from git commit `56f7cf8`).

---

### 2.2 Process Changes (P-Series)

| # | Project | Area | Change | Reflected in Playbook |
|---|---------|------|--------|----------------------|
| P-1 | Move Event Logs | Execution engine | Ansible win_shell/win_copy over WinRM → vRO PowerShell host | N/A (completed project) |
| P-2 | Move Event Logs | Workflow count | 6 playbooks → 1 workflow | N/A (completed project) |
| P-3 | Move Event Logs | LocalHost case | Removed | N/A (completed project) |
| P-4 | Move Event Logs | AD targeting | 3 variants → 1 recursive + Enabled-only | N/A (completed project) |
| P-5 | Move Event Logs | Cleanup workflow | Remove playbook → workflow | N/A (completed project) |
| P-6 | Move Event Logs | Server iteration | Script iterates internally | N/A (completed project) |
| P-7 | Move Event Logs | Variables/secrets | vars/group_vars/vault → workflow inputs | N/A (completed project) |
| P-8 | Move Event Logs | Input model | Plain inputs with defaults | N/A (completed project) |
| **P-9** | **Server Reboots** | **Execution engine** | **servers_reboot.yml (stage + run over WinRM) → vRO pre-staged script** | **⚠ NOT REFLECTED** |
| **P-10** | **Server Reboots** | **Iteration & timing** | **Unchanged — script keeps AD resolution, iteration** | **✓ MATCH** |
| **P-11** | **Server Reboots** | **Targeting** | **Direct + computer-only + enabled (S-7); operator input named `groupDN`** | **⚠ PARTIAL** |
| **P-12** | **Server Reboots** | **Reporting** | **No report/mail → per-server HTML report emailed to array (S-11)** | **⚠ NOT REFLECTED** |
| **P-13** | **Server Reboots** | **Report header label** | **`HeaderNotesSubstr` dropped — derived from `groupDN` in build action** | **⚠ NOT APPLIED** |

**⚠ CRITICAL ISSUES FOUND:**

1. **P-13 Not Reflected (servers_reboot.yml):**
   - **Current:** Playbook passes `-HeaderNotesSubstr "{{var_HeaderNotesSubstr}}"` 
   - **Expected:** HeaderNotesSubstr should NOT be in playbook (derived in build action)
   - **Status:** NEEDS FIX

2. **New Parameters Not Added (servers_reboot.yml):**
   - **Missing:** `-RebootIt_RunPreRebootScript` (S-13 security gate)
   - **Current:** Playbook passes `-RebootIt` and `-RebootIt_DelayBetweenServer` as-is
   - **Status:** NEEDS VERIFICATION (these may be intentional for the Ansible version)

---

## 3. Detailed Findings: Defects and Changes in the Shared PowerShell Script

### 3.1 All Five Critical Defects are FIXED in Completed/_Shared References

The Master-Change-Register identifies five defects in the original automation:

| Defect | Real-World Effect | Fixed Location | Status |
|--------|------------------|-----------------|--------|
| **S-6** — `$global:PSScriptRoot` is always $null | Pre-reboot script path became `"/ownership_w2k.ps1"`; Invoke-Command failed non-terminating; pre-reboot step silently skipped | Get-ScriptDirectory function (line 157) | ✓ FIXED |
| **S-8** — Reboot test `!(PendingReboot -eq "False")` also true for 'Error Accessing Server' | Servers with WMI/RPC failures were force-rebooted (shutdown /f) | Invoke-ServerReboot case (line 2978) | ✓ FIXED |
| **S-9** — shutdown.exe failures not caught (native executable, no exception) | Failed reboots indistinguishable from successful; no error logged | Invoke-ServerReboot function (line 1159) | ✓ FIXED |
| **S-12** — Invoke-Module returns $null on both success and failure | Modules that imported fine reported as unavailable | Invoke-Module function (line 644) | ✓ FIXED |
| **S-1** — Interactive Read-Host in non-interactive context | whatIf='yes' preview mode did not work | Remove-OldFiles functions | ✓ FIXED |

### 3.2 Security Control (S-13): Pre-Reboot Script is Opt-In, Default OFF

The `ownership_w2k.ps1` script performs sensitive operations:
```powershell
takeown /A /F c:\windows\inf\usbstor.inf          # USB mass-storage driver INF
icacls c:\windows\inf\usbstor.inf /grant Users:RX # Grant Read+Execute to Users
icacls c:\windows\system32\termsrv.dll /grant :r administrator:F  # Terminal Services
```

**Why Default OFF?**
- Due to S-6 defect, this step has **never actually executed** in production
- Enabling it now would silently START applying permission changes
- Fixing S-6 alone would activate this without notice — a security-posture change
- **S-13 therefore gates the step behind `-RebootIt_RunPreRebootScript` (default `'no'`)**

**Status:** ✓ Properly implemented in Completed version

---

## 4. NEW Playbooks in GitLab-Repos-Sanitized (No Completed Match)

Based on file listing, the following playbooks exist in GitLab but **may not have corresponding Completed project structures**:

| Playbook | Status | Notes |
|----------|--------|-------|
| `service_accounts_reports_connect.yml` | ⚠ CHECK | Variant of Service Accounts Report? |
| `vcredist_consumer_report.yml` | ⚠ NEW | No Completed project found |
| `vmware_rightsizing.yml` | ⚠ NEW | No Completed project found |
| `long_powered_off_vms_report.yml` | ⚠ NEW | No Completed project found |
| `idle_oversized_vms_report.yml` | ⚠ NEW | No Completed project found |
| `hourly.yml` | ⚠ NEW | No Completed project found |
| `hourly(DO NOT DELETE).yml` | ⚠ NEW | Duplicate? |
| `get_datastores_75_100_used_(Works).yml` | ⚠ NEW | No Completed project found |
| `file-move_with-UNCPath_AD-Group.yml` | ⚠ LEGACY | Move Event Logs variant? |
| `file-move_with-UNCPath_AD-Group-TEST(1).yml` | ⚠ TEST | Test file? |
| `file-move_with-LocalPath_Inventory.yml` | ⚠ LEGACY | Move Event Logs variant? |
| `file-move_with-LocalPath_AD-Group.yml` | ⚠ LEGACY | Move Event Logs variant? |
| `move-win-archived-logs.yml` | ⚠ LEGACY | Move Event Logs variant? |
| `remove-OldFiles-UNCPath.yml` | ⚠ LEGACY | Move Event Logs variant? |
| `Microsoft Visual C++.yml` | ⚠ NEW | No Completed project found |
| `certificate_expiry_report.yml` | ⚠ NEW | No Completed project found |
| `cluster_failover_capacity_report.yml` | ⚠ NEW | No Completed project found |
| `datastore_fill_projection_report.yml` | ⚠ NEW | No Completed project found |
| `daily_alarm_event_rollup_report.yml` | ⚠ NEW | No Completed project found |
| `aged_oversized_snapshots_report.yml` | ⚠ NEW | No Completed project found |
| `cvs_admin.yml` | ⚠ NEW | No Completed project found |
| `cvs_orphaned_vmdks.yml` | ⚠ NEW | No Completed project found |
| `cvs_vmware_reports.yml` | ⚠ NEW | No Completed project found |
| `cvs_vmware_ssl_report.yml` | ⚠ NEW | No Completed project found |

**⚠ RECOMMENDATION:** These NEW playbooks should be reviewed to determine if they represent:
1. **Future projects** not yet in the Completed pipeline
2. **Historical/test playbooks** that are no longer in scope
3. **Additional reporting playbooks** that need Orchestrator ports

---

## 5. PowerShell Scripts Comparison

### 5.1 cvs_functions.ps1 Summary

| Aspect | Completed/_Shared References | Status |
|--------|-------------------------------|--------|
| **File Size** | Complete implementation | ✓ PRESENT |
| **S-1 to S-5** | Applied (Move Event Logs) | ✓ VERIFIED |
| **S-6 to S-13** | Applied (Server Reboots) | ✓ VERIFIED |
| **Comment Markers** | Comprehensive (S-1, S-6, S-8, S-9, S-10, S-11, S-12, S-13, S-16, S-22 all documented) | ✓ GOOD |
| **Functions Count** | 40+ functions across all actions | ✓ COMPREHENSIVE |
| **Syntax Valid** | Should be validated before deployment | ⚠ RECOMMEND |

**Action Cases Supported:**
```
move-archived-logs-ByCN
Delete-OldFiles-UNC-Share
tls-fix
move-archived-logs
clean-ServerDisk
Invoke-ServerReboot
Get-ServerPendingRebootStatus
Get-ServerRebootReportStatus-ByCN
Get-AllAdmin-Accounts
Get-ServiceAccountExpiration
get_datastores_75_100_used
VMware_Disable_SSH
```

---

## 6. Summary Table: What Needs Attention

| Project | Issue | Severity | Action Required |
|---------|-------|----------|-----------------|
| **Server Reboots** | P-13 not applied: `-HeaderNotesSubstr` still in playbook | ⚠ MEDIUM | Remove -HeaderNotesSubstr parameter from `servers_reboot.yml` |
| **Server Reboots** | Verify reboot parameters vs Ansible legacy support | ⚠ MEDIUM | Confirm -RebootIt and -RebootIt_DelayBetweenServer intentionality |
| **Move Event Logs** | Completed copy ≠ shipped state (per Master-Change-Register 2026-07-17 note) | ⚠ LOW | Verify pre-S-6 baseline if production deployment issues arise |
| **All Completed** | cvs_functions.ps1 syntax validation recommended | ⚠ LOW | Run PowerShell syntax check before deployment |
| **GitLab-Repos-Sanitized** | 20+ NEW playbooks without Completed project structures | ⚠ HIGH | Assess whether these are in-scope for customer delivery |

---

## 7. Recommendations

### 7.1 Immediate Actions

1. **Update `servers_reboot.yml` (Completed version):**
   ```diff
   - REMOVE: -HeaderNotesSubstr "{{var_HeaderNotesSubstr}}"
   + VERIFY: That -RebootIt and -RebootIt_DelayBetweenServer are intentional for Ansible
   + CONSIDER: Adding -RebootIt_RunPreRebootScript if supporting S-13 in Ansible
   ```

2. **Validate cvs_functions.ps1 Syntax:**
   ```powershell
   $e=$null; $t=$null
   [System.Management.Automation.Language.Parser]::ParseFile(
       'C:\PSO\Scripts\cvs_functions.ps1', [ref]$t, [ref]$e) | Out-Null
   if ($e.Count) { $e } else { 'parse OK' }
   ```

3. **Review Master-Change-Register Note (Section 2, dated 2026-07-17):**
   - Confirm whether Completed copy should be rolled back to pre-S-6 baseline (commit `56f7cf8`)
   - Or confirm it stays as-is for Server Reboots in-flight work

### 7.2 Documentation Updates

1. **Per-Project Change Registers:**
   - Verify each project has a `Documentation/Change-Register.md` file
   - Ensure it matches the Master-Change-Register entries

2. **Implementation Guides:**
   - Server Reboots guide should document the `-RebootIt_RunPreRebootScript` security gate
   - Clarify why ownership_w2k.ps1 defaults to OFF

### 7.3 Scope Clarification

1. **NEW Playbooks:**
   - Triage the 20+ playbooks in GitLab-Repos-Sanitized without Completed versions
   - Determine which are in-scope for this transition programme
   - Document decision for each

2. **Legacy Variants:**
   - Consolidate or archive the legacy `file-move*` and `move-archived-logs` variants
   - Keep only the promoted/final version

---

## 8. Reference Information

### 8.1 Directory Paths

```
Completed Projects:
  C:\Users\ForgusonJW\Documents\AutomationProjects\Ansible to Orchestrator Transition\Completed\

GitLab-Repos-Sanitized:
  C:\Users\ForgusonJW\Documents\AutomationProjects\Ansible to Orchestrator Transition\GitLab-Repos-Sanitized\psscript\

Shared PowerShell (Completed):
  C:\Users\ForgusonJW\Documents\AutomationProjects\Ansible to Orchestrator Transition\Completed\_Shared References\psscript\files\

Shared PowerShell (In-Progress):
  C:\Users\ForgusonJW\Documents\AutomationProjects\Ansible to Orchestrator Transition\InProgress\psscript\files\

Master Register:
  C:\Users\ForgusonJW\Documents\AutomationProjects\Ansible to Orchestrator Transition\Completed\Master-Change-Register.md
```

### 8.2 Master-Change-Register Sections

- **Section 2:** Shared PowerShell script policy (2-copy model, promotion workflow)
- **Section 3:** Consolidated cvs_functions.ps1 changes (S-1…S-13)
- **Section 4:** Build tooling changes (T-1…T-3)
- **Section 5:** Automation process changes (P-1…P-13)
- **Section 6:** Cross-cutting risks & watch items

---

## 9. Analysis Conclusions

### ✓ What's Working Well
- **All 5 critical defects (S-6, S-8, S-9, S-12, S-1) are fixed** in the Completed cvs_functions.ps1
- **S-13 security gate properly implemented** (RebootIt_RunPreRebootScript parameter added with default='no')
- **Admin Accounts, Service Accounts, Windows Clean Disks, and Report playbooks are synchronized** across Completed and GitLab
- **Move Event Logs has been successfully delivered** with all S-1…S-5 changes applied

### ⚠ What Needs Attention
- **P-13 Change not reflected in servers_reboot.yml:** HeaderNotesSubstr parameter should be removed (derived in build action)
- **GitLab-Repos-Sanitized contains 20+ playbooks without Completed counterparts:** Need scope/triage assessment
- **Completed copy status ambiguity:** Master-Change-Register notes it is "in-flight" state, not final shipped state

### ⚡ Critical Findings
- **The Completed `cvs_functions.ps1` is NOT the shipped version** per Section 2 of Master-Change-Register (dated 2026-07-17)
- **Real-world defects prevented multiple automated features from working** (S-6 disabled pre-reboot step, S-8/S-9 caused failed reboots to go undetected)
- **Security implications:** ownership_w2k.ps1 permissions changes have never actually executed due to S-6

---

**Report Prepared:** 2026-08-13  
**Analysis Scope:** 7 completed projects, 2 directory hierarchies, 13 documented changes (S-1…S-13)  
**Status:** Ready for remediation actions
