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
| Move-ArchivedLogs-LocalHost | `move-archived-logs-ByHostList` (additive) | PS host's own `C$\...\winevt\Logs` → share |
| Move-ArchivedLogs-ByADGroupName | `move-archived-logs` | AD group by **sAMAccountName** → each `C$` → share |
| Move-ArchivedLogs-ByADGroupCN | `move-archived-logs-ByCN` | AD group by **CN**, recursive, **Enabled-only** → share |
| Remove-OldFiles-UNCShare | `Delete-OldFiles-UNC-Share` | Delete files older than N days from share (`whatIf`) |

---

## 1. Domain Controller — `corp.local`

- [ ] Deploy Windows Server VM (2019/2022); promote to DC for `corp.local`
- [ ] Install/confirm DNS for the domain
- [ ] Create AD security group by **sAMAccountName**: `Security-Servers`
- [ ] Create AD security group by **CN**: `Monitoring-Servers` (OU=Servers)
- [ ] Add target server **computer objects** to both groups
- [ ] Include **one disabled** computer object (to prove the `Enabled -eq $true` filter)
- [ ] Add a **nested group** with a computer member (to prove `-Recursive` in CN path)
- [ ] Create service account `corp\svc-pso` for running the script
- [ ] Grant `svc-pso` local admin on target servers (for `C$` access) + write to archive share

## 2. PowerShell Orchestration Host ("PSO host") — *the linchpin*

- [ ] Deploy domain-joined Windows Server VM
- [ ] Install **RSAT Active Directory PowerShell module** (`Import-Module ActiveDirectory` must work)
- [ ] Deploy script to `C:\PSO\Scripts\cvs_functions.ps1`
- [ ] Apply the **3 additive changes** from `code/README.md` (new `move-archived-logs-ByHostList` case + `$HostList` param)
- [ ] Enable PowerShell remoting / WinRM (so vRO PowerShell plugin can connect)
- [ ] **Configure Kerberos constrained delegation** for the double-hop:
  - [ ] Delegate PSO host account → target servers **CIFS** SPNs
  - [ ] Delegate PSO host account → file server **CIFS** SPN
  - [ ] (Fallback: CredSSP, if Kerberos delegation is not feasible in lab)
- [ ] Seed aged `Archive-*.evtx` files locally (for the LocalHost workflow — see §5)

## 3. Target Member Servers (2–3)

- [ ] Deploy 2–3 domain-joined Windows Server VMs
- [ ] Add to the AD groups (mix enabled/disabled objects for the CN test)
- [ ] Confirm `C$` admin share reachable by `svc-pso`
- [ ] Allow SMB (445) from the PSO host through the firewall
- [ ] Seed aged `Archive-*.evtx` files in `C:\Windows\System32\winevt\Logs` (see §5)

## 4. File Server / Archive Share

- [ ] Provide host for the share (can be a role on the DC or its own VM)
- [ ] Create hidden share **`mdcarchivelog$`** → exposed as `\\fileserver.corp.local\mdcarchivelog$\Windows`
- [ ] Add DNS alias `fileserver` (or rename host) to match the default UNC path
- [ ] Grant `svc-pso` modify/write on the share
- [ ] Seed files **older than 370 days** + some recent files (for the Remove-OldFiles test)

## 5. Test Data (filters on `LastWriteTime` — back-date the files!)

- [ ] On each **target** and the **PSO host**, create aged move-test files:
  ```powershell
  1..5 | % { $f="C:\Windows\System32\winevt\Logs\Archive-Application-2024-01-0$_-000000-000.evtx";
             New-Item $f -Force; (Get-Item $f).LastWriteTime=(Get-Date).AddDays(-30) }
  ```
  (Content is irrelevant — the script moves by name/age, it does not parse evtx.)
- [ ] On the **archive share**, seed >370-day-old files **and** recent files for the delete test

## 6. VCF / Aria Orchestrator Appliance

- [ ] Configure PowerShell plugin with the PSO host (Kerberos or CredSSP auth)
- [ ] Create Configuration Element `VCF/WindowsLogManagement/WindowsLogManagement-Config`:
  - [ ] `defaultScriptPath` = `C:\PSO\Scripts\cvs_functions.ps1`
  - [ ] `defaultFileShareTarget` = `\\fileserver.corp.local\mdcarchivelog$\Windows`
  - [ ] `defaultDomainName` = `corp.local`
  - [ ] `defaultLogRetentionDays` = `370`
- [ ] Deploy the 5 actions (`build*Invocation`, `parseScriptOutput`)
- [ ] Deploy the 4 workflows per `code/README.md`

## 7. SMTP (optional — Phase 2 defers email reporting)

- [ ] Provide a test SMTP catcher only if you want to exercise `Send-MailMessage` paths

---

## Pre-flight validation — run on PSO host **as `svc-pso`** before touching vRO

These isolate environment problems from workflow problems.

- [ ] `Get-Module -ListAvailable ActiveDirectory` returns the module
- [ ] `Get-ADGroupMember 'Security-Servers'` resolves to your computers
- [ ] CN group resolves (recursive + enabled-only behaves as expected)
- [ ] `Test-Path \\<target>\C$\Windows\System32\winevt\Logs` → `True` (hop-2 read + delegation)
- [ ] `New-Item` into `\\fileserver.corp.local\mdcarchivelog$\Windows` succeeds (hop-2 write)
- [ ] Run each action directly once, e.g.:
  ```powershell
  & C:\PSO\Scripts\cvs_functions.ps1 -Action move-archived-logs `
    -ADGroupMember Security-Servers -DomainName corp.local `
    -FileShareTarget '\\fileserver.corp.local\mdcarchivelog$\Windows'
  ```
- [ ] **Then** run the same through the vRO PowerShell plugin (confirms the double-hop
      survives the extra vRO → PS-host hop — direct logon testing will not catch this)

---

## Acceptance checks

- [ ] Per-server subfolders auto-created under the archive share
- [ ] Aged `Archive-*.evtx` files moved off targets; recent files left in place
- [ ] CN workflow skips the **disabled** computer object
- [ ] CN workflow includes the **nested-group** member (recursive expansion)
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

Covers all four workflows, both AD resolution styles, the Enabled filter, the
double-hop, and the delete/whatIf logic.
