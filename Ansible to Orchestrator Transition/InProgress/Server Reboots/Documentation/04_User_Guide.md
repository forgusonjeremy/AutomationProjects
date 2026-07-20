# User Guide — Server Reboot Automation

**Project:** Ansible → VCF Orchestrator transition — "Server Reboots"
**Workflow:** `Reboot Servers in AD Group` (`Invoke-ServerReboot`)
**Audience:** Operators who run or schedule the workflow and read its reports.

---

## 1. What this workflow does

It reboots the Windows servers in a chosen Active Directory security group **that are
reporting a pending reboot** — one at a time, waiting a short delay between each — and
then confirms each server comes back online. It emails a per-server report. It works
for both physical and virtual servers.

It is intended to run **on a schedule that always attempts reboots**. You can also run
it on demand, including a safe **Report-Only** mode that shows what *would* be
rebooted without touching anything.

---

## 2. What makes a server eligible for reboot

A server is rebooted on a run only when **all** of the following are true. If any is
not met, the server is skipped (and shown in the report with the reason).

1. **It is in the target group, directly.** The server's computer account is a
   **direct member** of the group you specify. Servers that are only in a **nested
   sub-group are not included**.
2. **Its account is enabled and is a computer.** Disabled accounts and non-computer
   objects (users, groups) are ignored.
3. **It reports a pending reboot.** The automation checks each server for a pending
   reboot from any of:
   - **Windows Component Based Servicing** (e.g. after DISM feature changes or
     component servicing),
   - **Windows Update** (patches installed that need a reboot),
   - **SCCM / ConfigMgr** (updates or apps the ConfigMgr client flagged).
4. **The run is in Reboot mode** (`simpleMode`). Scheduled runs always are; a manual
   Report-Only run never reboots.

**Important safety rule:** if the automation **cannot read** a server's pending state
(for example the server is down or unreachable over WMI/RPC), that server is
**skipped and reported as an error — it is never rebooted**. The automation never
reboots a machine it could not first check.

**Note on coverage:** the pending-reboot check covers Windows Update, CBS, and SCCM.
It does **not** detect the rarer "pending file rename" or "pending computer rename"
conditions; a server pending a reboot *only* for those reasons will not be rebooted.

---

## 3. Running the workflow

1. In the **Orchestrator Client**, open **`Reboot Servers in AD Group`** and click
   **Run**.
2. Fill in the form (fields explained below).
3. To do a safe dry run, set **Reboot or Report Only?** to **Report-Only** — the
   workflow will resolve the group and report pending state but reboot nothing.
4. Click **Run** and watch the **Logs** tab. The final line reports success or
   "completed with errors".

### Form fields

| Field | What to enter |
|---|---|
| **scriptPath** | Path to `cvs_functions.ps1` on the PowerShell host (usually leave default) |
| **groupDN** | The target AD group. A full distinguished name is best, e.g. `CN=Server-Reboots,OU=Servers,DC=corp,DC=local`. A plain group name also works |
| **domainName** | Your AD domain (e.g. `corp.local`) |
| **Reboot or Report Only?** | **Reboot** to actually reboot; **Report-Only** for a dry run |
| **delayBetweenServersSec** | Seconds to wait between each server's reboot (default 10) |
| **verifyTimeoutSec** | How long to wait for a rebooted server to come back before marking it failed (default 600 = 10 min) |
| **verifyPollSec** | How often to re-check a rebooting server (default 30s) |
| **Enable USB Mass Storage and make termsrv.dll writeable?** | **Leave unchecked.** Runs a security-sensitive pre-reboot script; only enable if security has approved it (see §6) |
| **emailReport** | Check to email the report |
| **smtpServer** | Your mail relay |
| **mailTo / mailCc** | Recipient lists (add one address per entry) |
| **mailSubject** | Subject line for the report email |

---

## 4. Reading the results

Each server appears in the report with a **status**:

| Status | Meaning |
|---|---|
| **Rebooted** | Reboot issued and the server confirmed back online (its boot time advanced) |
| **NotReturned** | Reboot issued but the server did not come back within the timeout — **investigate** |
| **RebootFailed** | The reboot command was rejected (e.g. access denied, RPC unavailable) — **investigate** |
| **Skipped-NoRebootRequired** | Eligible but no pending reboot — nothing to do |
| **Skipped-StatusUnknown** | Could not read the server's pending state — **not rebooted**; check the server is up and reachable |
| **Skipped-ReportOnly** | Had a pending reboot but the run was Report-Only |

Overall run outcome:

- **Completed Successfully** — no errors; all eligible servers were handled.
- **Completed with Errors** — at least one server had a problem (unreachable, failed
  reboot, or did not return). The other servers were still processed and the report was
  still produced. Open the report/logs to see which server and why.

---

## 5. Scheduled operation

In normal production the workflow runs on a **schedule set to Reboot mode**, so on
each run **every eligible server that has a pending reboot is rebooted automatically**.
There is no manual approval step in that path.

The **control surface is the AD group**:

- **To include a server:** add its (enabled) computer account to the group.
- **To exclude a server:** remove it from the group, or disable its account.

Because membership drives what gets rebooted, the group should be managed
deliberately. A server added to the group will be rebooted on the next scheduled run
if it has a pending reboot.

Plan the schedule window around the run time: roughly
`(number of pending servers × delayBetweenServersSec) + up to verifyTimeoutSec`.

---

## 6. The pre-reboot script option (security note)

The checkbox **"Enable USB Mass Storage and make termsrv.dll writeable?"** controls an
optional pre-reboot script (`ownership_w2k.ps1`). When enabled, it runs on each server
before rebooting it and:

- takes ownership of and grants access to `usbstor.inf` — which **reverses a standard
  control used to block USB storage devices**, and
- takes ownership of and grants full control to `termsrv.dll` — the Terminal Services
  file (loosening it is the precursor to unsupported concurrent-RDP modifications,
  which violate the Windows licence).

**Leave this unchecked** unless your security team has explicitly reviewed and approved
it. It is off by default and has no effect on the reboot itself.

---

## 7. Testing / simulating a pending reboot (lab)

To validate the workflow without waiting for real updates, use the helper
`lab/Set-PendingRebootFlag.ps1` to simulate a pending reboot on a test server:

```powershell
# Arm one server (or a whole group)
.\Set-PendingRebootFlag.ps1 -ComputerName testsrv01 -Action Set
.\Set-PendingRebootFlag.ps1 -AdGroup 'Server-Reboots' -DomainName corp.local -Action Set

# Check what the workflow will see
.\Set-PendingRebootFlag.ps1 -AdGroup 'Server-Reboots' -Action Check

# Always clean up afterwards
.\Set-PendingRebootFlag.ps1 -ComputerName testsrv01 -Action Clear
```

Run it on / against the **target** servers (it must set the flag on the machine the
workflow will check). A simulated flag does **not** clear itself on reboot, so always
run `-Action Clear` when finished.

---

## 8. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Run fails: *"Cannot bind argument to parameter 'Command' because it is an empty string"* | The build step's output isn't bound to the `invocationScript` attribute — see Implementation Guide. |
| Run fails connecting to the PowerShell host | The `host` attribute still points at the build/lab host — re-point it to your PS host (Implementation Guide §3). |
| *"ActiveDirectory module not available"* or group won't resolve | RSAT AD module missing on the PS host, or the group DN/domain is wrong. |
| A server shows **Skipped-StatusUnknown** | The server was unreachable over WMI/RPC. It was **not** rebooted. Check it is powered on and reachable from the PS host. |
| A server shows **NotReturned** | It was rebooted but didn't come back within `verifyTimeoutSec`. Check the server; increase the timeout only if boots legitimately take longer. |
| No servers were rebooted | Either the run was Report-Only, or no eligible server had a pending reboot. Confirm `rebootMode = Reboot` and check pending state. |
| Report email not received | `emailReport` unchecked, wrong `smtpServer`, empty `mailTo`, or the relay rejected the PS host. |
