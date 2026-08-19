# Script Distribution — Architecture Decision

> **SUPERSEDED as a transport, 2026-08-17.** Option C was chosen, then the execution model
> itself changed: scripts are copied and run through **vCenter Guest Operations**, not WinRM.
> See `_Shared/Documentation/Execution-Model-GuestOps.md`.
>
> What survives from this document: GitLab remains the source of truth, the script body lives
> in a vRO **Resource Element** synced by CI, and the **S-29 version marker** answers "which
> generation ran". What does not: the base64-chunked push over the PowerShell plug-in, which
> `InitiateFileTransferToGuest` does natively. The options analysis below is kept because the
> reasoning that rejected A, B, D and E still applies to the guest-ops transport.
>
> **§5's S-28 finding stands in full and is not affected by any of this.**

**Status:** Decided — option C, then re-based onto guest operations (above)
**Raised:** 2026-08-17, during the Admin Accounts Report consolidation
**Affects:** All seven transitions. Supersedes the "pre-staged script" assumption
recorded as **P-1**, **P-9**, **P-20** and in
`Move Windows Event Logs/_Shared/Documentation/Ansible-to-vRO-MappingTable.md:47,74`

---

## 1. The question

Ansible ships the script to the target **every run**. Orchestrator, as delivered,
invokes a copy that was **hand-placed once**. The Ansible model has a real
supportability property the delivered model gives up: *update the script in one place
and every consumer picks it up on its next run.*

The property is not the file copy itself. It is that **GitLab is the source of truth and
the runtime resolves against it**. AAP performs an SCM update at job launch, so a merge
to the repo is live on the next run, everywhere, with no deployment step.

---

## 2. What each side actually does today

### Ansible

```yaml
- win_tempfile: state=directory        # register: tempdir
- win_copy: src=files/ps_scripts dest={{ tempdir.path }}
- win_stat: path={{ tempdir.path }}\ps_scripts\{{ var_ps_script_file }}
- win_command: powershell.exe -File "...\{{ var_ps_script_file }}" -Action ...
- win_file: state=absent path={{ tempdir.path }}     # always:
```

Per run: fresh temp directory → copy the **entire** `files/ps_scripts` folder (~25
scripts, ~600 KB, not just the one being run) → existence check → execute → delete.
Nothing persists. The project content itself came from GitLab at job launch.

### Orchestrator (as delivered)

`Configure-vROPSHost.ps1` creates `C:\PSO\Scripts\` and ACLs it for the service
account, then warns:

> `cvs_functions.ps1 must be manually copied to $ScriptDeployPath - this script does not deploy it.`

The workflow's `scriptPath` input points at that copy. Nothing in Orchestrator knows,
records or verifies **which generation** of the script it just executed.

---

## 3. Three consequences of the delivered model

**3.1 The deployed generation is unverifiable — and this is already biting.**
`Completed/Master-Change-Register.md:217` records the programme's own version confusion:
*"Which generation is deployed remains unconfirmed in each case."* Every workflow in this
family depends on script-side changes (S-1, S-6…S-13, S-16…S-27). A run against a script
lacking its change does not fail — it silently behaves like the old version. The
Validation plans work around this with `Select-String` probes
(`05_Validation_and_Testing_Plan.md:25`), which is a manual check standing in for a
missing guarantee.

**3.2 Pre-staging turned a harmless line into a defect.**
`cvs_functions*.ps1` writes its debug artefacts beside itself:

```powershell
$Global:DebugDir = "$($PSScriptRoot)\Debug"
...
$body | out-File -append -FilePath "$($Global:DebugDir)\PKI_result.html"
```

There are **five** `out-File -append` sites in each `cvs_functions*.ps1` variant. Under
Ansible, `$PSScriptRoot` was a temp directory destroyed in the `always:` block, so
`-append` never appended to anything — it wrote one file that was then deleted. Against a
**pre-staged** script, `$PSScriptRoot` is permanent: every run appends another complete
HTML document to the same file, and `run.log` grows without bound, in a directory the
service account has write access to. Nothing rotates or truncates it.

`cvs_admin.ps1` (v3) does not have this problem — it uses plain `Out-File`, which
overwrites.

**3.3 The manual copy is the only step in the chain with no audit trail.** Everything
else — the merge, the workflow version, the run history — is recorded somewhere.

---

## 4. What Orchestrator can and cannot do

**Cannot:** there is no equivalent of AAP's "update project from SCM on launch" for
arbitrary file assets. vRO 8.x Git integration versions **workflow and action content**,
not a `files/` directory shipped to a target host. Your read is correct.

**Can:**

| Capability | Use |
|---|---|
| `PowerShellHost.invokeScript(<text>)` | Executes an arbitrary script **string** — so vRO *can* ship script content per run, not only invoke a path |
| **Resource Elements** | Arbitrary versioned assets stored in vRO, readable at run time, updatable over the REST API (`/vco/api/resources/{id}`) — the direct analogue of Ansible's `files/` |
| **REST plug-in** | An action can `GET` a raw file from the GitLab API at run time |

So the Ansible property is reproducible; it just has to be assembled rather than
enabled.

---

## 5. Options

### A — Pre-staged, pushed by GitLab CI on merge
A pipeline job deploys `files/ps_scripts` to the pool on merge to `main`. vRO unchanged;
`scriptPath` stays as-is. Source of truth stays GitLab, update-once semantics preserved,
invocation string stays small.
*Needs:* a runner that can reach the pool (WinRM/SMB/SSH) and credentials for it.
*Trade:* deployment happens outside both AAP and vRO — a third system in the path.

### B — Host-side scheduled pull
A scheduled task on the pool does `git pull` (or `Invoke-WebRequest` against the raw
file API) every N minutes. No inbound access, no runner, host reaches out.
*Trade:* the deployed copy lags a merge by up to the poll interval, and a run inside that
window uses the old script with no indication that it did.

### C — vRO stages per run, from a Resource Element *(closest structural analogue)*
Script body held in a vRO **Resource Element**. A `stageScriptOnHost` action computes
SHA-256 of the intended content, compares it against `Get-FileHash` of the deployed copy,
and pushes (base64, chunked) **only when they differ** — the same idempotence `win_copy`
provides. Then invoke as today.
*Gains:* the deployed generation becomes a **verified, logged fact** on every run (fixes
§3.1); staging is automatic for any number of hosts, which matters now that Tier 1
creates one `PowerShellHost` object per domain identity.
*Trade:* GitLab → vRO still needs a sync step (CI pushing to the vRO REST API on merge,
or package import), so it does not remove the deployment step — it moves it to where the
run can verify it. `cvs_function_formatted_email.ps1` is ~60 KB (~80 KB base64), well
inside the default 500 KB WinRM envelope, but chunk it and log the **hash**, not the
content.

### D — vRO fetches from GitLab at run time, then stages as C
Truest to AAP: pull at launch, no deployment step at all.
*Trade:* every run gains a hard dependency on GitLab availability and a token to hold and
rotate — and whatever the fetch returns is executed on a privileged host. Chain of
custody is materially weaker than A, B or C.

### E — Rejected: run directly from a UNC path
`& \\share\ps_scripts\cvs_admin.ps1` looks like "one location, no copy", but reading that
share is a **second hop** from the psHost session. It fails under NTLM and needs the
Kerberos constrained delegation of the Build Guide §6 — a lot of moving parts to avoid a
file copy, and a new single point of failure for every workflow.

---

## 6. Recommendation

**A for deployment + C's hash assertion as a guardrail.** Deploy from GitLab CI on merge
so GitLab stays the single source of truth with no runtime dependency; have each workflow
assert the deployed script's SHA-256 (or an embedded `$ScriptVersion`) before invoking, so
"which generation ran" stops being unconfirmed. If no runner can reach the pool, **B**
delivers the same semantics with a poll-interval lag; **C** is the right answer if the
deployment step must live inside Orchestrator.

**Independently of the choice, and regardless:**

1. **S-28 — fix the append.** Change the five `out-File -append` sites in
   `cvs_functions*.ps1` to overwrite, matching `cvs_admin.ps1`. This is required for the
   pre-staged model in any form, and is not optional under A, B, C or D.
2. **Redirect `$Global:DebugDir`** away from `$PSScriptRoot` so a read-only script
   directory becomes possible (`C:\PSO\Logs\` or `$env:ProgramData`), and add retention.

---

## 7. Bearing on the Tier 2 credential decision

**None — they are orthogonal.** The `AD_CRED_*` values are *machine-level environment
variables*; they persist on the host independently of where the script file lives, so
staging them at host build time (Multi-Domain-Remediation-Plan §5.2, option 1) remains
available under every option above. The only approach script distribution would have
constrained is DPAPI-encrypted files sitting *beside* the script — and that proposal is
already withdrawn.
