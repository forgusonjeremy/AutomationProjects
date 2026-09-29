# Execution Model — vCenter Guest Operations

> **NOT THE CURRENT MODEL — deferred 2026-08-18.** The transition stays on the **PowerShell
> plug-in over WinRM**, with scripts copied from Resource Elements by `stageScriptOnHost`
> and the per-domain `PowerShellHost` object selected per run (**P-52 is back on**).
>
> **Why:** time to delivery, and who does the work. Getting off Ansible quickly matters more
> than the architectural gains below, and the team being recruited to run this maintains the
> Ansible estate today. Asking them to learn Orchestrator is one change; asking them to
> learn Orchestrator *and* accept a refactor of the scripts and the execution model is
> several. The WinRM route maps 1:1 onto what they already operate.
>
> **The analysis stands and nothing here is wrong** — §2.1 (no second hop), §2.2 (per-run
> identity) and §2.3 (`envVariables`) are all real advantages, and the accompanying actions
> were removed only so the shared module contains nothing the incoming team must learn.
> They are fully specified below and can be rebuilt from this document.
>
> **Scope, settled 2026-08-18.** A hybrid was considered — guest operations for the two
> playbooks that use `microsoft.ad.user` directly rather than wrapping `cvs_functions.ps1`
> (Service Account Password Rotation, and its `dev` variant). **Rejected.** Rotation stays on
> the psHost model, so guest operations have no consumer and the programme keeps **one
> execution model across all seven projects**. Reasons, in order of weight:
>
> 1. **The secret would touch disk.** Guest operations have no output channel except a file
>    in the guest, so the generated password would be written, transferred and deleted —
>    against a design whose premise is a single controlled exposure point with the password
>    travelling upward in a return value. Acceptable for a report; a regression here.
> 2. **Rotation is Tier 1.** One domain per run, so the host object already *is* the identity
>    mechanism. What guest operations do best is what P-52 already solves for this project.
> 3. **Five actions are already built on it**, including `resolvePowerShellHostForDomain` —
>    the action the four remaining Tier 1 projects are about to depend on.
> 4. **Its second hop has a cheaper answer.** S-25 is new code, so it can take `-Credential`,
>    exactly as `microsoft.ad.user` does (`adds_password_reset.yml:10-11` passes
>    `domain_username`/`domain_password` and never relies on delegation). If delegation fails
>    for password writes, that is one parameter, not an architecture.
>
> One model is worth more than the individual gains below: one Build Guide, one staging
> action, one troubleshooting path, and no question that starts "which kind of workflow is
> this?" — which matters most when the people running it are learning Orchestrator.
>
> **Revisit when:** the delegation configuration in §2.1 becomes a problem — §6.3 of
> `Script-Staging-Design.md` is the test that would tell you — or a target is not reachable
> by WinRM. This document is the contingency, with the analysis already done.
>
> **P-62, P-63 and P-64 are withdrawn** with this deferral.

**Status:** Deferred — retained as the documented alternative
**Would replace:** the PowerShell plug-in / WinRM execution model
**Change IDs:** P-62, P-63, P-64 *(withdrawn)*; would retire **P-52**

---

## 1. Decision

Scripts are copied into the guest and executed there through **vCenter Guest Operations**
(VMware Tools), not invoked over WinRM through the PowerShell plug-in.

```
InitiateFileTransferToGuest   ->  copy the script (and its scope map) in
StartProgramInGuest           ->  powershell.exe -File <script> <args>, stdout+stderr to a file
ListProcessesInGuest          ->  poll until exitCode is set
InitiateFileTransferFromGuest ->  retrieve the transcript
DeleteFileInGuest             ->  clean up
```

That is the Ansible playbook, element for element — `win_copy`, `win_command`, `win_file:
absent` — reproduced with a purpose-built API instead of a hand-rolled one.

---

## 2. Why this is better than what was delivered

### 2.1 It removes the second hop

§6 of `How-To-Build-a-PowerShell-Host.md` — Kerberos constrained delegation, CredSSP, the
forwardable-ticket checklist, the `ADServerDownException` row in the troubleshooting table —
exists solely because a WinRM session cannot forward its credential to a network resource.
Every AD query in this family (`Get-ADUser -Server <domain>`) and every UNC operation in
Move Windows Event Logs is that second hop.

Guest operations supply a **password**, not a delegated ticket. VMware Tools performs a
network-capable logon, so the process can obtain its own tickets. The delegation work, and
the class of failure it exists to prevent, both disappear.

**The distinction, stated precisely** (customer's framing, 2026-08-18, and it is the right
one): *Run Script in Guest* is like **logging on to the console and running the script from
a command prompt**. It is not a remote session. That is not a detail — it is the entire
mechanism. A logon performed **with the password** yields a token holding primary
credentials, so the session can authenticate onward to a DC or a file share exactly as a
person sitting at the console could. A WinRM **network logon** receives proof of identity
only, with no credential to forward — which is what makes the second hop fail, and what
Kerberos delegation or CredSSP exists to work around.

So the two models are not "remote vs. slightly different remote". They are *console logon*
versus *network logon*, and every second-hop consequence in this document follows from that
one difference.

### 2.2 It restores per-run identity selection — the root cause of P-51

The multi-domain defect was never really about host objects. It was that **AAP varied the
account per job template** and vRO had nowhere to put that variation, so it bound one
identity everywhere.

Guest operations take the credential as a **parameter of the call**. The workflow chooses
the identity for the domain it is targeting, per run. That is AAP's mechanism, recovered
directly.

**P-52 is retired, not implemented.** No `PowerShellHost` object per domain identity, no
`PSO/Identity/Domains` host-name map, no `resolvePowerShellHostForDomain`. Four Tier 1
projects lose their remediation rather than gaining one.

### 2.3 It closes §5.2's "one genuine gap"

The remediation plan recorded a gap in porting the customer's v3 credential pattern:

> AAP set those environment variables from the job template under `no_log: true`. vRO's OOTB
> *Invoke a PowerShell script* takes a script string, so setting `$env:AD_CRED_X_PASS = '...'`
> inside it would put the secret in the invocation string — the most-logged value in this
> family of actions.

`VcGuestProgramSpec` has an **`envVariables`** field: `NAME=value` entries applied to the
process being started. `AD_CRED_<KEY>_USER` / `AD_CRED_<KEY>_PASS` go there — an API call
field, not a command line. Not in the transcript, not in the process arguments, not staged
machine-wide.

This is better than either option §5.2 offered, and it is *exactly* what Ansible's
`environment:` + `no_log: true` did. **P-64.** The machine-level staging obligation, and its
WinRM-restart footgun, both go away.

### 2.4 The file copy is native

`InitiateFileTransferToGuest` takes arbitrary size and content. No base64, no 48 KB
chunking against a WinRM envelope, no here-strings.

### 2.5 A real exit code

`ListProcessesInGuest` returns `exitCode` once the process ends. This family has never had
one: the playbooks run `win_command` with no `failed_when` at all, and the delivered vRO
design infers status by scanning the transcript for `Error:` lines. `parseScriptOutput`
stays — the transcript still carries the detail — but it is no longer the only evidence
that a run failed.

**Correction to an earlier claim:** the column-wrapping caveat does **not** go away.
PowerShell wraps redirected output at a default width whatever the transport, so the
transcript is still written with `*>&1 | Out-File -Width 4096` and a wrapped `ERROR:` line
would still be one `parseScriptOutput` could miss. What genuinely improves is the exit code,
stderr being captured deliberately rather than merged and hoped for, and no dependence on
the PowerShell plug-in's return-value semantics.

---

## 3. What it costs

| Cost | Detail |
|---|---|
| **Output retrieval is work** | `StartProgramInGuest` returns a PID, not stdout. Redirect → poll → fetch → delete is four elements plus a timeout, against one OOTB element today |
| **vRO holds guest credentials** | Reverses §5.2's "nothing crosses from Orchestrator". One credential per domain identity, held as SecureStrings, passed per call |
| **Tier 2 is still not one-identity-per-domain** | One process is one identity. The eight-domain admin sweep still needs `AD_CRED_*` for `rootdomain.net` — now via `envVariables` (§2.3) rather than machine staging |
| **Privilege** | `VirtualMachine.GuestOperations.{Query,Modify,Execute}` is arbitrary code execution as any account whose password vRO holds. A security review item, not a checkbox |
| **Prerequisites** | The PS host must be a VM in a vCenter that vRO manages, with current VMware Tools. The Build Guide only ever assumes "domain-joined Windows Server" — it never assumes a VM. **Confirm before build.** |

---

## 4. Workflow schema

```
[ build<X>Scope ]            -> scopeJson          (validation lives here)
[ writeGuestFile ]           scopeJson  -> <workDir>\scope.json
[ stageScriptInGuest ]       Resource Element -> <scriptPath>, marker-idempotent
        |                    -> scriptVersion      (workflow OUTPUT)
[ build<X>Arguments ]        -> argumentString     (references <workDir>\scope.json)
[ invokeGuestScript ]        -> exitCode           (starts, polls, times out)
[ readGuestFile ]            <workDir>\transcript.txt -> transcript
[ parseScriptOutput ]        (shared, unchanged)
[ cleanup ]                  delete scope.json + transcript.txt   (always)
```

`workDir` is a per-run directory — `C:\PSO\Work\<workflowRunId>\` — created and removed by
the workflow, mirroring Ansible's `win_tempfile` + `win_file: absent`. The **script** is
staged to a stable path and left there (idempotent, version-checked); the **per-run files**
are transient. That split is deliberate: the script is the thing worth version-checking, the
scope map is the thing worth throwing away.

### 4.1 P-63 — the scope map goes back to a file

Both delivered builder actions pass the domain map as **inline JSON**, and both say why:

> `-DomainOUsFile` is deliberately NOT used: it is the legacy Ansible path… Orchestrator
> invokes a pre-staged script and has **nowhere to write that file**, so the map goes inline.

That rationale is now void — and inline JSON is actively wrong here. `StartProgramInGuest`
passes `arguments` to Windows, which parses them with `CommandLineToArgvW` **before**
PowerShell sees them. That parser honours double quotes only; single quotes are ordinary
characters. So the PowerShell-style `-DomainOUs '{"a":["b"]}'` quoting the delivered actions
build would arrive with its single quotes intact and its double quotes fighting the parser.

This is almost certainly why the Ansible playbooks wrote `domain_ous.json` with `win_copy`
and passed `-DomainOUsFile` in the first place. With guest operations we can do the same
thing, so we do: **`-DomainOUsFile` / `-ScopeMapFile`, not inline JSON.**

### 4.2 Argument quoting

Everything else is passed on the command line and must be quoted for `CommandLineToArgvW`:
wrap each value in **double** quotes, double any embedded backslash run that precedes a
quote, escape embedded double quotes as `\"`. In practice the remaining values are mail
addresses, `yes`/`no` flags, a subject line and paths — no JSON — so the quoting stays
simple. The builder actions own it; nothing else constructs arguments.

---

## 5. Credential model

**One vRO credential per domain identity, chosen per run** (customer-confirmed 2026-08-17).

| Layer | Holds | Used for |
|---|---|---|
| Guest credential | Domain account, one per domain identity | The `NamePasswordAuthentication` for every guest-ops call. Becomes the **ambient identity** of the script |
| `AD_CRED_<KEY>_*` | Per-domain AD credentials | Injected via `envVariables` for Tier 2 sweeps only, where one process must reach a domain its ambient identity cannot |

Stored as `SecureString` attributes in a Configuration Element under `PSO/Identity/Domains`,
one per domain — the element the Tier 1 remediation was going to use for host names now
holds credentials instead. **Never bind either to a workflow output or a logged variable.**

For a Tier 1 workflow the guest credential alone is the whole answer: run the process as the
account with rights in the target domain, exactly as the matching AAP template did.

---

## 6. Per-project impact

| Project | Tier | Change |
|---|---|---|
| Admin Accounts Report | 2 | Built on this model from the start. Guest credential = the `company` identity; `rootdomain.net` via `envVariables` |
| Service Account Expiration | 2 | Same. `subdomain8.net` may need `envVariables` or its own run |
| Move Windows Event Logs | 1 | **Gains most.** UNC file moves are the second hop §2.1 removes; P-52 binding work is dropped |
| Server Reboots | 1 | **Needs its own completion model** — see below |
| Servers Reboot Report by CN | 1 | Straight port; P-52 dropped |
| Windows Server Clean Disks | 1 | Straight port; P-52 dropped |
| Service Account Password Rotation | 1 | Straight port. `extractRotatedPassword`'s "single marked line" contract is unchanged — it now reads a transcript file instead of a plug-in return value |
| VM Snapshots Cleanup | — | vCenter-native, unaffected |

**Server Reboots.** The guest-ops channel dies with the guest it is rebooting: VMware Tools
stops, the process cannot be polled, and the transcript may not be retrievable. This is not
worse than WinRM — that connection dies too — but it needs stating rather than inheriting.
Detect completion from **outside** the guest (`VcVirtualMachine.guest.toolsRunningStatus`
returning to `guestToolsRunning`, then a heartbeat), and treat a lost channel during the
reboot window as expected rather than as failure. Design it when project #2 is re-worked;
do not let the reporting workflows set a precedent for it.

---

## 7. Shared actions

| Action | Returns | Purpose |
|---|---|---|
| `stageScriptInGuest` | string (version) | Resource Element → guest. Reads the deployed `# PSO-SCRIPT-VERSION:` marker first and transfers only on a difference (S-29) |
| `writeGuestFile` | string (path) | A string → a guest file. Used for the scope map |
| `invokeGuestScript` | number (exit code) | `StartProgramInGuest` + poll to completion with a timeout. Takes `envVariables` |
| `readGuestFile` | string | Guest file → string. Used for the transcript |

**Reference them, do not copy them** — the rule already set for
`resolvePowerShellHostForDomain`, which these replace.

---

## 8. Prerequisites and build-guide delta

`How-To-Build-a-PowerShell-Host.md` needs a substantial revision. What **drops**:

- WinRM listener, HTTPS certificate, ports 5985/5986, `TrustedHosts`, the certificate-expiry
  maintenance item (§5 of the delivered design docs)
- §6 entirely — Kerberos constrained delegation / CredSSP
- The manual script copy and its NTFS Write requirement
- The machine-level `AD_CRED_*` staging and the WinRM-restart footgun

What **is added**:

- VMware Tools present, current, and running; the host is a VM in a managed vCenter
- `VirtualMachine.GuestOperations.{Query,Modify,Execute}` for the vRO vCenter service account,
  scoped to the PS host VM(s) only — **not** the whole inventory
- Each domain identity granted local logon (or *Log on as a batch job*) on the guest, plus
  its AD rights in the target domain
- `C:\PSO\Scripts\` (Read & Execute) and `C:\PSO\Work\` (writable), plus `C:\PSO\Logs\` once
  S-28 moves the debug output off `$PSScriptRoot`

**S-28 still applies.** Per-run working directories mean the transient files are cleaned up,
but the scripts' own `$Global:DebugDir = "$PSScriptRoot\Debug"` writes are not transient —
they still accumulate against a stable script path, and the five `out-File -append` sites
still append forever.

---

## 9. Validation

| # | Check | Expected |
|---|---|---|
| **G-1** | VMware Tools status on the PS host VM | `guestToolsRunning`, current version |
| **G-2** | Guest-ops privilege, scoped | vRO service account can run a program on the PS host VM and **cannot** on an unrelated VM |
| **G-3** | `InitiateFileTransferToGuest` end to end | 60 KB script lands byte-identical; check the returned URL's host (a `*` placeholder must be substituted with the vCenter/ESXi FQDN — a known wrinkle) |
| **G-4** | Marker idempotence | Second run transfers nothing; bumping the Resource Element transfers once |
| **G-5** | Exit code | A script `exit 2` surfaces as `exitCode = 2`, not as a transcript string |
| **G-6** | Transcript retrieval | stdout **and** stderr both present; non-ASCII intact |
| **G-7** | `envVariables` | `AD_CRED_X_USER` visible to the process; **absent** from the transcript, the arguments and the machine environment |
| **G-8** | Identity | `whoami` in the guest returns the credential passed, not the vRO service account |
| **G-9** | Second hop | `Get-ADUser -Server <other domain>` succeeds with **no** delegation configured — the §2.1 claim, tested |
| **G-10** | Timeout | A script that hangs is abandoned at the timeout with a clear failure, and its PID reported |
| **G-11** | Cleanup | `workDir` removed on success **and** on failure |

**G-9 is the one to run first.** It is the largest single claim made for this model, it is
cheap to test, and if it does not hold the delegation work comes back.
