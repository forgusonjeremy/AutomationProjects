# Lab Build Checklist — Windows Archive Log Management (vRO/Orchestrator)

Purpose: Stand up a lab to test the VCF Orchestrator workflows that replace the
Ansible "Move Windows Event Logs" playbooks. Defaults below match the values
baked into `cvs_functions.ps1` and the vRO package (`corp.local`,
`\\fileserver.corp.local\mdcarchivelog$\Windows`, `C:\PSO\Scripts\cvs_functions.ps1`).
Match these and you avoid reconfiguring the package.

> **The #1 thing this lab must reproduce:** the **double-hop**
> (vRO → PS host → `\\target\C$` and `\\fileserver\share$`). It has no analog in the
> Ansible design (Ansible hit each server directly over WinRM), so build and test it first.

---

## What each workflow exercises (reference)

| Workflow | Script `-Action` | Path under test |
|---|---|---|
| Move-ArchivedLogs-ByADGroup | `move-archived-logs-ByCN` | AD group, recursive, **Enabled-only** → each `C$` → share |
| Remove-OldFiles-UNCShare | `Delete-OldFiles-UNC-Share` | Delete files older than N days from share (`whatIf`) |

> **Consolidation note:** The package was simplified from four workflows to two.
> The former LocalHost workflow is gone — the PS-execution servers are members of
> the AD group and are covered by Move-ArchivedLogs-ByADGroup. The two AD-group
> workflows are merged into one using the recursive + Enabled-only path
> (`Get-ListOfServers-ByCN`). No `cvs_functions.ps1` changes are required.

---

## 1. Domain Controller — `vcf.lab`

- [x] Deploy Windows Server VM (2019/2022); promote to DC for `vcf.lab`
- [x] Install/confirm DNS for the domain
- [x] Create AD security group: `Monitoring-Servers` (OU=Servers)
- [x] Add target server **computer objects** to the group
- [x] Include **one disabled** computer object (to prove the `Enabled -eq $true` filter)
- [x] Add a **nested group** with a computer member (to prove `-Recursive` expansion)
- [x] Create service account `vcf\vcfadmin` for running the script
- [x] Grant `vcfadmin` local admin on target servers (for `C$` access) + write to archive share

## 2. PowerShell Orchestration Host ("PSO host") — *the linchpin*

- [x] Deploy domain-joined Windows Server VM
- [x] Install **RSAT Active Directory PowerShell module** (`Import-Module ActiveDirectory` must work)
- [x] Deploy script to `C:\PSO\Scripts\cvs_functions.ps1` (no script changes required — both invoked `-Action` values already exist)
- [x] Enable PowerShell remoting / WinRM (so vRO PowerShell plugin can connect)
- [x] **Configure Kerberos constrained delegation** for the double-hop:
  - [x] Delegate PSO host account → target servers **CIFS** SPNs
  - [x] Delegate PSO host account → file server **CIFS** SPN
  - [x] (Fallback: CredSSP, if Kerberos delegation is not feasible in lab)
- [ ] If the PSO host is itself a member of the AD group, seed aged `Archive-*.evtx`
      files locally so it is also exercised as a target (see §5)

## 3. Target Member Servers (2–3)

- [x] Deploy 2–3 domain-joined Windows Server VMs
- [x] Add to the AD group (mix enabled/disabled objects for the Enabled-only filter test)
- [x] Confirm `C$` admin share reachable by `svc-pso`
- [x] Allow SMB (445) from the PSO host through the firewall
- [ ] Seed aged `Archive-*.evtx` files in `C:\Windows\System32\winevt\Logs` (see §5)

## 4. File Server / Archive Share

- [x] Provide host for the share (can be a role on the DC or its own VM)
- [x] Create hidden share **`mdcarchivelog$`** → exposed as `\\fileserver.corp.local\mdcarchivelog$\Windows`
- [x] Add DNS alias `fileserver` (or rename host) to match the default UNC path
- [x] Grant `svc-pso` modify/write on the share
- [ ] Seed files **older than 370 days** + some recent files (for the Remove-OldFiles test)

## 5. Test Data (filters on `LastWriteTime` — back-date the files!)

- [x] On each **target** (and the **PSO host** if it is also a group member),
      create aged move-test files. Use the helper to seed all servers at once:
  ```powershell
  # Seed every enabled member of the AD group (same resolution as the workflow):
  .\lab\New-ArchiveLogTestData.ps1 -ADGroup 'Monitoring-Servers' -DomainName vcf.lab
  # ...or an explicit list:
  .\lab\New-ArchiveLogTestData.ps1 -ComputerName srv01,srv02 -FilesPerServer 5 -AgeDays 30
  ```
  Single-host quick one-liner (equivalent, local only):
  ```powershell
  1..5 | % { $f="C:\Windows\System32\winevt\Logs\Archive-Application-2024-01-0$_-000000-000.evtx";
             New-Item $f -Force; (Get-Item $f).LastWriteTime=(Get-Date).AddDays(-30) }
  ```
  (Content is irrelevant — the move selects by name/age, it does not parse evtx.)
- [ ] On the **archive share**, seed >370-day-old files **and** recent files for the delete test

## 6. VCF / Aria Orchestrator Appliance

- [ ] Configure PowerShell plugin with the PSO host (Kerberos or CredSSP auth)
- [ ] Create Configuration Element `VCF/WindowsLogManagement/WindowsLogManagement-Config`:
  - [ ] `defaultScriptPath` = `C:\PSO\Scripts\cvs_functions.ps1`
  - [ ] `defaultFileShareTarget` = `\\fileserver.corp.local\mdcarchivelog$\Windows`
  - [ ] `defaultDomainName` = `corp.local`
  - [ ] `defaultLogRetentionDays` = `370`
- [ ] Deploy the 3 actions (`buildMoveByADGroupInvocation`, `buildRemoveFilesInvocation`, `parseScriptOutput`)
- [ ] Deploy the 2 workflows per `code/README.md`

## 7. SMTP (optional — Phase 2 defers email reporting)

- [ ] Provide a test SMTP catcher only if you want to exercise `Send-MailMessage` paths

---

## Pre-flight validation — run on PSO host **as `svc-pso`** before touching vRO

These isolate environment problems from workflow problems.

- [ ] `Get-Module -ListAvailable ActiveDirectory` returns the module
- [ ] `Get-ADGroupMember 'Monitoring-Servers' -Recursive` resolves to your computers
- [ ] Group resolves correctly (recursive expansion + enabled-only behaves as expected)
- [ ] `Test-Path \\<target>\C$\Windows\System32\winevt\Logs` → `True` (hop-2 read + delegation)
- [ ] `New-Item` into `\\fileserver.corp.local\mdcarchivelog$\Windows` succeeds (hop-2 write)
- [ ] Run the action directly once, e.g.:
  ```powershell
  & C:\PSO\Scripts\cvs_functions.ps1 -Action move-archived-logs-ByCN `
    -SecurityGroup_CN Monitoring-Servers -DomainName corp.local `
    -FileShareTarget '\\fileserver.corp.local\mdcarchivelog$\Windows'
  ```
- [ ] **Then** run the same through the vRO PowerShell plugin (confirms the double-hop
      survives the extra vRO → PS-host hop — direct logon testing will not catch this)

---

## Acceptance checks

- [ ] Per-server subfolders auto-created under the archive share
- [ ] Aged `Archive-*.evtx` files moved off targets; recent files left in place
- [ ] Workflow skips the **disabled** computer object (Enabled-only filter)
- [ ] Workflow includes the **nested-group** member (recursive expansion)
- [ ] Remove-OldFiles with `whatIf='yes'` reports but deletes nothing
- [ ] Remove-OldFiles with `whatIf='no'` deletes only >370-day files
- [ ] Workflow end-states report success/error correctly via `parseScriptOutput`

---

## Minimum viable footprint

**4 VMs** + existing vRO appliance:
1. DC + file server (combined)
2. PSO host
3. Target server A (enabled)
4. Target server B (+ a disabled computer object for the CN filter)

Covers both workflows, recursive AD resolution, the Enabled filter, the
double-hop, and the delete/whatIf logic.
