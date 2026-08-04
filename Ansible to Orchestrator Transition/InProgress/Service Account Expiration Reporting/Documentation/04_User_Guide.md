# User Guide — Service Account Expiration Reporting

**Workflow:** `Get-ServiceAccountExpirationReport`
**Folder:** `Production > Identity > Active Directory > Reporting`

---

## 1. What this does

Reports every service account in a supplied set of organisational units, and tells you
**which have expired and which expire soon**, so they can be renewed before the services
depending on them stop working.

The report is emailed as HTML. It leads with the accounts that need action, then lists the
full inventory beneath.

**It is read-only.** It queries Active Directory and sends an email. It cannot renew,
extend, disable or delete anything it reports on. There is no "are you sure?" step because
there is nothing to be sure about.

> **If you have received this report before, it is about to change.**
> The previous version was silently incomplete — see §7. Expect **more accounts**, a new
> **expiration date** column, and a **different subject line**.

---

## 2. Running it

Two ways:

- **Scheduled** (the normal case) — a recurrent task runs it on a fixed interval with a
  fixed scope. Nobody needs to touch it.
- **On demand** — run the workflow from the vRO client, adjust the inputs, submit.

Runs take roughly as long as the directory takes to answer: seconds for one OU, longer for
a large multi-domain scope.

---

## 3. Inputs

| Input | What it is |
|---|---|
| `scriptPath` | Full path to `cvs_functions.ps1` on the PowerShell host. Leave the default. |
| `domainOUs` | **The report scope.** One OU distinguishedName per row. See below. |
| `expiringWithinDays` | The look-ahead window, in days. Default `30`. See §4. |
| `emailReport` | Send the report. Leave ticked — with it off, nobody is warned about anything. |
| `smtpServer` | Mail relay. Leave the default. |
| `mailTo` | Recipients — **one address per row**. |
| `mailCc` | Optional CC — one address per row. |
| `mailSubject` | The subject stem. The counts are appended automatically. |

### `domainOUs` — the most important input

One **full OU distinguishedName** per row:

```
OU=Service Accounts,DC=corp,DC=local
OU=Service Accounts,OU=Tier1,DC=corp,DC=local
```

- **It must be a full DN**, not a bare OU name. `Service Accounts` will be rejected.
- **Do not enter a domain** — it is derived from the DN's own `DC=` components
  (`DC=corp,DC=local` → `corp.local`). That is why there is no domain input.
- **One domain or several makes no difference.** The report sections itself by whatever
  you supply. Today's scope is a list of one row.
- **Searches include all sub-OUs.** Listing an OU covers everything beneath it.

The run **fails immediately** if a row has no `DC=` component, or if the list is empty —
rather than producing a narrower report and calling it a success.

> If you see a row that is a single character, a plain string was bound to the list input
> and vRO split it into letters. Enter one DN per row.

**Advanced, rarely needed:** a row written `dc01.corp.local|OU=Service Accounts,DC=corp,DC=local`
forces the directory server for that OU. Everything after the first `|` is the DN. Use only
for a cross-forest search base, a domain alias, or when a specific DC must be targeted.

---

## 4. The look-ahead window

`expiringWithinDays` decides what counts as "expiring soon". Default: **30**.

**What it does:** an account expiring within that many days is lifted into the *Expiring*
section at the top of the report and counted in the subject line.

**What it does NOT do:**

- It does **not filter** the report. Every account in scope is always listed in the full
  inventory.
- It does **not affect expired accounts.** Anything already past its expiration date is
  reported regardless.

**Match it to the schedule.** The window must be at least as long as the gap between runs.
With a monthly schedule and a 7-day window, an account can expire in the gap having never
appeared in an *Expiring* section — going straight from Active to Expired between two
reports, with no warning in between.

The window is inclusive at its edge and errs toward warning early: an account 29.6 days
away *is* flagged by a 29-day window.

It must be a whole, non-negative number. `30.9`, `"30 days"` and `-5` are rejected rather
than quietly reinterpreted.

---

## 5. Reading the report

Top to bottom, ordered by what you must not miss:

| Section | What it tells you |
|---|---|
| **Red banner** *(only if something failed)* | One or more OUs could not be read. Every figure below is understated. |
| **Amber notice** *(only if the OU list overlaps)* | Informational. Totals are correct. |
| **Summary** | Accounts in scope · already expired · expiring within the window · no expiry set. |
| **Action required** | The expired and expiring accounts, across all domains, worst first. **This is the part to act on.** |
| **By domain** | One row per domain with a plain-language status. |
| **Full inventory by domain** | Every account, sectioned by domain and sub-sectioned by OU. |
| **Scope footnote** | Exactly which OUs were searched, with any unreadable one flagged `NOT READ`. |

If nothing has expired and nothing is expiring, the *Action required* section says so
plainly. That statement is trustworthy — it is not the same as an empty report.

### Columns

| Column | Meaning |
|---|---|
| **Account / Name / Office** | `sAMAccountName`, display name, office attribute. |
| **Account state** | Enabled, Disabled or **Locked out**. |
| **Expires on** | The account expiration date, or blank if none is set. |
| **Days to expiry** | Whole days remaining. **Negative means already expired** — days overdue. |
| **Status** | Expired · Expiring · Active · Never expires. |
| **Password age (days)** | How long ago the password was set. **"Never set"** means it never has been, or the account must change it at next logon. |
| **Password last set** | The date, or "Never set". |
| **Description** | The account's description — often the only clue to what it is for. |

> **Password age is not password expiry.** It says how *old* the password is, not when it
> expires. The report does not read the domain password policy, so a 400-day-old password
> may be entirely compliant. Treat it as a hygiene signal, not a deadline.

### The subject line

```
Service Account Expiration Report ( 2 expired - 5 expiring within 30 days )
```

Degraded runs are prefixed:

```
[INCOMPLETE] Service Account Expiration Report ( 2 expired - 5 expiring within 30 days )
```

This lets a scheduled report be triaged from the inbox without opening it.

---

## 6. Alerts — what they mean and what to do

### `[INCOMPLETE]` in the subject, red banner at the top

One or more OUs could not be queried. **Their accounts are absent from every figure.** An
account about to expire in an unread OU will not appear here and will not warn anyone.

The banner names each failure and classifies it:

| Problem | What it means | What to do |
|---|---|---|
| **Scope error** | The server answered and said that OU is not its own, or it does not exist. A targeting fault. | **Correct the OU list.** Retrying will not help — it will fail identically every run. |
| **Access denied** | The PowerShell host's service account cannot read the OU. | Grant it read access, then re-run. |
| **Authentication** | The directory rejected the credentials. | Check the PS host service account — password, expiry, lockout. Not an OU-list problem. |
| **Unreachable** | The domain controller could not be contacted. An availability fault. | Check DNS, network path and DC health. **May clear on its own.** |
| **Unclassified** | Not a pattern the report recognises. | Read the detail column and the workflow log. |

The workflow ends **Completed with Errors** — not failed. The rest of the sweep still ran
and the report was still sent.

### Amber notice — "overlapping OU list"

Your OU list contains an OU **and** one of its sub-OUs. Because searches include all
sub-OUs, some accounts were returned twice.

**The totals are correct** — each account is counted once, and listed under the most
specific OU that returned it. The notice exists so you can tidy the list. Remove whichever
entry is redundant and it goes away.

### The run failed outright

The report was not sent. Causes:

- The scope was empty, malformed, or no OU list was supplied.
- The ActiveDirectory module is missing from the PowerShell host.
- The PowerShell host was unreachable.

All three mean nothing could be trusted, so the run fails rather than sending a report that
looks complete.

---

## 7. Important limits — read before acting on the numbers

> Reproduced from the Design Document. These are not visible from the workflow inputs.

1. **Scope is the OU list — nothing else.** A service account outside those OUs is not
   reported. The report is only as good as the list.
2. **"Service account" means "a user object in a service-account OU."** There is no filter
   for account type, naming convention or SPN. A human account parked in one of those OUs
   is reported as a service account.
3. **"Expiration" means the ACCOUNT expiration date** — when the account stops being able
   to authenticate. Not password expiry.
4. **Password age is age, not a deadline.** See §5.
5. **"Never expires" is the AD default, not a finding.** Most accounts have no expiration
   date. It is shown as its own state so you can see how much of the estate has none — an
   account that never expires also never prompts a review — but it is not counted as
   expired or expiring.
6. **Disabled and locked-out accounts are included**, and a disabled expired account still
   counts in the expired figure. The Account state column shows the composition.
7. **Unread OUs are excluded from every figure.** The totals are a **floor, not a total**.
8. **Read-only, always.** Nothing is ever modified.
9. **Searches are fully recursive.** Listing an OU covers everything beneath it.
10. **Overlapping OUs are de-duplicated**, so the figures stay correct whatever the list
    contains.
11. **The window does not filter the report.** It decides what is called out, not what is
    listed.

---

## 8. Common scenarios

| Scenario | What to do |
|---|---|
| **"An account expired and we were never warned"** | Check the scope footnote — was its OU in the list, and was it read? Then check the window against the schedule interval (§4). |
| **Adding a new service-account OU** | Add a row to `domainOUs`. Nothing else changes — including if it is in a different domain. |
| **Wanting more notice** | Raise `expiringWithinDays`. Nothing is lost; more accounts move into the *Expiring* section. |
| **Only wanting today's expiries** | Set `expiringWithinDays` to `0`. The full inventory is still listed. |
| **An account is meant to expire** | It will be reported every run until it does. There is no exemption list — see §10. |
| **Testing a change without emailing anyone** | Untick `emailReport`. The report is still written to the Debug folder on the PowerShell host. |
| **Reviewing the format before recipients see it** | Ask for the rendered samples — four are generated offline, no lab needed. |

---

## 9. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Run fails immediately, no email | Bad input — empty scope, a row with no `DC=`, a recipient with no `@`, or a non-integer window. The error names the offending row. |
| "ActiveDirectory module not available" | RSAT is missing from the PowerShell host. |
| `[INCOMPLETE]` every run, same OU | A **scope error** — that OU DN is wrong or does not exist. Retrying will never fix it. |
| Report arrives empty but succeeds | The OUs were read and genuinely hold no accounts. Check the scope footnote for what was actually searched. |
| Far more accounts than the old Ansible report | **Expected.** The old report silently omitted accounts requiring a smart card (§7 of the Executive Summary). |
| An expected account is missing | Is its OU in `domainOUs`? Was that OU read (check the footnote)? Is it a user object? |
| Report unstyled or mangled in Outlook | All styling is inline for exactly this reason. Report it with the raw HTML from the Debug folder. |
| Inbox rule stopped matching | The subject line changed — it now carries counts, and `[INCOMPLETE]` on degraded runs. |

---

## 10. Known open items

| Item | Status |
|---|---|
| **Password expiry vs password age** | The report cannot say when a password expires — only how old it is. Adding true expiry means reading the domain password policy. Awaiting a customer decision. |
| **No exemption list** | An account deliberately scheduled to expire is reported every run until it does. Options: an exemption input, a `Description` convention, or accepting the noise. Awaiting a customer decision. |
| **Is the OU list complete?** | The report finds accounts in the OUs supplied. If service accounts live elsewhere in the directory, they are invisible to it. Worth confirming. |
