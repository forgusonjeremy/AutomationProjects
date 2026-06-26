# Session Summary — 2026-06-26

Two workstreams were covered in this session. The bulk of the work was the **VCF Automation 9 AD OU picker** for the VM Deployment Automation project.

---

## Workstream 1 — Ansible → Orchestrator transition lab (Move Windows Event Logs)

**Goal:** Stand up a Windows lab to test vRO/Orchestrator workflows that replace the
existing Ansible "Move Windows Event Logs" playbooks.

**Deliverable:** `…\psscript\Move Windows Event Logs\Lab-Build-Checklist.md`

**Key points captured in the checklist:**
- Defaults baked into the code: domain `corp.local`, archive share
  `\\fileserver.corp.local\mdcarchivelog$\Windows`, script at `C:\PSO\Scripts\cvs_functions.ps1`.
- The vRO design uses a **single PowerShell host** that reaches every target over **UNC
  admin shares** + the **file share** — a **double-hop**. Reproducing that double-hop
  (Kerberos constrained delegation) is the #1 thing the lab must get right; it has no
  analog in the Ansible (per-server WinRM) design.
- Minimum viable footprint: 4 VMs (DC+fileserver, PSO host, 2 targets incl. one disabled
  computer object for the CN filter) + the vRO appliance.
- Test data must be **back-dated** (`Archive-*.evtx` and >370-day files) because the logic
  filters on `LastWriteTime`, not just filenames.

---

## Workstream 2 — VCF Automation 9 AD OU picker (primary work)

### Goal
A custom-form OU dropdown for a VM-deploy catalog item that shows **only the OUs within
the project's configured AD OU** (safer than exposing the whole directory), driven by an
Orchestrator action.

### Deliverables
| File | Purpose |
|---|---|
| `actions/getProjectADChildOUs.js` | vRO action (module `com.broadcom.pso.vcfa.customforms`) — lists child OUs under the project OU |
| `catalog-item-custom-forms/vm-deploy-customform.yaml` | Custom form with the `ouName` dropdown + plumbing fields |
| `summary.md` | This file |

### The hard-won technical findings

**1. VCF Automation 9 authentication is NOT the 8.x flow.**
- 8.x `POST /iaas/api/login` with JSON `{refreshToken}` → returns HTTP 400 `invalid_grant` on VCFA 9.
- Correct VCFA 9 (VM Apps org) flow:
  - `POST {base}/oauth/tenant/<orgName>/token`
  - `Content-Type: application/x-www-form-urlencoded`
  - Body: `grant_type=refresh_token&refresh_token=<token>` (form-encoded, not JSON)
  - Response field: `access_token` (used as `Authorization: Bearer`)
- Use a token with **"Require Rotation" disabled** — rotating tokens are single-use and
  break a stateless form value-source.

**2. vRO AD plugin "default server not set" fix.**
- Static `ActiveDirectory.search(...)` needs a *default* host or it throws
  "default Active Directory server is not set".
- Fix: pass the host explicitly — `Server.findAllForType("AD:AdHost")[0]`, then
  `ActiveDirectory.search("OrganizationalUnit", query, adHost)` (host is the 3rd arg).

**3. The per-project AD OU is NOT exposed by any supported API.**
Confirmed against live payloads:
- `GET /iaas/api/projects/{id}` → no OU (`customProperties: {}`).
- `GET /iaas/api/integrations/{id}` → only the integration-wide `defaultOU` (`dc=vcf,dc=lab`).
- `GET /policy/api/policies` → only a `com.vmware.policy.catalog.entitlement` (Content Sharing) policy.
- The project's Integrations-tab OU (`OU=Jeremy-Project,OU=VCFA-Workloads,dc=vcf,dc=lab`) is
  served only by an **internal, undocumented** endpoint found via browser DevTools:
  `GET {base}/provisioning/uerp/provisioning/activedirectory/api/provider/project/{projectId}?enabled=false`
  This WORKS but is unsupported (`/provisioning/uerp/...` = internal Xenon service) — **rejected** for production use.

**4. DN semantics.** Relative DNs concatenate into an exact full path
(`relativeDN + "," + baseDN`), most-specific component first; they are an exact location,
not a search query, and the OU must already exist.

### Final architecture (supported only, single source of truth)
1. **Project custom property `ad.baseOU`** = the project's base OU (full DN preferred;
   relative DN also accepted and combined with the AD integration Base DN). **One place.**
2. **`getProjectADChildOUs` action** reads that property and returns **FULL DNs** of the
   child OUs (AD plugin enumeration, host passed explicitly). **Fails closed** if the
   property is unset — never lists the whole domain.
3. **vRO workflow at the Compute Allocation event** pre-creates the **computer account** in
   the user-selected OU (AD plugin / OOB "Create a computer in an organizational unit").
   The account name must match the VM name from the event payload.
4. **vCenter customization spec** (referenced in the cloud template) does the OS **domain
   join** (OOB). It must NOT set its own OU, so the machine lands in the pre-staged OU.
5. **Destroy-time workflow** (compute removal event) deletes the AD computer object to
   avoid stale accounts.

This was chosen after establishing that *native AD integration + supported-only +
single-source* cannot all coexist (the native integration's per-project OU isn't
API-readable). Driving the join ourselves makes the picked OU the single source.

### Admin setup (per project, one-time)
On the project, add custom property:
- **Key:** `ad.baseOU`
- **Value:** project OU as a full DN, e.g. `OU=Jeremy-Project,OU=VCFA-Workloads,dc=vcf,dc=lab`

### Form plumbing fields (hidden, set per environment)
`vcfaBaseUrl`, `orgName` (e.g. `vm-apps`), `configElementName` (`vcfa-authentication`),
`configElementAttribute` (the refresh-token attribute), `apiVersion` (`2021-07-15`).
Action input order must match the form's parameter order:
`vcfaBaseUrl, orgName, configElementName, configElementAttribute, projectId, apiVersion`.

### Prerequisites
- REST plugin (transient host), AD plugin + an AD server added to vRO (need not be default).
- Config Element holding the refresh token as a SecureString attribute.

---

## Open / next steps
- [ ] **Build the create-computer workflow** + **Compute Allocation** subscription (AD plugin).
- [ ] **Build the destroy-cleanup workflow** + compute-removal subscription.
- [ ] **Wire the form → template:** bind `ouName` to a cloud-template input and surface it as
      a machine custom property (e.g. `targetAdOU`) so the event payload carries it.
- [ ] **Customization spec** in vCenter (domain join, no `MachineObjectOU`) + reference it in
      the cloud template.
- [ ] Verify-points to confirm on a real provisioning event: the **Compute Allocation event
      topic id** and payload field names (computer name, custom properties), and the OOB
      create-computer workflow's exact inputs in this plugin version.
- [ ] Optional form polish: gate `ouName` visibility on `joinDomain`; friendlier dropdown
      labels (show OU name, submit full DN).

## Quick reference
- Lab: VCF Automation 9, base `https://vcfa.site-a.vcf.lab`, org `vm-apps`,
  domain `vcf.lab`, AD server `ldaps://dc.vcf.lab:636`, integration Base DN `dc=vcf,dc=lab`.
- Test project: `Jeremy` (`d0c83001-147e-42fd-a0df-4d83b1d8abc4`),
  OU `OU=Jeremy-Project,OU=VCFA-Workloads,dc=vcf,dc=lab`.
