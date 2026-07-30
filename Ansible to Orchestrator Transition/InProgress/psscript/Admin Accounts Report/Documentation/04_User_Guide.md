# User Guide — Admin Accounts Report

**Workflow:** `Get-AdminAccountsReport`

---

## 1. What this does

Reports which **privileged ("admin") accounts do not require a smart card to log
on** — i.e. which privileged accounts sit outside PKI enforcement — across every
organisational unit you supply, in one or more domains.

It emails an HTML report and puts the compliant / non-compliant counts in the subject
line.

**It is read-only.** It queries Active Directory and sends an email. It cannot
create, modify, disable or delete any account. There is no "preview" mode because
there is nothing to preview — every run is safe to run.

---

## 2. Running it

1. Open `Get-AdminAccountsReport` and click **Run**.
2. Review the inputs (defaults are set for the production scope).
3. Run. The report is emailed on completion.

Normally this runs on a **schedule**; you only run it by hand for an ad-hoc check or
after changing the OU list.

---

## 3. Inputs

| Input | What to enter |
|---|---|
| **scriptPath** | Full path to `cvs_functions.ps1` on the PowerShell host. Leave the default. |
| **domainOUs** | **One OU distinguishedName per row.** The report scope. See below. |
| **emailReport** | Tick to email the report. Untick to produce it without sending — it still appears in the run log. |
| **smtpServer** | Mail relay. Leave the default. |
| **mailTo** | Recipients — **one address per row**. |
| **mailCc** | Optional CC — one address per row. |
| **mailSubject** | Subject stem. The counts are appended automatically. |

### domainOUs — the most important input

One OU distinguishedName per row. Nothing else:

```
OU=Admin Accounts,OU=Servers,DC=domain1,DC=corp,DC=local
OU=Admin Accounts,OU=Workstations,DC=domain1,DC=corp,DC=local
OU=Admin Accounts,OU=Servers,DC=domain2,DC=corp,DC=local
```

**You do not enter a domain.** It is worked out from the DN itself
(`DC=domain1,DC=corp,DC=local` → `domain1.corp.local`), so it can never disagree with
the OU beside it.

**One domain or seven makes no difference.** Whether the report is split across
domains follows from the DNs you supply — there is no mode to choose. A single-OU
report is simply a list of one.

> **Recipient inputs:** enter **one address per row**, not several in one row. If a
> single address is pasted into a row-based field incorrectly, the run stops with a
> message about an entry with no `@` — that is the guard working.

---

## 4. Reading the report

Top to bottom, deliberately ordered by what you must not miss:

1. **Alerts (only when something is wrong)** — see §5.
2. **Summary** — accounts in scope, smart-card enforced, not enforced, compliance rate.
3. **By domain** — one row per domain with a plain-language status:
   *Fully compliant* · *Action required* · *No accounts found* · *INCOMPLETE*.
4. **Account detail by domain** — a section per domain, then per OU where a domain has
   more than one OU in scope. Non-compliant accounts are listed first.
5. **Scope** — every domain and OU that was searched.

### Columns

| Column | Meaning |
|---|---|
| **Name / Account / UPN** | Who the account belongs to |
| **Smart card enforced** | `True` = compliant. **`False` (red)** = does not require a smart card |
| **Account state** | Enabled or Disabled — see §6 |
| **Created** | When the account was created |
| **Description** | As recorded in Active Directory |

---

## 5. Alerts — what they mean and what to do

### `[INCOMPLETE]` in the subject, red banner at the top

**One or more OUs could not be read. The figures are understated.**

Accounts in those OUs are missing from every count. An OU that failed to return looks
identical to an OU with no findings — so treat the totals as a **floor, not a total**.

The banner names each failed OU and classifies the problem:

| Problem | Meaning | Who fixes it |
|---|---|---|
| **Scope error** | The OU DN is wrong or is not in that domain. A *referral* means the server answered and said "that is not mine". **Deterministic — it will fail every run until the OU list is corrected.** | Whoever maintains the OU list |
| **Access denied** | The service account cannot read that OU | Directory team |
| **Authentication** | Credentials were rejected — check the service account, not the OU list | Service-account owner |
| **Unreachable** | The domain controller could not be contacted. **May clear on its own** | Infrastructure team |
| **Unclassified** | Not a recognised failure. The raw message is shown in full | Investigate |

The failed OU is also flagged in its own section and marked **NOT READ** in the scope
list at the foot of the report.

### Amber notice — "overlapping OU list"

**The figures are correct.** This is informational.

Your OU list contains an OU **and** one of its sub-OUs. Because searches include all
sub-OUs, some accounts came back from both. Each has been **counted once** and listed
under the most specific OU that returned it.

To make the notice go away, remove the redundant entry — usually the parent, if the
child is what you actually want to report on.

---

## 6. Important limits — read before acting on the numbers

| # | Limit |
|---|---|
| 1 | **The report only covers the OUs you supply.** A privileged account outside them is not reported and not counted. The report is only as good as its OU list. |
| 2 | **"Admin account" means "any user account in an admin OU".** There is no filter for privilege, group membership or naming. Service accounts in those OUs are included. |
| 3 | **Disabled accounts are counted as non-compliant.** This is deliberate and matches the existing metric. The **Account state** column shows which they are, so you can see the composition without the number changing. |
| 4 | **There is no exemption list.** An account legitimately exempt from smart-card enforcement is reported every run. |
| 5 | **Accounts with the attribute never set** may not appear at all. The report asks for "required" and "not required" separately; an account that is neither can fall between them. |
| 6 | **Searches include all sub-OUs.** Listing one OU covers everything beneath it, however deep. |
| 7 | **Unread OUs are excluded from every figure** — see the `[INCOMPLETE]` alert. |

---

## 7. Common scenarios

| Scenario | What to do |
|---|---|
| **Add an OU to the report** | Add its DN as a new row in `domainOUs`. Nothing else — a new domain is picked up automatically. |
| **Add a whole new domain** | Add that domain's OU DNs as rows. The report gains a section for it. |
| **Report on one OU only** | Supply one row. No special mode. |
| **Check without emailing** | Untick `emailReport`. The report still appears in the run log and on the PS host. |
| **Change recipients** | Edit `mailTo` / `mailCc` — one address per row. |
| **Counts dropped after go-live** | Expected if the OU list overlapped: de-duplication corrected a previously inflated figure. Check for an amber overlap notice. |

---

## 8. Troubleshooting

| Symptom | Cause | Action |
|---|---|---|
| Run fails immediately, no report | Input rejected — malformed DN, empty scope, bad recipient | Read the error; it names the offending row |
| Fails with "requires a domain/OU map" | `domainOUs` empty | Supply at least one OU DN |
| Fails with "ActiveDirectory module not available" | RSAT missing on the PS host | Directory/platform team |
| Fails at the PowerShell step | PS host unreachable or credentials rejected | Check the host in vRO Inventory |
| **Completed with Errors** | One or more OUs unreadable | Open the report — the banner names them and says who fixes each |
| Report arrives empty, scope looks right | The OUs genuinely contain no accounts, or the attribute is unset (§6 #5) | Confirm against the directory |
| Report not received | `emailReport` unticked, SMTP unreachable, or spam filtering | Check the run log; the report is also on the PS host |
| Report looks unstyled | Mail client stripped the formatting | Content is unaffected; report a rendering issue |
| A domain appears with "No accounts found" | It was queried successfully and returned nothing | Confirm the OU DN is the one you intended |

**Where to look first:** the emailed report explains most problems on its face. The
Orchestrator run log is only needed when the run failed outright and no report was
produced.

---

## 9. Known open items

| Item | Status |
|---|---|
| **"Not enforced" wording** | Placeholder. Tell the project team if your compliance language differs — a labelling change only. |
| **Service-account exemptions** | No mechanism exists. Exempt service accounts appear as non-compliant every run, giving a persistent floor. Options are being reviewed. |
