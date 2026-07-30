# Design Document — Admin Accounts Report

**Platform:** VCF Automation 9 / VCF Operations Orchestrator 9
**Workflow:** `Get-AdminAccountsReport`
**Script action invoked:** `Get-AllAdmin-Accounts` in `cvs_functions.ps1`

---

## 1. Architecture overview

```
[Operator / Schedule]
        │  OU DN list + mail settings
        ▼
┌───────────────────────────────────────────────────────────────┐
│ VCF Orchestrator — Get-AdminAccountsReport                    │
│                                                               │
│  Set Log Marker                                               │
│      ▼                                                        │
│  buildAdminAccountsReportInvocation   (action)                │
│      • groups OU DNs by DERIVED domain                        │
│      • validates, warns, encodes JSON                         │
│      ▼ invocationString                                       │
│  Invoke a PowerShell script  (OOTB)  ──catch──► Throw ► FAILED│
│      ▼ psRawOutput                                            │
│  Set Execution Context                                        │
│      ▼                                                        │
│  parseScriptOutput  (shared action)                           │
│      ▼ parsedResult                                           │
│  Decision: success? ──true──► Log Success ► END               │
│                     └─false─► Log Failures ► END (w/ errors)  │
└───────────────────────────────────────────────────────────────┘
        │ WinRM / HTTPS / Kerberos
        ▼
┌───────────────────────────────────────────────────────────────┐
│ PowerShell host  (Orchestrator's own — see §7)                │
│   cvs_functions.ps1  -Action Get-AllAdmin-Accounts            │
│     Resolve-DomainOUsMap                                      │
│     Get-ListOfUsers-MultiDomain   ──LDAP──► Domain Controllers │
│     Remove-DuplicateAccounts                                  │
│     GenerateReportPKI-v2          ──SMTP──► Recipients         │
└───────────────────────────────────────────────────────────────┘
```

**Division of responsibility.** Orchestrator assembles scope, passes values, and
classifies the transcript. Every directory query, the compliance split, the counts,
de-duplication, report rendering and mail delivery happen inside the PowerShell
script. This mirrors the other workflows in the transition and keeps the proven
script as the single source of behaviour.

---

## 2. Components

| Component | Location | Role |
|---|---|---|
| `Get-AdminAccountsReport` | Workflow | Orchestration, end-state routing |
| `buildAdminAccountsReportInvocation` | Action, module `com.broadcom.pso.vcf.identity.ad.accounts.adminReport` | Validates inputs, derives domains, builds the invocation string |
| `parseScriptOutput` | Action, module `com.broadcom.pso.vcf.vm.guestOps.files.windows.logs` | **Shared** — classifies the transcript. Package dependency |
| *Invoke a PowerShell script* | OOTB library workflow | Executes on the bound PS host |
| `cvs_functions.ps1` | PowerShell host | All directory work and reporting |
| PowerShell plug-in host | vRO Inventory | Pre-bound workflow **attribute**, not an input |

### Script functions used

| Function | Role |
|---|---|
| `Resolve-DomainOUsMap` | Parses the scope from inline JSON (`-DomainOUs`) or a file (`-DomainOUsFile`) |
| `Get-ListOfUsers-MultiDomain` | Sweeps every OU in every domain; tags results with source domain/OU; records failures |
| `Get-ADFailureCategory` | Classifies a failed query and supplies remediation guidance |
| `Remove-DuplicateAccounts` | Collapses accounts returned by more than one OU search |
| `GenerateReportPKI-v2` | Renders the sectioned HTML report |
| `Format-HtmlTable`, `Format-PKIAccountTable` | Inline-styled table rendering |

---

## 3. Data flow

1. **Scope in.** `domainOUs` is a flat list of OU distinguishedNames.
2. **Domain derivation.** The action derives each OU's domain from that DN's own
   `DC=` components (`DC=corp,DC=example,DC=local` → `corp.example.local`) and groups
   the OUs by it. A DN already contains its domain; asking for it separately would be
   redundant entry that can disagree with the DN beside it.
3. **Encoding.** The grouped map is JSON-encoded and embedded in the invocation,
   single-quoted for PowerShell.
4. **Execution.** The script parses the map and, for each OU, runs **two**
   `Get-ADUser` sweeps at `SearchScope Subtree`: `SmartcardLogonRequired -eq $true`
   (compliant) and `-eq $false` (non-compliant).
5. **Tagging.** Each returned account is tagged with its source domain and OU.
6. **De-duplication.** Accounts returned by more than one OU search are collapsed to
   one entry, kept under the deepest (most specific) OU.
7. **Counts.** Taken **after** de-duplication, so the subject line and report body
   cannot disagree.
8. **Report.** Sectioned by domain, then by OU where a domain has more than one.
9. **Classification.** Orchestrator scans the transcript for `Error:` lines and
   routes to the appropriate end state.

### Why the scope is passed inline

The Ansible playbook wrote the scope to a temp file with `win_copy` and passed
`-DomainOUsFile`. Orchestrator invokes a **pre-staged** script and has no equivalent
staging step, so the map is passed **inline** via `-DomainOUs`. The file path remains
supported in the script for the legacy playbook.

---

## 4. Scope semantics — what the report does and does not cover

> **Required reading for anyone interpreting the figures.** These assumptions are not
> visible from the workflow inputs.

| # | Behaviour | Detail | Configurable |
|---|---|---|---|
| 1 | **Scope is the OU list, nothing else** | Only supplied OUs are searched. A privileged account elsewhere is not reported and not counted. The report is only as good as its OU list. | Yes — `domainOUs` |
| 2 | **"Admin account" means "user object in an admin OU"** | The query applies **no** filter for privilege, group membership or naming. Service accounts in those OUs are included. | No — inherent |
| 3 | **Disabled accounts are counted** | A disabled account without smart-card enforcement **is** in the non-compliance figure. Confirmed as the intended metric. The **Account state** column makes the composition visible; the count is unchanged. | No — deliberate |
| 4 | **No exemption mechanism** | A legitimately exempt account is reported every run. No allow-list exists. **Open item.** | No |
| 5 | **Two sweeps per OU, not one** | Each OU is queried for `-eq $true` then `-eq $false`. An account whose attribute is **not set at all** may appear in neither, and so be absent from the report. Inherited behaviour, preserved. | No |
| 6 | **Searches are fully recursive** | All queries use `-SearchScope Subtree`, which returns the search base **and every descendant at any depth** — not just immediate children. Listing one OU covers everything beneath it. | No — inherited |
| 7 | **Overlapping OUs are de-duplicated** | A consequence of #6: listing a parent **and** a descendant returns the deeper accounts from both searches. Each account is counted **once**, under the deepest OU that returned it, and an informational notice explains what was collapsed. | Automatic |
| 8 | **Unread OUs are excluded from every figure** | A failed OU contributes no rows. Totals are a **floor, not a total** — hence the `[INCOMPLETE]` marking. | No |
| 9 | **Read-only, always** | Only `Get-ADUser` runs. Nothing is created, modified or deleted. No safety gate is required. | No |

### 4A. `Set-L3-Admin-Accounts` — unreachable by design

`cvs_functions.ps1` contains a `Set-L3-Admin-Accounts` case that performs a **bulk
write**:

```powershell
Get-AdUser -Identity $($user) | Set-AdUser -SmartcardLogonRequired $True
```

It is **absent from the `-Action` `ValidateSet`**, so the parameter is rejected before
dispatch and the case can never execute.

**This omission is the only control preventing an unattended mass write across the
admin OUs.** It resembles an oversight — synchronising the `ValidateSet` with the
`switch` "for tidiness" would silently arm it. Do not add `Set-L3-Admin-Accounts` (or
`Get-Users-SCenable`, unreachable for the same reason) without a separate, reviewed
change.

---

## 5. Failure handling

| Condition | Behaviour | End state |
|---|---|---|
| Invalid input (malformed DN, bad recipient, empty scope) | Action throws before the PS link | Run faults at the action |
| PS host unreachable | Catch path | **Failed** |
| ActiveDirectory module missing | Script throws | **Failed** |
| Scope empty or unparseable | Script throws | **Failed** |
| **One OU cannot be queried** | Logged, **classified**, surfaced on the report; remaining OUs still swept; report still sent, subject prefixed `[INCOMPLETE]` | **Completed with Errors** |
| Scope valid but no accounts | Warning; empty report sent **with** its scope footnote | Success |
| Overlapping OU list | De-duplicated; informational notice; figures correct | Success |

**The asymmetry is deliberate.** A **scope** problem fails the run outright — nothing
can be trusted. A **per-OU** problem completes with errors and still delivers a report
that names what is missing.

### Failure classification

| Category | Meaning | Owner |
|---|---|---|
| **Scope error** | OU DN wrong or not in this domain. A *referral* means the server answered and said the naming context is not its own — deterministic; retrying never helps | OU list owner |
| **Access denied** | Service account cannot read the OU | Directory owner |
| **Authentication** | Credentials rejected | Service-account owner |
| **Unreachable** | DC could not be contacted — may clear on its own | Infrastructure |
| **Unclassified** | Unrecognised message; raw text shown in full | Investigate |

Classification matches on the exception **message**, with the exception **type** as a
corroborating hint only. Unrecognised failures degrade to *Unclassified* with the raw
text intact rather than being mislabelled. Every failure record carries the exception
type verbatim so the real type names can be **observed** during lab validation.

**Known limitation:** message matching is locale-sensitive. A non-English domain
controller would fall through to *Unclassified* — the safe degradation, but confirm
during validation if the estate is not English-language.

---

## 6. Dependencies

- **PowerShell plug-in host** registered in vRO, with the ActiveDirectory module
  (RSAT) installed.
- **`cvs_functions.ps1`** deployed to that host, carrying changes **S-16 … S-21**.
- **Package dependency:** `parseScriptOutput` from the Event Log package's module.
- **Service account** with directory read rights over every OU in scope.
- **SMTP relay** reachable from the PS host, accepting mail from it.
- **DNS/LDAP** connectivity from the PS host to every domain in scope.

---

## 7. Security considerations

- **Read-only.** Only `Get-ADUser` is issued. The bulk-write capability in the same
  script is unreachable (§4A) and must stay so.
- **Least privilege.** The service account needs directory **read** only. It does not
  need write, and should not have it.
- **The report contains privileged account names.** Treat the distribution list as
  sensitive: it enumerates exactly which privileged accounts lack smart-card
  enforcement — useful to an attacker. Restrict recipients and consider whether the
  report should traverse external mail infrastructure.
- **Report copies on the PS host.** `PKI_result.html` is written to the Debug folder
  and **overwritten** each run (not appended), bounding both disk growth and the
  window of exposure. Secure that folder.
- **Credentials** are held by the PowerShell plug-in host configuration, not in
  workflow inputs.
- **Mail is unauthenticated and unencrypted** unless the relay enforces otherwise —
  standard for the existing automation, but worth confirming given the content.

---

## 8. Operational considerations

- **Scheduling.** This is a recurring compliance report. Use the OOTB scheduling
  mechanism; all inputs are static per environment, so the schedule carries the scope.
- **Triage by subject line.** `[INCOMPLETE]` means figures are understated. Its
  absence means the scope was fully read.
- **Run duration** scales with OU count and account volume — two LDAP sweeps per OU.
- **A run that ends "Completed with Errors" still produced a report.** Treat it as
  under-reporting, not as no report.
- **Report shape changes** from the current Ansible output; brief recipients before
  the first scheduled send.
- **Expect a possible count drop** on the first run if the OU list overlaps — that is
  de-duplication correcting an inflated figure.

---

## 9. Assumptions

1. The supplied OU DNs exist and the service account can read them.
2. Every domain in scope is reachable over LDAP from the PS host.
3. `SmartcardLogonRequired` is the customer's authoritative PKI-enforcement signal.
4. Disabled accounts remaining in the non-compliance count is the intended metric
   (confirmed).
5. Recipients read the report in Outlook — hence inline table styling rather than a
   stylesheet.
6. The Orchestrator and Ansible estates remain on separate PowerShell hosts.
