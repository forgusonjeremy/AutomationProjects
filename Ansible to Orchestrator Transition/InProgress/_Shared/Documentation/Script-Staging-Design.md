# Script Staging — Design & Implementation

> **AMENDED 2026-09-28 — P-67 supersedes amendment 1 below.** At the customer's direction
> (Windows Server Clean Disks), `stageScriptOnHost` now **copies only when it has to**:
>
> | Host state | Action |
> |---|---|
> | Target absent | Copy (first run) |
> | SHA-256 **and** byte length match the Resource Element | Nothing copied — the existing copy runs |
> | Anything differs | Warn with both hashes, overwrite, re-hash on disk, fail the run on mismatch |
>
> The comparison is a **content hash computed at run time** (SHA-256 in the action over the
> exact bytes it would write; `Get-FileHash` on the host), so it keeps everything amendment 1
> bought — **no version marker, no CI stamping job** — while sending the script body over
> WinRM only when it changed. That is what makes it affordable to keep scripts **fully
> commented** in the Resource Element.
>
> **Signature (2026-09-29):** **`stageScriptOnHost (psHost, script, targetPath)`**, where `targetPath` is the **directory**. `script`
> is the **ResourceElement** itself, bound from a workflow attribute set at build time, so the
> run record shows which element was staged and nothing is looked up by path inside the action.
> The action builds the full path as `targetPath + '\' + <element name>` (the element name
> must be a plain `.ps1` file name), performs the check-and-copy on that path, and **returns the
> full path**, e.g. `C:\PSO\Scripts\Invoke-ServerDiskClean.ps1`. Which generation ran is logged:
> `staged: <path> | <name> v<version> | sha256=<12 hex> | first copy|updated|unchanged`.
> *(Superseded forms: `(psHost, resourcePath, targetPath)`, then `(psHost, script, targetPath)`
> returning a label.)*
>
> **Companion action:** **`invokeStagedScript (psHost, scriptPath, parameters)`** runs the staged
> file and parses its `PSO_RESULT` line. `scriptPath` is bound to the path `stageScriptOnHost`
> **returned**, so the file run is the file just verified, and the run element cannot be
> wired up without staging in front of it.
> Workflows that build an invocation string for the OOTB *Invoke a PowerShell script* may keep
> doing so — staging is independent of how the script is then invoked.
>
> Also changed: the install step writes a **uniquely named** `.staging` sibling (two concurrent
> runs cannot collide), and the file is written through the host's own session
> (`psHost.invokeScript()`, the same one the run uses) so it is written by the identity that
> executes it. Verified locally against Windows PowerShell 5.1 — see §8, ST-1 … ST-6.
>
> **CURRENT — reinstated 2026-08-18.** `Execution-Model-GuestOps.md` is deferred; this is
> the model being built. Three amendments from the version first written:
>
> 1. ~~**`stageScriptOnHost` copies on every run.**~~ *(Superseded 2026-09-28 by P-67 above.)* No version marker, no comparison. **S-29
>    and its CI-stamping prerequisite are dropped** — one less thing to build, and one less
>    open question ("who owns the CI job") on the critical path. Ansible copies every run; so
>    do we. "Which generation ran" is the Resource Element version, logged by the action.
>    §2's marker row and §4's marker-related failures no longer apply; everything else in §4
>    does.
> 2. **§6's `AD_CRED_*` staging applies to the Admin report only** — the one workflow that
>    sweeps several domains in a single invocation, and only for the `rootdomain` key.
>    Everything else takes its identity from the bound `PowerShellHost` object (P-52).
> 3. **§6 gains the delegation requirement** — see §6.3. This is the highest-risk item for a
>    fast go-live and it is not optional.

**Implements:** `Script-Distribution-Architecture.md` option **C** (customer-selected 2026-08-17)
**Applies to:** every transition that invokes a PowerShell script on the PS host — all seven
**Supersedes:** the pre-staged assumption recorded as **P-1**, **P-9**, **P-20**
**Change IDs:** **P-56** (execution model), **S-28** (append defect), **S-29** (version marker)

---

## 1. What changes

| | Ansible (today) | vRO as delivered | vRO with staging |
|---|---|---|---|
| Source of truth | GitLab | A hand-placed copy | GitLab |
| Reaches the host by | `win_copy` every run | Manual, once | `stageScriptOnHost`, when the generation differs |
| Scripts copied per run | All ~25 (~600 KB) | None | The one being invoked |
| Deployed generation | Implicit — whatever SCM had at launch | **Unknown** | **Recorded on the run** |
| Cleanup | Temp dir deleted | n/a | Target persists; temp `.b64` removed |

The property being restored is not the copy. It is that **a merge to GitLab is live on the
next run, and the run says which merge it used**.

---

## 2. Components

| Component | Where | Purpose |
|---|---|---|
| **Resource Element** | `PSO/Scripts/<script>.ps1` | Holds the script body. The analogue of Ansible's `files/ps_scripts` |
| **`stageScriptOnHost`** action | `com.broadcom.pso.vcf.powershell.staging` | Compares, pushes, verifies. Returns the deployed version marker |
| **Version marker** | Line 1–20 of each script | `# PSO-SCRIPT-VERSION: <commit-sha>` (**S-29**) |
| **CI sync job** | GitLab pipeline | On merge to `main`: stamp the marker, PUT the file into the Resource Element over the vRO REST API |

**One shared action, referenced not copied.** The same rule the remediation plan sets for
`resolvePowerShellHostForDomain` (§5.1 step 3) applies here: one definition, or the
staging logic drifts per project.

---

## 3. Workflow schema

Two elements go in front of the existing invoke step, in every workflow:

```
[ stageScriptOnHost ]      psHost, script (ResourceElement attr), targetPath (directory)
        |                  -> scriptPath (workflow attribute: the verified full path)
        v
[ build<X>Invocation ]     scriptPath
        |                  -> invocationString
        v
[ Invoke a PowerShell script ]   (OOTB, unchanged)
        |
        v
[ parseScriptOutput ]      (unchanged)
```

`scriptVersion` is bound to a workflow **output** and logged. That output is the answer to
"which generation of the script did that run use?", and it should appear in the run
history next to the result it produced.

**Staging is not per-domain.** Tier 1 registers several `PowerShellHost` objects against
the **same pool FQDN**, one per domain identity. They share one filesystem, so staging via
any one of them serves all of them — stage once, per run, through whichever host object
the workflow resolved.

---

## 4. Failure behaviour

`stageScriptOnHost` fails the run rather than continuing, in each of these cases:

| Condition | Why it stops the run |
|---|---|
| Resource Element missing or empty | Staging it would overwrite a working script with nothing |
| No `PSO-SCRIPT-VERSION` marker in the Resource Element | The run could not record what it ran — the point of the exercise |
| Host probe returns no marker line | Deployed state unknown; overwriting on an unreadable probe is worse than stopping |
| A chunk is not acknowledged | The target is untouched (only the temp `.b64` is partial) |
| Post-push marker or length mismatch | The file on disk is not the script the workflow intended to run |

It **warns and re-stages** when the deployed marker matches but the byte length does not —
someone edited the deployed copy in place, or committed without bumping the marker. Either
way the marker no longer identifies the content.

The target is written via a sibling `.staging` file and `Move-Item`, so an interrupted push
cannot leave a half-written script where the next run would execute it.

---

## 5. S-28 — the append defect (required, independent of all of this)

`cvs_functions*.ps1` writes its artefacts beside itself:

```powershell
$Global:DebugDir = "$($PSScriptRoot)\Debug"
$body | out-File -append -FilePath "$($Global:DebugDir)\PKI_result.html"
```

**Five** `out-File -append` sites per variant. Under Ansible, `$PSScriptRoot` was a temp
directory destroyed in the playbook's `always:` block, so `-append` never appended to
anything. Against a persistent script directory it appends a complete HTML document per
run, forever, and `run.log` grows unbounded — in a directory the service account can write
to.

`cvs_admin.ps1` is already correct: plain `Out-File`, which overwrites.

**S-28:**
1. Change the five `out-File -append` sites to `Out-File` (overwrite), matching `cvs_admin.ps1`.
2. Move `$Global:DebugDir` off `$PSScriptRoot` — `C:\PSO\Logs\<script>\` or `$env:ProgramData` —
   so the script directory can be **read-only** to the service account, and add retention.

(2) also removes the last reason for the service account to have write access to the
directory it executes from.

---

## 6. Host build delta

Add to `How-To-Build-a-PowerShell-Host.md` §Step 7 / `Configure-vROPSHost.ps1` Step 8:

1. The script directory no longer needs a manual copy — remove the warning
   *"cvs_functions.ps1 must be manually copied … this script does not deploy it."*
   The service account needs **Read & Execute**; the account vRO connects as needs
   **Write** to that directory only until S-28(2) moves the debug output, after which
   Read & Execute is sufficient for execution and Write is needed only for staging.
2. **`AD_CRED_*` credential staging** (Multi-Domain-Remediation-Plan §5.2 option 1):
   set `AD_CRED_<KEY>_USER` / `AD_CRED_<KEY>_PASS` as **machine-level** environment
   variables for each domain identity in scope.

   **Restart the WinRM service afterwards.** A machine-level environment variable change is
   picked up from the parent process's environment block, which `WinRM` captured when it
   started; `wsmprovhost` children inherit that stale block until the service restarts. A
   credential staged without the restart resolves to nothing, and `Get-DomainCredential`
   throws *"AD_CRED_X_USER / AD_CRED_X_PASS are not set"* for a variable that visibly
   exists in the registry. Verify from vRO, not from an RDP session:
   *Invoke a PowerShell script* → `[Environment]::GetEnvironmentVariable('AD_CRED_<KEY>_USER')`.

### 6.3 Kerberos delegation — the highest-risk item, and it is already solved in this estate

Every AD call these scripts make (`Get-ADUser -Server <domain>`, `Get-ADGroupMember -Server
<domain>`) is a **second hop**: a network resource reached from a session that was itself
established over the network. A WinRM network logon carries proof of identity but **no
credential to forward**, so without delegation the call fails — typically as
`ADServerDownException` or a socket reset inside `NegotiateStream`, which is the entry
already in the Build Guide's troubleshooting table.

**AAP solves this today, and the setting is in the repo.** Both Windows inventories
(`admins/inventory/on_winrm_servers`, `dev_winrm_servers`) and
`admins/window-requirements.yml` carry:

```yaml
ansible_connection: winrm
ansible_port: 5986
ansible_winrm_transport: kerberos
ansible_winrm_kerberos_delegation: yes
ansible_winrm_server_cert_validation: ignore
```

That is the mechanism, stated plainly: **Kerberos with credential delegation**. It is why
the reports work over WinRM today despite making a second hop on every query.

Two consequences, both good for a fast delivery:

- **The AD-side work is likely already done.** Delegation of this kind requires
  configuration on the target computer account and forwardable tickets for the service
  accounts. The estate has been running this way, so vRO is inheriting a proven path rather
  than opening a new one. Build Guide §6 becomes a *verification* exercise, not an AD change
  request — which is the difference between a ticket and a project.
- **vRO must actually request it.** The plug-in has to obtain a forwardable ticket and
  delegate it; a host object that authenticates without delegation will connect happily and
  then fail on the first `Get-ADUser`. This fails in a way that looks like an AD problem
  rather than a configuration problem, so test it first and test it explicitly.

**Test before anything else is built:**

```powershell
# via Library > PowerShell > Invoke a PowerShell script, against the bound psHost object
klist                                   # is there a TGT, and is it forwardable?
Get-ADUser -Server <a domain the host is NOT joined to> -Filter * -ResultSetSize 1
```

If that `Get-ADUser` succeeds, the whole family works. If it does not, nothing else matters
until it does — and the fallback positions are CredSSP, or the deferred guest-operations
model, which has no second hop at all because the process is logged on with a password
rather than a delegated ticket (`Execution-Model-GuestOps.md` §2.1).

---

## 7. CI sync job (GitLab → vRO)

On merge to `main`, for each script under `files/ps_scripts` that vRO consumes:

1. Stamp `# PSO-SCRIPT-VERSION: $CI_COMMIT_SHORT_SHA` as the file's second line (after any
   `[CmdletBinding()]`-preceding comment block, before `param(`).
2. `PUT /vco/api/resources/{id}` with the file content, authenticating as a vRO service
   account with content-import rights only.

Failure of this job must fail the pipeline: a Resource Element silently left at the
previous generation reintroduces exactly the ambiguity being closed — with the added
hazard that the marker would now assert a generation that is not what is deployed.

---

## 8. Validation

*(Rows updated 2026-09-28 for P-67. ST-1, ST-2, ST-4 and ST-6 were run locally against
Windows PowerShell 5.1 with the vRO objects stubbed — all passed, including a
**same-length** in-place edit and overwriting a **read-only** host copy. Repeat in the lab.)*

| # | Check | Expected |
|---|---|---|
| **ST-1** | Run twice, unchanged | First run returns `(first copy)`; second returns `(unchanged)` and logs "exact match … nothing copied" |
| **ST-2** | Update the Resource Element, re-run | Warns with both hashes, returns `(updated)` with the new hash |
| **ST-3** | Delete the target on the host, re-run | Probe returns `ABSENT`; returns `(first copy)`; directory created if missing |
| **ST-4** | Edit the deployed copy in place (even keeping its length), re-run | Warns with both hashes, re-stages, returns `(updated)` |
| **ST-5** | ~~Strip the marker~~ *(no marker since P-67)* — empty the Resource Element instead | Fails before contacting the host; target untouched |
| **ST-6** | 60 KB script (`cvs_svcaccounts.ps1`) | Two chunks, both acknowledged; verified SHA-256 and length match |
| **ST-7** | Point `targetPath` at a directory with no write access | Fails at install; target unchanged |
| **ST-8** | Confirm the plug-in result accessor | `psInvoke()` returns the `PSO_PROBE=` line (it reads `getHostOutput()`, then `getInvocationResult().getRootObject()`) — see the note in the action header |

**ST-8 first.** The PowerShell plug-in's result accessors vary by version;
`stageScriptOnHost` tries `getHostOutput()`, then `getInvocationResult()`, then
`getRootObject()`. Confirm which one carries output on the deployed plug-in before
running the rest.
