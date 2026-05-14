# ═══════════════════════════════════════════════════════════════════════════════
# cvs_functions.ps1 — ADDITIVE CHANGES ONLY
# Phase 1 Delivery — Windows Archive Log Management
# ═══════════════════════════════════════════════════════════════════════════════
#
# This file documents ONLY the three additive changes required to cvs_functions.ps1.
# NO existing code is modified.  Apply these changes to your existing deployed
# cvs_functions.ps1 in the locations described below.
#
# Change summary:
#   1. Add 'move-archived-logs-ByHostList' to [ValidateSet] on $Action parameter
#   2. Add $HostList parameter to the parameter block
#   3. Add 'move-archived-logs-ByHostList' case to the Main switch block
#
# ───────────────────────────────────────────────────────────────────────────────
# CHANGE 1 — [ValidateSet] on $Action parameter
# ───────────────────────────────────────────────────────────────────────────────
#
# Locate the existing [ValidateSet] attribute on $Action.  It will look similar to:
#
#   [ValidateSet('move-archived-logs', 'move-archived-logs-ByCN', 'Delete-OldFiles-UNC-Share')]
#
# Add 'move-archived-logs-ByHostList' to the set.  Result:
#
#   [ValidateSet('move-archived-logs', 'move-archived-logs-ByCN', 'Delete-OldFiles-UNC-Share', 'move-archived-logs-ByHostList')]
#
# ───────────────────────────────────────────────────────────────────────────────
# CHANGE 2 — $HostList parameter
# ───────────────────────────────────────────────────────────────────────────────
#
# Add this parameter to the existing param() block.
# Place it after the last existing parameter.

    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$HostList

# ───────────────────────────────────────────────────────────────────────────────
# CHANGE 3 — New switch case in the Main switch block
# ───────────────────────────────────────────────────────────────────────────────
#
# Locate the existing switch ($Action) { ... } block in the Main function.
# Add the following case before the closing brace of the switch statement.

        'move-archived-logs-ByHostList' {
            if ([string]::IsNullOrEmpty($HostList)) {
                Write-Log "Error: HostList is required for move-archived-logs-ByHostList" $true
                throw "HostList is required."
            }

            $hosts = $HostList -split ',' |
                     ForEach-Object { $_.Trim() } |
                     Where-Object   { $_ -ne ''  }

            if ($hosts.Count -eq 0) {
                Write-Log "Warn: HostList resolved to zero entries after parsing. No action taken." $true
                return
            }

            Write-Log "Info: move-archived-logs-ByHostList - processing $($hosts.Count) host(s)" $true

            foreach ($h in $hosts) {
                $hostname = $h.Split('.')[0]
                Write-Log "Info: $hostname - moving archived files to $($FileShareTarget)\$hostname" $true
                Move-files -Path       "\\$h\C$\Windows\System32\winevt\Logs" `
                           -ServerName $hostname `
                           -TargetPath "$($FileShareTarget)\$hostname" `
                           -FilterOn   "Archive*.evtx" `
                           -Days       '-1' `
                           -F          'force'
            }
        }

# ═══════════════════════════════════════════════════════════════════════════════
# END OF ADDITIVE CHANGES
# ═══════════════════════════════════════════════════════════════════════════════
#
# After applying changes, verify the script on the PS host:
#
#   1. Syntax check:
#      powershell.exe -NoProfile -NonInteractive -Command "& { . 'C:\PSO\Scripts\cvs_functions.ps1' }"
#      (should exit with no errors if the script just defines functions and does not auto-execute)
#
#   2. ValidateSet acceptance:
#      The parameter validator will reject any -Action value not in the ValidateSet at runtime.
#      Test with a benign call:
#        & 'C:\PSO\Scripts\cvs_functions.ps1' -Action 'move-archived-logs-ByHostList' -HostList '' -FileShareTarget '\\server\share$\test'
#      Expected: Write-Log error message and thrown exception (HostList is required).
#
#   3. Dry-run functional test:
#      & 'C:\PSO\Scripts\cvs_functions.ps1' -Action 'move-archived-logs-ByHostList' -HostList 'pshostfqdn.corp.local' -FileShareTarget '\\fileserver\mdcarchivelog$\Windows'
#      Expected: Logs show processing 1 host.  Verify target subfolder is created.
#      Use a non-production destination for initial testing.
