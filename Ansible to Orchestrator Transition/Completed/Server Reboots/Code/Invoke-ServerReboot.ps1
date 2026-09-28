<#
.SYNOPSIS
    Reboots the Windows servers in a supplied list that are reporting a pending reboot.

.DESCRIPTION
    This is the Windows half of the "Server Reboots" automation.

    It lives in Orchestrator as a Resource Element. At run time Orchestrator writes
    this file to the PowerShell host, runs it with the parameters below, then deletes
    it. Nothing is pre-staged and nothing is left behind.

    The script does NOT talk to Active Directory. Orchestrator's AD plug-in works out
    which servers to process and hands the list in via -ComputerNames. That is the
    single biggest difference from the Ansible playbook this replaces, and from the
    earlier cvs_functions.ps1 design, where the script resolved the group itself.

    HOW IT REACHES THE SERVERS
    Everything runs from one host and reaches each server over RPC/WMI/SMB:

        Get-CimInstance -ComputerName <server>        pending-reboot state, boot time
        shutdown.exe /r /f /m \\<server>              the reboot itself

    So the PowerShell host needs remote WMI/registry and shutdown rights on each
    server. Nothing is installed on the targets and nothing runs on them, apart from
    the optional pre-reboot script (see -RunPreRebootScript).

    PHYSICAL AND VIRTUAL ARE TREATED IDENTICALLY
    Every operation is OS-level. Nothing touches the hypervisor, so hardware and VMs
    are handled the same way. This is deliberate -- a VMware Tools check would have
    worked on only half the estate.

.PARAMETER ComputerNames
    Comma-separated server names (FQDNs), supplied by Orchestrator from the AD group.

.PARAMETER RebootMode
    THE SAFETY GATE. 'reboot' actually reboots. ANY other value (default 'report-only')
    produces a report-only run: pending servers are detected and reported but NOT
    rebooted. The odd spelling is inherited from the Ansible variable var_RebootIt
    and is kept so the two can be read against each other.

.PARAMETER DelayBetweenServersSec
    Seconds to wait after issuing each reboot before moving to the next server.
    Unchanged cadence from the Ansible-era behaviour.

.PARAMETER VerifyTimeoutSec
    Per-server budget for a rebooted server to come back, measured from the moment
    its reboot was issued. A server that does not return in time is reported
    NotReturned and counted as an error.

.PARAMETER VerifyPollSec
    How often the verification pass re-checks the servers that have not yet returned.

.PARAMETER RunPreRebootScript
    'yes' runs the embedded pre-reboot step on each server immediately before
    rebooting it. Defaults to 'no'. The step is the former ownership_w2k.ps1, carried
    into this file as a script block -- there is no separate file and no path to
    supply. See the NOTES section; do not turn this on without reading it.

.PARAMETER EmailReport
    'yes' emails the HTML report. 'no' (default) builds it and writes it to the log
    only.

.PARAMETER SMTPServer
    SMTP relay. Required when -EmailReport is 'yes'.

.PARAMETER MailToString
    Comma-separated recipients. Required when -EmailReport is 'yes'.

.PARAMETER MailCcString
    Comma-separated CC recipients. Optional -- blank means no CC at all.

.PARAMETER MailSubject
    Subject stem. A count of what was rebooted is appended to it.

.PARAMETER HeaderNote
    The group name shown in the report header, e.g. Security-Reboot-Servers. A
    display label only -- it does not affect what is targeted.

.NOTES
    Requires PowerShell 5.1 or later.

    Five things behave differently from the Ansible-era script. All five are
    deliberate corrections or additions -- see Documentation/Change-Register.md.

      1. (S-7) Targeting is direct, computer-only and enabled-only. Nested
         sub-groups are never expanded. This is now enforced by Orchestrator's
         getGroupComputersDirect action rather than in here.
      2. (S-8) A server whose pending-reboot state could NOT be read is skipped,
         never rebooted. The old test treated 'Error Accessing Server' as
         "pending" and force-rebooted a machine it had failed to interrogate.
      3. (S-9) shutdown.exe's exit code is checked. It is a native executable, so
         on failure it raises no PowerShell exception -- a failed reboot used to be
         indistinguishable from a successful one.
      4. (S-10) Every rebooted server is verified as returning to service by
         confirming its LastBootUpTime advanced past its pre-reboot value. The old
         script never verified anything came back.
      5. (S-11) A per-server HTML report is produced and optionally emailed. The
         old Invoke-ServerReboot action produced no report and sent no mail.

    THE PRE-REBOOT STEP IS OFF BY DEFAULT, AND SHOULD STAY THAT WAY  (S-13, S-14)
    It takes ownership of and loosens the ACLs on usbstor.inf (the USB mass-storage
    driver INF -- a common hardening DENY target) and termsrv.dll (Terminal
    Services). Because of defect S-6 it has NEVER actually executed, so enabling it
    is a security-posture CHANGE, not a restoration of working behaviour. Leave
    -RunPreRebootScript at 'no' until security has reviewed it. The 'w2k' (Windows
    2000) naming suggests it may simply be obsolete.

    S-14 moved it INTO this file, as the $PreRebootStep script block below. It used
    to be a separate ownership_w2k.ps1 staged beside cvs_functions.ps1 on the
    PowerShell host, reached by a path built at run time -- which is precisely what
    defect S-6 broke, silently, for years. Nothing is pre-staged under the current
    design, so a path parameter would have reintroduced exactly that failure: a
    missing file, a non-terminating error, and a server rebooted as though the step
    had run. Embedding it means the step either runs or reports why, and it is
    version-controlled with the script that calls it.

    WHY VERIFICATION IS ONE PASS AFTER ALL REBOOTS, NOT PER SERVER
    Reboot-then-block-until-back would take up to N x VerifyTimeoutSec. With 20
    servers at 600s that is 200 minutes in a single synchronous PowerShell
    invocation, which exceeds the WinRM/PSRP operation timeout and cuts the
    transcript off mid-run. Servers reboot concurrently in reality, so issuing every
    reboot first and then polling them all once bounds the whole run to roughly
    (N x delay) + one boot window.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ComputerNames,

    [string]$RebootMode = 'report-only',

    [int]$DelayBetweenServersSec = 10,

    [int]$VerifyTimeoutSec = 600,

    [int]$VerifyPollSec = 15,

    [ValidateSet('yes', 'no')]
    [string]$RunPreRebootScript = 'no',

    [ValidateSet('yes', 'no')]
    [string]$EmailReport = 'no',

    [string]$SMTPServer = '',

    [string]$MailToString = '',

    [string]$MailCcString = '',

    [string]$MailSubject = 'VCF Orchestrator: Server Reboot status',

    [string]$HeaderNote = ''
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Logging
#
# Every line written here ends up in the Orchestrator run log, so this is what
# an operator actually reads afterwards. Errors are also collected so the run
# can report how many there were without anyone having to count log lines.
# ---------------------------------------------------------------------------
$script:ErrorMessages = New-Object System.Collections.ArrayList

function Write-Log {
    param(
        [string]$Message,
        [ValidateSet('INFO', 'WARN', 'ERROR')]
        [string]$Level = 'INFO'
    )
    if ($Level -eq 'ERROR') { [void]$script:ErrorMessages.Add($Message) }
    Write-Host ('{0}  {1,-5}  {2}' -f (Get-Date).ToString('HH:mm:ss'), $Level, $Message)
}

# ---------------------------------------------------------------------------
# The one line Orchestrator parses
#
# Orchestrator reads the run's outcome from a single line of the form:
#
#     PSO_RESULT={"rebooted":3,"errorCount":0,...}
#
# Everything else in the output is for humans. Keeping the machine-readable part
# to one short line means the log wording can change freely without breaking
# Orchestrator, and it stays on one line so it cannot get split in transit.
# ---------------------------------------------------------------------------
function Write-Result {
    param([hashtable]$Data)

    # Only the first few errors go in the line, shortened. The full text of every
    # error is already in the log above.
    $shortErrors = @($script:ErrorMessages | Select-Object -First 10 | ForEach-Object {
        if ($_.Length -gt 120) { $_.Substring(0, 117) + '...' } else { $_ }
    })

    $Data['errorCount'] = $script:ErrorMessages.Count
    $Data['errors']     = $shortErrors

    Write-Host ('PSO_RESULT=' + ($Data | ConvertTo-Json -Compress -Depth 4))
}

# ---------------------------------------------------------------------------
# Who is logged on to a server
#
# Recorded in the report so whoever reads it can see a reboot was not issued into
# an empty room. query.exe writes to stderr when nobody is logged on, which is
# not an error worth surfacing, so everything here is swallowed deliberately.
# ---------------------------------------------------------------------------
function Get-UserlogonSession {
    param([string]$Computer)

    try {
        $session = query user /server:$Computer 2>&1
        if ($session.Count -gt 1) {
            return (($session |
                ForEach-Object { $_ -replace '\s{2,}', ',' } |
                ConvertFrom-Csv |
                Select-Object -ExpandProperty username) -join ', ')
        }
    }
    catch { }

    return ''
}

# ---------------------------------------------------------------------------
# Is a reboot pending on this server?
#
# Three independent signals, any one of which means pending:
#   - Component Based Servicing        RebootPending key exists
#   - Windows Update / Auto Update     RebootRequired key exists
#   - SCCM client                      DetermineIfRebootPending() says so
#
# crashonauditfail is read as well and carried into the report. A server with it
# set to 2 will refuse non-administrator logons after its security log fills, so
# it is worth seeing next to a reboot.
#
# A server that cannot be read comes back with PendingReboot = 'Error Accessing
# Server'. The caller treats that as "do not touch this machine" -- see S-8.
# ---------------------------------------------------------------------------
function Get-RebootStatus {
    param([string[]]$Servers)

    foreach ($computer in $Servers) {

        $userSession   = Get-UserlogonSession -Computer $computer
        $lastBootUptime = $null

        try {
            $pendingReboot = $false

            $lastBootUptime = Get-CimInstance -ComputerName $computer -ClassName win32_operatingsystem |
                Select-Object -ExpandProperty lastbootuptime

            $HKLM    = [UInt32]'0x80000002'
            $wmiReg  = [WMIClass]"\\$computer\root\default:StdRegProv"

            $crashOnAuditFail = 'NO'
            $auditResult = $wmiReg.GetDWORDValue($HKLM, 'SYSTEM\CurrentControlSet\Control\Lsa', 'crashonauditfail')
            if ($auditResult.uValue -eq 2) { $crashOnAuditFail = 'YES' }

            if (($wmiReg.EnumKey($HKLM, 'SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\')).sNames -contains 'RebootPending') {
                $pendingReboot = $true
            }
            if (($wmiReg.EnumKey($HKLM, 'SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\')).sNames -contains 'RebootRequired') {
                $pendingReboot = $true
            }

            # The SCCM client is not on every server, so its absence is not a fault.
            $sccmNamespace = Get-WmiObject -Namespace ROOT\CCM\ClientSDK -List -ComputerName $computer -ErrorAction Ignore
            if ($sccmNamespace) {
                if (([WmiClass]"\\$computer\ROOT\CCM\ClientSDK:CCM_ClientUtilities").DetermineIfRebootPending().RebootPending -eq $true) {
                    $pendingReboot = $true
                }
            }

            Write-Log "$computer : pending reboot = $pendingReboot, last boot $lastBootUptime, crashonauditfail $crashOnAuditFail"

            [PSCustomObject]@{
                ComputerName           = $computer.ToUpper()
                PendingReboot          = $pendingReboot
                ComputerlastBootUptime = $lastBootUptime
                UserSession            = $userSession
                CrashOnAuditFail       = $crashOnAuditFail
            }
        }
        catch {
            # Deliberately NOT logged as an ERROR here. The caller decides what an
            # unreadable server means and logs it once, with the reason it matters
            # (skipped, not rebooted). Logging it in both places would double-count
            # it in errorCount and make one problem look like two.
            Write-Log "$computer : pending-reboot state could not be read - $($_.Exception.Message)" 'WARN'

            [PSCustomObject]@{
                ComputerName           = $computer.ToUpper()
                PendingReboot          = 'Error Accessing Server'
                # Deliberately $null rather than whatever the last server reported.
                # The shared-script version carried the PREVIOUS server's boot time
                # into this object, which put a plausible but wrong timestamp in the
                # report for exactly the servers nobody could reach.
                ComputerlastBootUptime = $null
                UserSession            = $userSession
                CrashOnAuditFail       = ''
            }
        }
    }
}

# ---------------------------------------------------------------------------
# The optional pre-reboot step  (S-13 opt-in, S-14 embedded)
#
# This is the former ownership_w2k.ps1, carried into this file verbatim in effect.
# It runs ON EACH TARGET SERVER, via Invoke-Command, immediately before that server
# is rebooted -- and ONLY when -RunPreRebootScript is 'yes'.
#
# READ BEFORE ENABLING. It weakens two hardening controls:
#   usbstor.inf   the USB mass-storage driver INF. Denying access to it is a common
#                 way to stop USB storage being installed. This grants Users:RX and
#                 Administrators:F back.
#   termsrv.dll   Terminal Services. Loosening its ACL is a known prerequisite for
#                 patching it to allow concurrent RDP sessions.
# Because of defect S-6 this has never actually run in production. Turning it on is
# a NEW security posture, not a restoration of an old one.
#
# WHY IT IS A SCRIPT BLOCK AND NOT A FILE
# Nothing is pre-staged under the current design. A -PreRebootScriptPath pointing at
# a file on the host would have rebuilt the exact shape of defect S-6: a path that
# resolves to nothing, a non-terminating failure, and the server rebooted as though
# the step had succeeded. Held here, it either runs or says why.
#
# EXIT CODES ARE CHECKED, UNLIKE THE ORIGINAL
# takeown and icacls are NATIVE executables: on failure they set an exit code and
# write to stderr, but raise no PowerShell exception. The original's try/catch
# therefore never fired for them and every failure was invisible. Same defect class
# as S-9. Each command's exit code is tested and the failures are returned to the
# caller as text.
#
# The commands themselves are unchanged from ownership_w2k.ps1, including the
# icacls /grant argument spellings -- this is a port, not a rewrite. If any of them
# is wrong, it has always been wrong, and it will now say so instead of failing
# silently.
# ---------------------------------------------------------------------------
$PreRebootStep = {

    # Runs one native command and RETURNS a description of the failure, or $null.
    # It returns rather than appending to an outer variable: this block executes in a
    # remote session, and a helper reaching back into its caller's scope is exactly
    # the kind of thing that works when tested locally and quietly does nothing
    # there.
    function Invoke-Native {
        param([string]$Label, [scriptblock]$Command)

        $output = & $Command 2>&1
        if ($LASTEXITCODE -ne 0) {
            return "$Label exited $LASTEXITCODE : $($output -join ' ')"
        }
        return $null
    }

    $problems = @()

    # Make the files owned by Administrators.
    $problems += Invoke-Native 'takeown usbstor.inf' { takeown.exe /A /F c:\windows\inf\usbstor.inf }
    $problems += Invoke-Native 'takeown termsrv.dll' { takeown.exe /A /F c:\windows\system32\termsrv.dll }

    # Adjust from DENY to ALLOW.
    $problems += Invoke-Native 'icacls usbstor.inf grant Users:RX'         { icacls.exe c:\windows\inf\usbstor.inf /grant 'Users:RX' }
    $problems += Invoke-Native 'icacls usbstor.inf grant Administrators:F' { icacls.exe c:\windows\inf\usbstor.inf /grant 'Administrators:F' }

    # Grant full permissions.
    $problems += Invoke-Native 'icacls termsrv.dll grant administrator:F'  { icacls.exe c:\windows\system32\termsrv.dll /grant ':r' 'administrator:F' }

    # A successful command contributes $null, which lands in the array as an empty
    # element -- strip those so the caller gets failures only.
    return @($problems | Where-Object { $_ })
}

# ---------------------------------------------------------------------------
# Issue one reboot
#
# shutdown.exe is a NATIVE executable. When it fails -- access denied, RPC
# unavailable, host unreachable -- it does NOT raise a PowerShell exception, so a
# surrounding try/catch never fires and a failed reboot looks exactly like a
# successful one. That was defect S-9. stderr is redirected into the output so the
# reason is captured, and $LASTEXITCODE is tested explicitly.
# ---------------------------------------------------------------------------
function Invoke-RebootCommand {
    param([string]$Server)

    try {
        Write-Log "$Server : issuing reboot"

        $output = & shutdown.exe /r /t 2 /c 'VCF Orchestrator rebooting server to address pending reboot status on patching' /f /m "\\$Server" 2>&1

        if ($LASTEXITCODE -ne 0) {
            Write-Log "$Server : shutdown command failed (exit code $LASTEXITCODE) - $($output -join ' ')" 'ERROR'
            return $false
        }

        Write-Log "$Server : reboot command accepted"
        return $true
    }
    catch {
        Write-Log "$Server : $($_.Exception.Message)" 'ERROR'
        return $false
    }
}

# ---------------------------------------------------------------------------
# Verify the rebooted servers came back  (S-10)
#
# Runs ONCE, after every reboot has been issued -- see the NOTES block at the top
# for why it is a batch pass and not a per-server wait.
#
# Proof of reboot is that LastBootUpTime ADVANCED past the value captured before
# the reboot. That is stronger than a ping: it shows the OS actually restarted and
# is answering WMI again, and it works identically for physical and virtual.
#
# A server that has not gone down yet simply reports its old boot time, fails the
# "advanced past" test and stays in the pending set -- so polling too early cannot
# produce a false success.
# ---------------------------------------------------------------------------
function Wait-ServersBackOnline {
    param(
        [array]$Targets,
        [int]$TimeoutSec = 600,
        [int]$PollSec = 15
    )

    $pending = @($Targets | Where-Object { $_.RebootIssued -eq $true })

    if ($pending.Count -eq 0) {
        Write-Log 'No successfully-issued reboots to verify.'
        return
    }

    Write-Log "Verifying $($pending.Count) server(s) return online (timeout ${TimeoutSec}s per server, polling every ${PollSec}s)"

    while ($true) {
        $stillPending = @()

        foreach ($t in $pending) {
            $deadline = $t.RebootIssuedAt.AddSeconds($TimeoutSec)
            $newBoot  = $null

            try {
                # Expected to fail while the server is down. That is a normal part of
                # the cycle, not an error worth logging on every poll.
                $newBoot = Get-CimInstance -ComputerName $t.ComputerName -ClassName win32_operatingsystem -ErrorAction Stop |
                    Select-Object -ExpandProperty lastbootuptime
            }
            catch {
                $newBoot = $null
            }

            if ($null -ne $newBoot -and ($null -eq $t.PreRebootLastBoot -or $newBoot -gt $t.PreRebootLastBoot)) {
                $t.BackOnline  = $true
                $t.NewLastBoot = $newBoot

                # Measured to the server's OWN boot time, not to the moment this
                # pass happened to look at it.
                #
                # Verification is a single batch pass that starts only after every
                # reboot has been issued, so a server rebooted early has been up
                # for the whole of the remaining delay before anything checks it.
                # Timing to (Get-Date) therefore reported the wait, not the
                # reboot: a server that came back in 14 seconds was logged as
                # "back online after 1200s" purely because it was first in the
                # queue. LastBootUpTime is what the machine itself says, so it is
                # the same number however late the poll arrives.
                $t.DurationSec = [Math]::Max(0, [int]($newBoot - $t.RebootIssuedAt).TotalSeconds)

                $t.Status      = 'Rebooted'
                $t.Detail      = "Back online; LastBootUpTime advanced to $newBoot"
                Write-Log "$($t.ComputerName) : back online, returned $($t.DurationSec)s after its reboot was issued"
            }
            elseif ((Get-Date) -ge $deadline) {
                $t.BackOnline  = $false
                $t.DurationSec = [int]((Get-Date) - $t.RebootIssuedAt).TotalSeconds
                $t.Status      = 'NotReturned'
                $t.Detail      = "Did not return within ${TimeoutSec}s of the reboot being issued"
                Write-Log "$($t.ComputerName) : did not return within ${TimeoutSec}s of its reboot being issued" 'ERROR'
            }
            else {
                $stillPending += $t
            }
        }

        $pending = $stillPending
        if ($pending.Count -eq 0) { break }
        Start-Sleep -Seconds $PollSec
    }

    Write-Log 'Verification pass complete.'
}

# ---------------------------------------------------------------------------
# The report  (S-11)
#
# Styled INLINE rather than with a <style> block. Outlook renders HTML with the
# Word engine, which ignores most of a stylesheet -- a report that looks right in
# a browser and unstyled in Outlook is worse than no styling at all.
# ---------------------------------------------------------------------------
function New-RebootReportHtml {
    param(
        [array]$Data,
        [string]$GroupLabel,
        [int]$TimeoutSec
    )

    $tableStyle  = 'border-collapse:collapse;border:1px solid #B4B4B4;font-family:Segoe UI,Arial,sans-serif;font-size:12px;width:100%;'
    $headerStyle = 'border:1px solid #B4B4B4;padding:5px 7px;background-color:#44546A;color:#FFFFFF;text-align:left;font-weight:600;'
    $cellStyle   = 'border:1px solid #B4B4B4;padding:4px 7px;background-color:#FFFFFF;vertical-align:top;'

    $intro =
        "<p style=`"font-family:Segoe UI,Arial,sans-serif;font-size:12px;`">" +
        "The list of servers was the direct (non-recursive) enabled computer members of the security group " +
        "<b>$GroupLabel</b>, resolved by VCF Orchestrator. A remote WMI/registry call to each server determined " +
        "whether a reboot was pending; <b>only servers reporting a pending reboot were rebooted</b>. Servers whose " +
        "pending state could not be read were skipped and NOT rebooted. Each rebooted server was verified as " +
        "returning to service by confirming its LastBootUpTime advanced past its pre-reboot value (timeout " +
        "${TimeoutSec}s per server). The RPC/WMI service on the remote server must be available and accessible, " +
        "or the server is reported as an error.</p>"

    $fragment = $Data |
        Sort-Object -Property Status, ComputerName |
        ConvertTo-Html -Property ComputerName, PendingReboot, PreRebootLastBoot, RebootIssued, BackOnline, DurationSec, Status, Detail -Fragment

    # ConvertTo-Html -Fragment emits Object[], one element per line. Flatten it
    # before any string operation: a [string] cast would fail non-terminatingly and
    # silently produce an empty, well-formed-looking report.
    $body = (@($fragment) -join "`n")

    $body = $body -replace '<table>', "<table style=`"$tableStyle`">"
    $body = $body -replace '<th>',    "<th style=`"$headerStyle`">"
    $body = $body -replace '<td>',    "<td style=`"$cellStyle`">"

    $body = $body -replace '<td([^>]*)>Rebooted</td>',                 '<td$1><font color="green">Rebooted</font></td>'
    $body = $body -replace '<td([^>]*)>NotReturned</td>',              '<td$1><font color="red">Did NOT return</font></td>'
    $body = $body -replace '<td([^>]*)>RebootFailed</td>',             '<td$1><font color="red">Reboot FAILED</font></td>'
    $body = $body -replace '<td([^>]*)>Skipped-StatusUnknown</td>',    '<td$1><font color="red">Skipped - status unknown</font></td>'
    $body = $body -replace '<td([^>]*)>Skipped-NoRebootRequired</td>', '<td$1><font color="green">Skipped - no reboot required</font></td>'
    $body = $body -replace '<td([^>]*)>Skipped-ReportOnly</td>',       '<td$1><font color="#B8860B">Skipped - report only</font></td>'

    $body = $body -replace '>PreRebootLastBoot<', '>LastBootUpTime (before)<'
    $body = $body -replace '>DurationSec<',       '>Return time (s)<'

    return $intro + $body
}

function Send-ReportMail {
    param(
        [string]$Body,
        [string]$Subject
    )

    try {
        # CC is OPTIONAL. Splitting an empty string yields @('') , and passing that
        # to -Cc throws "argument is null or empty", so blanks are filtered out and
        # -Cc is only included when a real recipient remains.
        $to = @($MailToString -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
        $cc = @($MailCcString -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })

        if ($to.Count -eq 0) {
            Write-Log 'EmailReport is yes but no recipients were supplied; the report was not sent.' 'ERROR'
            return
        }

        # The FROM address identifies the host that did the work, which is what
        # someone replying to the report needs to know.
        #
        # USERDNSDOMAIN is empty when the process is not running as a domain account,
        # which would produce 'HOST_Do_Not_Reply@' -- an address most relays reject
        # outright, losing the whole report over a missing suffix. Fall back to the
        # first recipient's domain, which is by definition a domain this relay accepts.
        $domain = $env:USERDNSDOMAIN
        if ([string]::IsNullOrWhiteSpace($domain)) { $domain = ($to[0] -split '@')[-1] }
        $from = "$($env:COMPUTERNAME)_Do_Not_Reply@$domain"

        $mailParams = @{
            SmtpServer = $SMTPServer
            From       = $from
            To         = $to
            Subject    = $Subject
            Body       = $Body
            BodyAsHtml = $true
        }
        if ($cc.Count -gt 0) { $mailParams['Cc'] = $cc }

        Write-Log "Sending report via $SMTPServer to $($to -join ', ')$(if ($cc.Count -gt 0) { ' (cc ' + ($cc -join ', ') + ')' })"
        Send-MailMessage @mailParams
        Write-Log 'Report sent.'
    }
    catch {
        # A report that failed to send must not fail the run -- the reboots already
        # happened, and the transcript still holds everything the mail would have.
        Write-Log "The report could not be emailed: $($_.Exception.Message)" 'ERROR'
    }
}

# ---------------------------------------------------------------------------
# Check the inputs before touching anything
# ---------------------------------------------------------------------------
$servers = @($ComputerNames -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })

if ($servers.Count -eq 0) {
    Write-Log 'No server names were supplied. Nothing was done.' 'ERROR'
    Write-Result @{
        serversRequested = 0
        pendingReboot    = 0
        rebooted         = 0
        notReturned      = 0
        rebootFailed     = 0
        skipped          = 0
        reportOnly       = $true
    }
    return
}

$willReboot = ($RebootMode -eq 'reboot')

if ($DelayBetweenServersSec -lt 0) {
    Write-Log "DelayBetweenServersSec must be 0 or greater, but was $DelayBetweenServersSec. Nothing was done." 'ERROR'
    Write-Result @{ serversRequested = $servers.Count; pendingReboot = 0; rebooted = 0; notReturned = 0; rebootFailed = 0; skipped = 0; reportOnly = (-not $willReboot) }
    return
}

if ($VerifyPollSec -lt 1 -or $VerifyTimeoutSec -lt 1 -or $VerifyPollSec -gt $VerifyTimeoutSec) {
    Write-Log "VerifyPollSec ($VerifyPollSec) and VerifyTimeoutSec ($VerifyTimeoutSec) must both be at least 1, and the poll interval must not exceed the timeout -- otherwise a server would never be polled. Nothing was done." 'ERROR'
    Write-Result @{ serversRequested = $servers.Count; pendingReboot = 0; rebooted = 0; notReturned = 0; rebootFailed = 0; skipped = 0; reportOnly = (-not $willReboot) }
    return
}

if ($HeaderNote -eq '') { $HeaderNote = '(group not named)' }

# S-14: there is no longer a path to validate here. The pre-reboot step is the
# $PreRebootStep script block in this file, so it cannot be missing -- which is the
# whole point of embedding it. Defect S-6 was a path that silently resolved to
# nothing; that failure mode no longer exists.
if ($RunPreRebootScript -eq 'yes' -and $willReboot) {
    Write-Log "Pre-reboot step is ENABLED. It will run on every server that is rebooted, and it loosens ACLs on usbstor.inf and termsrv.dll. This has never run in production before (defect S-6)." 'WARN'
}

Write-Log "==============================================="
Write-Log "Servers to check  : $($servers.Count)"
Write-Log "Reboot mode       : $RebootMode$(if (-not $willReboot) { "  (REPORT ONLY - nothing will be rebooted)" })"
Write-Log "Delay between     : ${DelayBetweenServersSec}s"
Write-Log "Verify timeout    : ${VerifyTimeoutSec}s, polling every ${VerifyPollSec}s"
Write-Log "Pre-reboot step   : $RunPreRebootScript$(if ($RunPreRebootScript -eq 'yes') { '  (embedded; loosens ACLs on usbstor.inf and termsrv.dll)' })"
Write-Log "==============================================="

# ---------------------------------------------------------------------------
# 1. Find out which servers have a reboot pending
# ---------------------------------------------------------------------------
$status = @(Get-RebootStatus -Servers $servers)

# ---------------------------------------------------------------------------
# 2. Build the per-server record set
#
# Driven from the REQUESTED server list, not from the status output, so a server
# that returned nothing at all still appears in the report rather than vanishing.
# ---------------------------------------------------------------------------
$report = @()

foreach ($s in $servers) {
    $name = $s.ToUpper()
    $r    = $status | Where-Object { $_.ComputerName -eq $name } | Select-Object -First 1

    $pending = 'No status returned'
    $preBoot = $null
    $session = ''
    $audit   = ''

    if ($r) {
        $pending = [string]$r.PendingReboot
        $preBoot = $r.ComputerlastBootUptime
        $session = $r.UserSession
        $audit   = $r.CrashOnAuditFail
    }

    $rec = [PSCustomObject]@{
        ComputerName      = $name
        PendingReboot     = $pending
        PreRebootLastBoot = $preBoot
        UserSession       = $session
        CrashOnAuditFail  = $audit
        RebootIssued      = $false
        RebootIssuedAt    = $null
        BackOnline        = $false
        NewLastBoot       = $null
        DurationSec       = 0
        Status            = ''
        Detail            = ''
    }

    # S-8: ONLY an explicit 'True' is a reboot target.
    #
    # The old test was !(PendingReboot -eq 'False'), which is also true for
    # 'Error Accessing Server' -- so a server whose pending state could NOT be read
    # was force-rebooted (shutdown /f) anyway. Never reboot a machine that could not
    # first be interrogated.
    if ($pending -eq 'True') {
        $rec.Status = 'PendingReboot'
        $rec.Detail = 'Pending reboot detected; queued for reboot.'
    }
    elseif ($pending -eq 'False') {
        $rec.Status = 'Skipped-NoRebootRequired'
        $rec.Detail = 'No pending reboot; not rebooted.'
    }
    else {
        $rec.Status = 'Skipped-StatusUnknown'
        $rec.Detail = "Pending-reboot state could not be determined ('$pending'); server skipped and NOT rebooted."
        Write-Log "$name : pending-reboot state could not be determined ('$pending') - skipped and NOT rebooted" 'ERROR'
    }

    $report += $rec
}

$rebootTargets = @($report | Where-Object { $_.Status -eq 'PendingReboot' })
Write-Log "Servers requiring a reboot: $($rebootTargets.Count) of $($servers.Count)"

# ---------------------------------------------------------------------------
# 3. Reboot them, or say what would have been rebooted
# ---------------------------------------------------------------------------
if ($willReboot -and $rebootTargets.Count -gt 0) {

    # -- Phase 1: issue every reboot, with the delay between each ------------
    # Indexed rather than foreach so the delay can be skipped after the LAST
    # server -- see the note at the Start-Sleep below.
    for ($i = 0; $i -lt $rebootTargets.Count; $i++) {
        $t = $rebootTargets[$i]

        # S-13: opt-in, default off. S-14: the step is the $PreRebootStep script
        # block in this file, sent to the server rather than read from a path.
        #
        # A failure here is non-fatal BY DECISION, matching the historic intent:
        # log an error and still reboot the server. Two kinds of failure are
        # possible and both are reported, because they have different causes:
        #   - the remote session itself fails      -> caught below
        #   - a takeown/icacls command fails       -> returned in $problems
        # The second kind never surfaced at all before, because native executables
        # raise no exception (the same defect class as S-9).
        if ($RunPreRebootScript -eq 'yes') {
            try {
                Write-Log "$($t.ComputerName) : running the embedded pre-reboot step"
                $problems = Invoke-Command -ComputerName $t.ComputerName -ScriptBlock $PreRebootStep -ErrorAction Stop

                foreach ($problem in @($problems)) {
                    Write-Log "$($t.ComputerName) : pre-reboot step - $problem. Rebooting anyway." 'ERROR'
                }
                if (@($problems).Count -eq 0) {
                    Write-Log "$($t.ComputerName) : pre-reboot step completed"
                }
            }
            catch {
                Write-Log "$($t.ComputerName) : pre-reboot step could not run - $($_.Exception.Message). Rebooting anyway." 'ERROR'
            }
        }

        if (Invoke-RebootCommand -Server $t.ComputerName) {
            $t.RebootIssued   = $true
            $t.RebootIssuedAt = Get-Date
            $t.Status         = 'RebootIssued'
            $t.Detail         = 'Reboot command accepted; awaiting verification.'
        }
        else {
            $t.RebootIssued = $false
            $t.Status       = 'RebootFailed'
            $t.Detail       = 'shutdown command was rejected; see the ERROR line in the transcript.'
        }

        # The delay is BETWEEN servers, so there is nothing to wait for after the
        # last one. Sleeping there just adds DelayBetweenServersSec of dead time to
        # every run before verification even starts -- with a 600s delay and two
        # servers that was ten wasted minutes out of a twenty-one minute run.
        if ($i -lt ($rebootTargets.Count - 1)) {
            Start-Sleep -Seconds $DelayBetweenServersSec
        }
    }

    # -- Phase 2: one verification pass over everything actually rebooted ----
    Wait-ServersBackOnline -Targets $report -TimeoutSec $VerifyTimeoutSec -PollSec $VerifyPollSec
}
elseif ($rebootTargets.Count -gt 0) {
    Write-Log "RebootMode is '$RebootMode', not 'reboot' - report-only run. $($rebootTargets.Count) server(s) require a reboot but none were rebooted."
    foreach ($t in $rebootTargets) {
        $t.Status = 'Skipped-ReportOnly'
        $t.Detail = "Pending reboot detected but RebootMode was '$RebootMode', not 'reboot'."
    }
}
else {
    Write-Log 'No servers require a reboot.'
}

# ---------------------------------------------------------------------------
# 4. Report, and mail it if asked to
# ---------------------------------------------------------------------------
$rebootedOk   = @($report | Where-Object { $_.Status -eq 'Rebooted' }).Count
$notReturned  = @($report | Where-Object { $_.Status -eq 'NotReturned' }).Count
$rebootFailed = @($report | Where-Object { $_.Status -eq 'RebootFailed' }).Count
$skipped      = @($report | Where-Object { $_.Status -like 'Skipped-*' }).Count

$subject = "$MailSubject - $rebootedOk of $($rebootTargets.Count) pending server(s) rebooted and verified"

# The per-server outcome goes into the transcript EVERY run, not only when mail is
# on. Orchestrator's run log is the one record that always exists -- a run with
# EmailReport off used to leave no per-server account of what happened anywhere.
Write-Log '--- per-server outcome ---'
foreach ($r in ($report | Sort-Object -Property Status, ComputerName)) {
    Write-Log ('  {0,-40} {1,-26} {2}' -f $r.ComputerName, $r.Status, $r.Detail)
}

# The HTML is only built when it has somewhere to go.
if ($EmailReport -eq 'yes') {
    $html = New-RebootReportHtml -Data $report -GroupLabel $HeaderNote -TimeoutSec $VerifyTimeoutSec
    Send-ReportMail -Body $html -Subject $subject
}
else {
    Write-Log 'EmailReport is no - the per-server outcome above is the only report for this run.'
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
Write-Log "==============================================="
Write-Log "Servers checked      : $($servers.Count)"
Write-Log "Pending a reboot     : $($rebootTargets.Count)"
if ($willReboot) {
    Write-Log "Rebooted and verified: $rebootedOk"
    Write-Log "Did not return       : $notReturned"
    Write-Log "Reboot rejected      : $rebootFailed"
}
else {
    Write-Log "Would have rebooted  : $($rebootTargets.Count)  (report only - nothing was rebooted)"
}
Write-Log "Skipped              : $skipped"
Write-Log "Errors               : $($script:ErrorMessages.Count)"

Write-Result @{
    serversRequested = $servers.Count
    pendingReboot    = $rebootTargets.Count
    rebooted         = $rebootedOk
    notReturned      = $notReturned
    rebootFailed     = $rebootFailed
    skipped          = $skipped
    reportOnly       = (-not $willReboot)
}
