# User Guide — Server Reboot Automation

## 1. What this workflow does

**`Reboot Servers in AD Group`** reboots the Windows servers in an Active Directory
group **that are reporting a pending reboot**, one at a time with a short delay
between each, then confirms each server came back online. It records a per-server
outcome in the run log and can email an HTML report. It works the same for physical
and virtual servers.

It is intended to run **on a schedule that always attempts reboots**. You can also
run it on demand, including a safe **Report Only** mode that shows what *would* be
rebooted without touching anything.

---

## 2. What makes a server eligible for reboot

A server is rebooted only when **all** of the following are true.

1. **It is directly in the target group.** Its computer account is a **direct
   member** of the group. Servers that are only in a **nested sub-group are not
   included** — the run log names any nested group it ignored.
2. **Its account is an enabled computer account.** Disabled accounts, users and
   contacts are ignored.
3. **It reports a pending reboot** from any of:
   - **Windows Component Based Servicing** (e.g. DISM feature changes, component
     servicing),
   - **Windows Update** (installed patches that need a reboot),
   - **SCCM / ConfigMgr** (updates or apps the ConfigMgr client flagged).
4. **The run is in Reboot mode.** A Report Only run never reboots.

**Safety rule:** if a server's pending state **cannot be read** (for example it is
down, or unreachable over WMI/RPC from the PowerShell host), it is **skipped and
reported as an error — never rebooted**.

**Coverage note:** the check does **not** detect "pending file rename" or "pending
computer rename". A server pending a reboot *only* for those reasons is not rebooted.

---

## 3. Running the workflow

1. In the **Orchestrator Client**, open **`Reboot Servers in AD Group`** and click
   **Run**.
2. Fill in the form (below).
3. For a dry run, set **Reboot or Report Only** to **Report Only**.
4. Click **Run** and watch the **Logs** tab. The last line summarises the run:
   ```
   Invoke Server Reboot | group=<group> | rebootMode=<mode> | <summary>
   ```

### Form fields

| Field | What to enter |
|---|---|
| **adGroupDn** | The target group's full distinguished name, e.g. `CN=Security-Reboot-Servers,OU=Groups,DC=vcf,DC=lab`. The domain is taken from this, so there is no separate domain field. **Required** |
| **Reboot or Report Only** | **Reboot** to reboot pending servers; **Report Only** for a dry run. **Required** |
| **Run Allow USB and Make TermSrv.dll Editable Script?** | **Leave unchecked.** Runs a security-sensitive step before each reboot — see §6 |
| **emailReport** | Tick to email the HTML report |
| **mailTo** | Recipients, one address per entry. Required when emailing |
| **mailCc** | Optional CC recipients |
| **mailSubject** | Subject line; the count of servers rebooted is appended to it |
| **smtpServer** | Your mail relay. Required when emailing |

The delay between reboots (10s), the time each server has to come back (600s) and
how often it is re-checked (30s) are set on the workflow by the administrator and
are the same for every run.

### Running from a schedule or the API
Pass the same inputs. `rebootMode` must be exactly **`reboot`** (lower case) to
reboot; any other value, including `report-only`, is a report-only run.

---

## 4. Reading the results

### Per-server status
Each server appears in the log's *per-server outcome* table and in the emailed
report with one of:

| Status | Meaning |
|---|---|
| **Rebooted** | Reboot issued and the server confirmed back online (its boot time advanced) |
| **NotReturned** | Reboot issued but the server did not come back within the timeout — **investigate now** |
| **RebootFailed** | The reboot command was rejected (e.g. access denied, RPC unavailable). The server is still up and still needs a reboot |
| **Skipped-NoRebootRequired** | No pending reboot — nothing to do |
| **Skipped-StatusUnknown** | Pending state could not be read — **not rebooted**; check it is up and reachable |
| **Skipped-ReportOnly** | Had a pending reboot but the run was Report Only |

The report also shows each server's boot time before the reboot and its **return
time** — seconds from the reboot being issued to the server's new boot time.

### Overall outcome

| What you see | Meaning |
|---|---|
| Run **Completed**, last line without warnings | Every server was handled cleanly. `executionSuccess = true` |
| Run **Completed**, warnings ending *"Completed WITH ERRORS"* | At least one server had a problem. The others were still processed and the report still produced. The warnings say which kind: skipped (unreadable), shutdown rejected, or **did not come back**, followed by the error lines. `executionSuccess = false` |
| Run **Failed** | Nothing was rebooted, or the script did not finish. The error message says why — see §8 |

The workflow also returns `serversChecked`, `serversPending`, `serversRebooted`,
`executionOutput` (one-line summary) and `transcript` (full script log) for schedules
and parent workflows.

---

## 5. Scheduled operation

In production the workflow runs on a **schedule set to Reboot mode**, so on each run
**every eligible server with a pending reboot is rebooted automatically**. There is
no approval step.

The **control surface is the AD group's direct membership**:

- **To include a server:** add its enabled computer account **directly** to the group.
- **To exclude a server:** remove it from the group, or disable its account.
- **Nesting a group inside the reboot group does not enrol its servers.** They are
  skipped and the run log names the nested group.

A server added to the group is rebooted on the next scheduled run if it has a pending
reboot.

Plan the schedule window around the run time — roughly
`40s + (pending servers − 1) × 10s + up to 600s`. Twenty pending servers take about
14 minutes.

---

## 6. The pre-reboot script option (security note)

The checkbox **"Run Allow USB and Make TermSrv.dll Editable Script?"** turns on an
optional step that runs on each server immediately before it is rebooted. It:

- takes ownership of `usbstor.inf` and grants access to it — which **reverses a
  standard control used to block USB storage devices**, and
- takes ownership of `termsrv.dll` and grants full control — the Terminal Services
  file; loosening it is the precursor to unsupported concurrent-RDP modifications,
  which violate the Windows licence.

**Leave this unchecked** unless your security team has explicitly approved it. It is
off by default. When it is on, the log carries a prominent warning, and if the step
fails on a server the failure is logged as an error and that server is **still
rebooted**.

---

## 7. Testing / simulating a pending reboot (lab)

Use `lab/Set-PendingRebootFlag.ps1` to simulate a pending reboot on a test server:

```powershell
# Arm one server (or every direct computer member of a group)
.\Set-PendingRebootFlag.ps1 -ComputerName testsrv01 -Action Set
.\Set-PendingRebootFlag.ps1 -AdGroup 'Security-Reboot-Servers' -DomainName vcf.lab -Action Set

# See what the workflow will see
.\Set-PendingRebootFlag.ps1 -AdGroup 'Security-Reboot-Servers' -Action Check

# Always clean up afterwards
.\Set-PendingRebootFlag.ps1 -ComputerName testsrv01 -Action Clear
```

`-Flag` chooses which signal to simulate (`WindowsUpdate` — the default — `CBS`, or
`Both`). A simulated flag does **not** clear itself on reboot, so always run
`-Action Clear` when finished. The `-AdGroup` option needs the ActiveDirectory module
on the machine you run it from.

---

## 8. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Failed: *"findAdHostForDn: '…' is not a distinguishedName"* or *"has no DC= parts"* | `adGroupDn` was blank or a plain name. Enter the full DN |
| Failed: *"none of the registered Active Directory hosts serve the domain '…'"* | No Orchestrator AD endpoint for that domain. Ask the administrator to add one |
| Failed: *"resolveAdGroup: no group named '…' exists on endpoint '…'"* | DN misspelled, or the group is in a different OU. Copy the DN from the group's Attribute Editor |
| Failed: *"no servers were resolved"* | The group has no enabled computer accounts as **direct** members. Check the *Get Computers in AD Group* log — if it lists nested groups, that is where the servers are |
| Failed: *"rebootMode is empty"* | Choose Reboot or Report Only |
| Failed: *"smtpServer is required…"* / *"mailTo must hold at least one recipient…"* | Email was ticked without a relay or recipient |
| Failed: *"… did not report a result"* | The script did not finish — the PowerShell session was cut off (see *timeout* below) or the host could not start it. The error includes whatever output there was |
| Failed connecting to the PowerShell host, or `document out [EMPTY]` | PS host unreachable, WinRM down, or its certificate is SHA-1. Run `Code/Test-PSHostWinRM.ps1` on the PS host |
| Run cut off partway, servers were rebooting | The run outlasted the WinRM/plug-in timeout. Ask the administrator to raise it (Implementation Guide §7); do **not** shorten the verify timeout |
| Report Only run logs *"rebootMode='report-only' is neither 'reboot' nor 'no'"* | Expected on Report Only runs; the run is report-only and nothing is rebooted |
| Log suggests re-running with *'simpleMode'* | Use **Reboot** on the form, or `reboot` from a schedule/API |
| A server shows **Skipped-StatusUnknown** | Unreachable over WMI/RPC from the PS host. It was **not** rebooted. Check it is on and the firewall allows RPC/WMI |
| A server shows **RebootFailed** | The PS host's account lacks shutdown rights on it, or RPC is blocked |
| A server shows **NotReturned** | It was rebooted but did not report a new boot time within 600s. Check the console. Raise `verifyTimeoutSec` only if boots legitimately take longer |
| No servers were rebooted | The run was Report Only, or no server had a pending reboot. Check the per-server outcome table |
| Report email not received | `emailReport` unticked, wrong `smtpServer`, or the relay rejected mail from the PS host. A send failure appears as an error in the log |
| Warning naming nested groups | Those groups' members were **not** rebooted. Add the computer accounts directly, or run the workflow against each nested group |
