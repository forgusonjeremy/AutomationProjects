[CmdletBinding()]
param (
    [ValidateSet('move-archived-logs-ByCN','Delete-OldFiles-UNC-Share','tls-fix','move-archived-logs','clean-ServerDisk','Invoke-ServerReboot','Get-ServerPendingRebootStatus','Get-ServerRebootReportStatus-ByCN','Get-AllAdmin-Accounts','Get-ServiceAccountExpiration','get_datastores_75_100_used','VMware_Disable_SSH')]
    [string]$Action,
    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$eMailReport='yes',
    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$SMTPServer,
    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$MailToString = 'admin@vcf.lab',
    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$MailCcString = 'admin@vcf.lab',
    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$MailSubjectstring,
    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$OUPath,
    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$HeaderNotesSubstr,
    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$ADGroupMember,
    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$vCenterList,
    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$RebootIt = "no",
    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$RebootIt_DelayBetweenServer = "60",
    # S-10: post-reboot verification budget. After all reboots are issued, each
    # rebooted server is polled until its LastBootUpTime advances past the value
    # captured before the reboot, or until this many seconds elapse (per server,
    # measured from that server's own reboot time).
    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$RebootIt_VerifyTimeoutSec = "600",
    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$RebootIt_VerifyPollSec = "15",
    # S-13: opt-in gate for the pre-reboot script (ownership_w2k.ps1).
    # DEFAULT IS 'no' - the step does NOT run unless explicitly enabled.
    # Rationale: because of the S-6 defect this step has never actually executed
    # (the script path resolved to "/ownership_w2k.ps1" and Invoke-Command failed
    # non-terminating). Fixing S-6 would silently START applying it. The script
    # takes ownership of and loosens ACLs on c:\windows\inf\usbstor.inf (USB mass
    # storage driver INF - a common hardening DENY target) and
    # c:\windows\system32\termsrv.dll (Terminal Services). Re-enabling that on
    # every rebooted member of a security group is a security-posture change and
    # must be a deliberate, reviewed decision - not a side effect of a bug fix.
    # Set to 'yes' only after security review.
    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$RebootIt_RunPreRebootScript = "no",
    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$FileShareTarget,
    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$FolderTarget,
    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$FolderIncluded = 'no',
    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$ForceEnable = 'no',
    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$NumberOfDays = '0',
    [Parameter(Mandatory=$false)]
    [ValidateNotNullOrEmpty()]
    [string] $FilterOn = '*',
    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$ActionRemoteFile,
    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$DomainName,
    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$SecurityGroup_CN,
    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$UNC_SharePath,
    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$WhatIf,
    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$OlderThanDays,
    # S-16: multi-domain OU map for Get-AllAdmin-Accounts, merged in from the
    # cvs_functions-v2.ps1 fork. A JSON object of domain -> array of OU DNs, e.g.
    #   {"domain1.corp.local":["OU=Admin Accounts,OU=Servers,DC=domain1,DC=corp,DC=local"]}
    # Supply it EITHER inline via -DomainOUs (the vRO path - Orchestrator has no
    # file-staging step) OR as a path to a JSON file via -DomainOUsFile (the legacy
    # Ansible path, where win_copy wrote domain_ous.json to a temp dir). If both are
    # given, -DomainOUsFile wins and the inline value is ignored (logged).
    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$DomainOUs,
    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$DomainOUsFile,
    # S-22: look-ahead window for Get-ServiceAccountExpiration, in days. An account
    # whose AccountExpirationDate falls within this many days of now is reported as
    # EXPIRING and is called out at the top of the report and in the mail subject.
    # Accounts already past their expiration date are reported as EXPIRED regardless
    # of this value, and NOTHING is filtered out of the report by it - the full
    # inventory is always listed. Passed as a string like every other parameter here
    # (the vRO PowerShell plug-in sends strings) and parsed with an explicit guard.
    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$ExpiringWithinDays = '30'
)

[string[]]$MailTo = $MailToString.split(',')
[string[]]$MailCc = $MailCcString.split(',')


Function Temp { # template function
    [CmdletBinding()]
    Param(
        [Parameter(Mandatory=$true)]
        [ValidateNotNullOrEmpty()]
        [string] $InformationItem,

        [Parameter(Mandatory=$false)]
        [ValidateNotNullOrEmpty()]
        [string] $ConsoleOut
    )
    Begin{
    }
    Process{
        Try { 


        }Catch{ Write-Log "$_.Exception.message" $true} 
    }
}       # template function


Function Convert-YAMLList { # Convert-YAMLList
    [CmdletBinding()]
    Param(
        [Parameter(Mandatory=$true)]
        [ValidateNotNullOrEmpty()]
        [string] $InformationItem
    )
    Begin{
    }
    Process{
        Try {
            $InformationItem = $InformationItem.Trim()
            $InformationItem = $InformationItem.Replace('[', '')
            $InformationItem = $InformationItem.Replace(']', '')
            $InformationItem = $InformationItem.Replace('\\', '\')
            $InformationItem = $InformationItem.Replace("'", '')
            return $InformationItem
        }Catch{ Write-Log "$_.Exception.message" $true} 
    }
}       # Convert-YAMLList

Function Get-ScriptDirectory { # Get-ScriptDirectory
    [CmdletBinding()]
    Param(
        [Parameter(Mandatory=$false)]
        [ValidateNotNullOrEmpty()]
        [string] $InformationItem

    )
    Begin{
    }
    Process{
        Try { 

            if ($psise) {
                Split-Path $psise.CurrentFile.FullPath
            }
            else {
                # S-6: was $global:PSScriptRoot. $PSScriptRoot is an AUTOMATIC
                # variable scoped to the running script - it is not published to
                # the global scope, so $global:PSScriptRoot was always $null and
                # this function returned an empty string. Callers that build a
                # path from it (Invoke-ServerReboot -> "$scriptDir/ownership_w2k.ps1",
                # tls-fix -> "$scriptDir/$ActionRemoteFile") therefore produced a
                # rooted path like "/ownership_w2k.ps1", which Invoke-Command
                # failed to find. That failure is non-terminating, so the reboot
                # loop continued and the pre-reboot step was silently skipped.
                $PSScriptRoot
            }

        }Catch{ Write-log "Error: $_.Exception.message" $true} 
    }
}       # Get-ScriptDirectory

Function Invoke-PSFileRemotely { # Invoke-PSFileRemotely -computername CVSDWinRM02 -ScriptFile "C:\TempDir\cvs.ps1"
    [CmdletBinding()]
    Param(
        [Parameter(Mandatory=$false)]
        [ValidateNotNullOrEmpty()]
        [string] $computername,

        [Parameter(Mandatory=$true)]
        [ValidateNotNullOrEmpty()]
        [string] $ScriptFile,

        [Parameter(Mandatory=$false)]
        [ValidateNotNullOrEmpty()]
        [string] $Argstr = '',

        [Parameter(Mandatory=$false)]
        [ValidateNotNullOrEmpty()]
        [string] $Wait = 'true'
    )
    Begin{
 
    }
    Process{
        Try {

            if (Test-Path $ScriptFile) {
                #& $BatchFile
                Invoke-Command -ComputerName $computername -FilePath $ScriptFile
            } else {
                Write-Host "Error: File not found."
            }

        }Catch{ Write-Host "$_.Exception.message" $true} 
    }
}       # Invoke-PSFileRemotely

Function Remove-files { # Remove-files -Path "C:\TempDir" -FilterOn "*.ps1" -Days '-30'
    [CmdletBinding()]
    Param(
        [Parameter(Mandatory=$true)]
        [ValidateNotNullOrEmpty()]
        [string] $Path = 'c:\temp',

        [Parameter(Mandatory=$false)]
        [ValidateNotNullOrEmpty()]
        [string] $FilterOn = '*',

        [Parameter(Mandatory=$false)]
        [ValidateNotNullOrEmpty()]
        [string] $FolderIncluded = 'yes',

        [Parameter(Mandatory=$false)]
        [ValidateNotNullOrEmpty()]
        [string] $ForceEnable = 'no',

        [Parameter(Mandatory=$false)]
        [ValidateNotNullOrEmpty()]
        [string] $NumberOfDays = 0,

        # S-15: report-only preview. When $true, the candidate items are enumerated
        # and logged as "WouldDelete" but NOTHING is removed. Mirrors the S-1
        # report-only mode on Remove-OldFiles-UNCPath so the clean-ServerDisk action
        # can offer a safe dry-run (whatIf='yes').
        [Parameter(Mandatory=$false)]
        [bool] $ReportOnly = $false,

        # S-15: optional server context for log lines. The clean-ServerDisk loop
        # (S-14) passes the target name so a failure line identifies which server
        # it belongs to.
        [Parameter(Mandatory=$false)]
        [string] $ServerName = ''
    )
    Begin{
        $dateTime = (Get-Date).AddDays([int]$NumberOfDays)
        $ctx = if ([string]::IsNullOrWhiteSpace($ServerName)) { '' } else { "[$ServerName] " }
    }
    Process{
        Try {
            $FolderIncluded = $FolderIncluded.ToLower()
            $ForceEnable = $ForceEnable.ToLower()
            $FileExclude = "vmware-vmsvc-SYSTEM.log"

            # S-15: candidate selection is now a SINGLE pipeline (was four near-identical
            # branches) so report-only and live delete share identical selection.
            #   FolderIncluded='yes' -> include directories (no -File); 'no' -> -File only.
            # -ErrorAction Stop promotes an unreachable target (server down / inaccessible
            # \\server\C$ admin share) from a SILENT non-terminating error on the PS error
            # stream into a TERMINATING error caught below and logged to stdout - the S-3
            # fix (previously applied to Move-files), applied here to Remove-files.
            $gciParams = @{ Path = $Path; Recurse = $true; Filter = $FilterOn; ErrorAction = 'Stop' }
            if ($FolderIncluded -ne 'yes') { $gciParams['File'] = $true }

            $candidates = @(Get-ChildItem @gciParams |
                Where-Object { $_.LastWriteTime -lt $dateTime -and $_.Name -cne $FileExclude })

            $count = $candidates.Count

            # Report-only: list what WOULD be removed, delete nothing.
            if ($ReportOnly) {
                Write-Log "Info: $($ctx)ReportOnly - $count item(s) under '$Path' match FilterOn:$FilterOn FolderIncluded:$FolderIncluded ForceEnable:$ForceEnable NumberOfDays:$NumberOfDays. NOTHING will be deleted." $true
                foreach ($c in $candidates) {
                    Write-Log "Info: $($ctx)[ReportOnly] WouldDelete: $($c.FullName) (LastWriteTime: $($c.LastWriteTime))" $true
                }
                return
            }

            Write-Log "Info: $($ctx)cleaning $($Path) - $count item(s) - FolderIncluded:$FolderIncluded FilterOn:$FilterOn ForceEnable:$ForceEnable NumberOfDays:$NumberOfDays" $true

            # Delete per item (not one bulk pipe) so a single failure is logged and the
            # rest still proceed ("any failure should be logged"). ForceEnable='yes'
            # keeps the original -Force semantics (removes read-only/hidden items).
            $useForce = ($ForceEnable -eq 'yes')
            $deleted = 0; $failed = 0
            foreach ($c in $candidates) {
                Try {
                    if ($useForce) {
                        Remove-Item -LiteralPath $c.FullName -Force -Recurse -Confirm:$false -ErrorAction Stop
                    } else {
                        Remove-Item -LiteralPath $c.FullName -Recurse -Confirm:$false -ErrorAction Stop
                    }
                    $deleted++
                } Catch {
                    # A child already removed by a parent directory's -Recurse is not a
                    # real failure - only count/log it if the item is genuinely still there.
                    if (Test-Path -LiteralPath $c.FullName) {
                        $failed++
                        Write-Log "Error: $($ctx)failed to delete '$($c.FullName)': $($_.Exception.Message)" $true
                    }
                }
            }
            Write-Log "Info: $($ctx)deleted $deleted item(s); $failed failure(s) under '$Path'." $true

        }Catch{
            # S-15: fixed the malformed catch message ("Error: $_.Exception.message"
            # never expanded the exception and mislabelled the stream) to a proper,
            # context-tagged message. Non-terminating for the overall run: the
            # clean-ServerDisk loop's own try/catch (S-14) continues with the next server.
            Write-Log "Error: $($ctx)failed cleaning '$FilterOn' under '$Path': $($_.Exception.Message)" $true
        }
    }
}       # Remove-files

Function Remove-OldFiles-UNCPath {    
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true, Position=0)]
        [ValidateNotNullOrEmpty()]
        [string]$Path,
        
        [Parameter(Mandatory=$false)]
        [ValidateRange(1, 36500)]
        [int]$OlderThanDays = 365,
        
        [Parameter(Mandatory=$false)]
        [bool]$Recurse=$true,

        [Parameter(Mandatory=$false)]
        [bool]$Force=$false,

        [Parameter(Mandatory=$false)]
        [bool]$ReportOnly=$false
    )
    
    begin {
        # Calculate the cutoff date based on days
        $CutoffDate = (Get-Date).AddDays(-$OlderThanDays)
        
        write-log "Info: Cutoff date set to: $CutoffDate ($OlderThanDays days ago)" $true
        write-log "Info: Files modified before this date will be deleted" $true
        
        # Validate the path exists
        if (-not (Test-Path -Path $Path)) {
            write-log "Error: Path not found: $Path" $true
            return
        }
        
        # Initialize counters
        $DeletedCount = 0
        $ErrorCount = 0
        $TotalSize = 0
        $DeletedSize = 0
    }
    
    process {
        try {
            # Get files based on Recurse parameter
            $GetChildItemParams = @{
                Path = $Path
                File = $true
                ErrorAction = 'Stop'
            }
            
            if ($Recurse) {
                $GetChildItemParams['Recurse'] = $true
            }
            
            write-log "Info: Scanning for files in: $Path" $true
            if ($Recurse) {
                write-log "Info: Including subdirectories..." $true
            }
            
            $FilesToDelete = Get-ChildItem @GetChildItemParams | Where-Object {
                $_.LastWriteTime -lt $CutoffDate
            }
            
            if ($FilesToDelete.Count -eq 0) {
                write-log "Info: No files found older than $CutoffDate" $true
                return
            }
            
            write-log "Info: Found $($FilesToDelete.Count) file(s) to delete" $true
            
            # Calculate total size
            $TotalSize = ($FilesToDelete | Measure-Object -Property Length -Sum).Sum
            $TotalSizeMB = [math]::Round($TotalSize / 1MB, 2)
            
            write-log "Info: Total size: $TotalSizeMB MB" $true
            
            # Report-only mode: list the files that WOULD be deleted, then exit
            # without deleting anything.  Replaces the former interactive
            # Read-Host confirmation, which blocked (or silently cancelled with
            # "Operation cancelled by user") in non-interactive sessions such as
            # the VCF Orchestrator PowerShell plug-in.
            if ($ReportOnly) {
                write-log "Info: ReportOnly mode enabled - NO files will be deleted." $true
                write-log "Info: The following $($FilesToDelete.Count) file(s) would be deleted:" $true
                foreach ($File in $FilesToDelete) {
                    write-log "Info: [ReportOnly] WouldDelete: $($File.FullName) (LastWriteTime: $($File.LastWriteTime))" $true
                }
                return
            }
            
            # Delete files
            foreach ($File in $FilesToDelete) {
                try {
                    if ($PSCmdlet.ShouldProcess($File.FullName, "Delete file")) {
                        Remove-Item -Path $File.FullName -Force -ErrorAction Stop
                        
                        $DeletedCount++
                        $DeletedSize += $File.Length
                        write-log "Info: Deleted: $($File.FullName)" $true
                    }
                }
                catch {
                    $ErrorCount++
                    Write-Warning "Failed to delete: $($File.FullName) - Error: $($_.Exception.Message)"
                }
            }
        }
        catch {
            write-log "Error: An error occurred: $($_.Exception.Message)" $true
        }
    }
    
    end {
        # Summary
        $DeletedSizeMB = [math]::Round($DeletedSize / 1MB, 2)
        $DeletedSizeGB = [math]::Round($DeletedSize / 1GB, 2)
        
        Write-Host "`nDeletion Summary:" -ForegroundColor Cyan
        Write-Host "==================" -ForegroundColor Cyan
        Write-Host "  Total files deleted: $DeletedCount" -ForegroundColor Green
        
        if ($DeletedSizeGB -ge 1) {
            Write-Host "  Total size deleted: $DeletedSizeGB GB" -ForegroundColor Green
        } else {
            Write-Host "  Total size deleted: $DeletedSizeMB MB" -ForegroundColor Green
        }
        
        Write-Host "  Errors encountered: $ErrorCount" -ForegroundColor $(if ($ErrorCount -gt 0) { 'Red' } else { 'Green' })
    }
}

Function Move-files { # Move-files -Path "C:\TempDir" -FilterOn "*.ps1" -Days '-30'
    [CmdletBinding()]
    Param(
        [Parameter(Mandatory=$true)]
        [ValidateNotNullOrEmpty()]
        [string] $Path,     

        [Parameter(Mandatory=$false)]
        [ValidateNotNullOrEmpty()]
        [string] $ServerName,

        [Parameter(Mandatory=$true)]
        [ValidateNotNullOrEmpty()]
        [string] $TargetPath,

        [Parameter(Mandatory=$false)]
        [ValidateNotNullOrEmpty()]
        [string] $FilterOn = '*',

        [Parameter(Mandatory=$false)]
        [ValidateNotNullOrEmpty()]
        [string] $Days = '0',

        [Parameter(Mandatory=$false)]
        [ValidateNotNullOrEmpty()]
        [string] $F = 'force'
    )
    Begin{
        $dateTime = (Get-Date).AddDays([int]$Days)
    }
    Process{
        Try {

            if ( !(Test-Path -PathType container $TargetPath) ){
                write-log "info: creating folder $($TargetPath)" $true
                new-item -ItemType Directory -Path $TargetPath -ErrorAction Stop | Out-Null
            }

            # -ErrorAction Stop promotes an unreachable source (e.g. a server that
            # is down or whose C$ admin share is inaccessible) from a silent
            # non-terminating error - which try/catch would NOT catch and which
            # would go to the PS error stream instead of stdout - into a
            # terminating error that lands in the Catch below and is logged via
            # Write-Log (stdout) so the caller can see and report it.
            Get-ChildItem -Path $Path -Recurse -File -Filter $FilterOn -ErrorAction Stop |
                Where-Object { $_.LastWriteTime -lt $dateTime } |
                Move-Item -Destination "$($TargetPath)" -Force -ErrorAction Stop

        }Catch{
            # Non-terminating for the overall run: log the failure (with the
            # server context) and return so the caller's per-server loop can
            # continue with the next server.
            Write-Log "Error: [$ServerName] failed moving '$FilterOn' from '$Path' to '$TargetPath': $($_.Exception.Message)" $true
        }
    }
}       # Move-files

Function Get-RandomPassword { # Get-RandomPassword
    [CmdletBinding()]
    Param(
        [Parameter(Mandatory=$false)]
        [ValidateNotNullOrEmpty()]
        [int] $PasswordLength = 12
    )
    Begin{
    }
    Process{
        Try { 

            #ASCII Character set for Password
            $CharacterSet = @{
                Lowercase   = (97..122) | Get-Random -Count 10 | % {[char]$_}
                Uppercase   = (65..90)  | Get-Random -Count 10 | % {[char]$_}
                Numeric     = (48..57)  | Get-Random -Count 10 | % {[char]$_}
                SpecialChar = (33..47)+(58..64)+(91..96)+(123..126) | Get-Random -Count 10 | % {[char]$_}
            }

            #Frame Random Password from given character set
            $StringSet = $CharacterSet.Uppercase + $CharacterSet.Lowercase + $CharacterSet.Numeric + $CharacterSet.SpecialChar
            $newPW =  -join(Get-Random -Count $PasswordLength -InputObject $StringSet)
            #$randomString = -join ((65..90) | Get-Random -Count 1 | ForEach-Object { [char]$_ })
            $newPW =  'J1M!' + $newPW.substring(1)
            #$newPW = $newPW.substring(1) + $randomString
            $newPW = $newPW.Replace('/','!')
            $newPW = $newPW.Replace('?','!')
            $newPW = $newPW.Replace(':','!')
            $newPW = $newPW.Replace('\','!')
            $newPW = $newPW.Replace('"','!')
            $newPW = $newPW.Replace(',','!')
            $newPW = $newPW.Replace('<','!')
            $newPW = $newPW.Replace('>','!')
            $newPW = $newPW.Replace("'",'!')
            $newPW = $newPW.Replace('`','!')
            $newPW = $newPW.Replace('`','!')
            $newPW = $newPW.Replace('!!!','!*!')

            #Write-Log "Info: generated random text: $newPW"
            Return  $newPW

        }Catch{ Write-Log "Error: $_.Exception.message" $true} 
    }
} # Get-RandomPassword

Function InitializeVariables { # Initialize Variables
    [CmdletBinding()]
    Param(

    )
    Begin{
    }
    Process{
        Try {
            $Global:SystemLog = New-TemporaryFile
            #[string[]]$MailTo = $MailToString.split(',')
            #[string[]]$MailCc = $MailCcString.split(',')
            $Global:DebugDir = "$($PSScriptRoot)\Debug"
            $Global:Today = Get-Date
            $Global:MailFrom = $env:COMPUTERNAME + '_Do_Not_Reply@vcf.lab'
            $Global:MailSubject = ""
            $Global:PKIEnabledCount = 0
            $Global:PKIDisabledCount = 0
            # S-16: per-OU query failures collected during a multi-domain sweep, so
            # they can be rendered INTO the emailed report. The recipient of a
            # compliance report is far more likely to read the email than to open
            # Orchestrator, so a domain or OU that could not be read has to be
            # visible on the report itself - not only as an "Error:" line in the
            # workflow transcript.
            $Global:QueryFailures = @()
            # S-19: accounts collapsed by Remove-DuplicateAccounts, so the report can
            # explain the overlapping OU list that produced them.
            $Global:DuplicateAccounts = @()

        }Catch{ Write-Log "Error: $_.Exception.message" $true}
    }
}       # Initialize Variables

Function Write-Log { # Write-Log
    [CmdletBinding()]
    Param(
        [Parameter(Mandatory=$true)]
        [ValidateNotNullOrEmpty()]
        [string] $InformationItem,

        [Parameter(Mandatory=$false)]
        [ValidateNotNullOrEmpty()]
        [string] $ConsoleOut
    )
    Begin{
        $logMessage = "{0}:`t{1}" -f (Get-Date).ToString('yyyy-MM-dd hh:mm:ss'),$InformationItem
        if($ConsoleOut -eq $true){
            if( $InformationItem -like '*Error:*'){
                write-host $logMessage -ForegroundColor Red
            }elseif( $InformationItem -like '*Warn:*'){
                write-host $logMessage -ForegroundColor DarkYellow
            }elseif( $InformationItem -like '*Info: <<*>>'){
                write-host $logMessage -ForegroundColor DarkYellow
            }elseif( $InformationItem -like '*Info: <<<<*>>>>>>>>'){
                write-host $logMessage -ForegroundColor DarkYellow
            }elseif( $InformationItem -like '*Success:*'){
                write-host $logMessage -ForegroundColor DarkGreen
            }
            else{
                write-host $logMessage
            }
            #Write-Log "Info: << $Actions - $($h.ESXhost) >>" $true
        }

    }
    Process{
        write-verbose "In Process block:Write-Log"
        Try { 

            $logMessage | Add-Content -Path $Global:SystemLog

        }Catch{ write-host $_.Exception.message}

    }
}       # Write-Log

Function CertificateValidation { # CertificateValidation
add-type @"
    using System.Net;
    using System.Security.Cryptography.X509Certificates;
    public class TrustAllCertsPolicy : ICertificatePolicy {
        public bool CheckValidationResult(
            ServicePoint srvPoint, X509Certificate certificate,
            WebRequest request, int certificateProblem) {
            return true;
        }
    }
"@
$AllProtocols = [System.Net.SecurityProtocolType]'Ssl3,Tls,Tls11,Tls12'
[System.Net.ServicePointManager]::SecurityProtocol = $AllProtocols
[System.Net.ServicePointManager]::CertificatePolicy = New-Object TrustAllCertsPolicy
}       # CertificateValidation

Function Invoke-Module{ # Invoke-Module
    [CmdletBinding()]
    param( [parameter (Mandatory = $true)][string]$moduleName)
    
    process{
        Write-Log "Info: checking on Powershell module $($moduleName) if imported"
        $retValue = Get-Module -ListAvailable | Where-Object { $_.Name -eq $moduleName}
        if ($retValue.name -eq $moduleName){
            Write-Log "Info: $($moduleName) has already imported"
            return $true
        }else{
            Write-Log "Info: Importing Module $($moduleName)"
            try{
                # S-12: two defects fixed here.
                #  (a) -ErrorAction SilentlyContinue suppressed the import failure, so a
                #      genuinely missing module never reached the Catch and the function
                #      fell through returning $null. -ErrorAction Stop makes a failed
                #      import terminating so the Catch (and 'return $false') actually fire.
                #  (b) the success path had no 'return $true' - it fell out of the else
                #      block returning $null (falsy). Every caller tests
                #      'if (Invoke-Module $strModule)', so a module that imported
                #      successfully on this path was misreported as unavailable.
                Import-Module $moduleName -ErrorAction Stop
                Write-Log "Info: Success - loaded module $($moduleName)" $true
                return $true
            }catch{ Write-log "Error: Issue importing module $($moduleName) - $($_.Exception.Message)" $true; return $false }
        }

    }

}       # Invoke-Module

function Get-ListOfUsers{
    # ***  SUPERSEDED (S-22) - DO NOT USE IN NEW CODE, AND DO NOT "FIX" IT IN PLACE.  ***
    #
    # Single-domain / single-OU user query. Superseded by Get-ListOfUsers-MultiDomain,
    # which takes a domain -> OU map, isolates per-OU failures, tags each account with
    # SourceDomain/SourceOU, and reaches the all-accounts query path correctly.
    #
    # NO REACHABLE ACTION CALLS THIS ANY MORE. Its only two callers - 'Get-Users-SCenable'
    # and 'Set-L3-Admin-Accounts' - are both ABSENT from the -Action ValidateSet, so the
    # parameter is rejected before Main dispatches and neither case can execute. (For
    # Set-L3-Admin-Accounts that omission is deliberate and load-bearing: it performs an
    # unattended MASS WRITE of SmartcardLogonRequired. Do not add either name to the
    # ValidateSet without a separate, reviewed change.)
    #
    # IT CARRIES A LIVE DEFECT, recorded here so nobody re-adopts it believing it works:
    #
    #   $SC is typed [bool] and is NOT mandatory, so an OMITTED -SC binds to $false
    #   rather than staying null. The guard below - `if ($SC -eq $true -OR $SC -eq $false)`
    #   - is therefore ALWAYS TRUE, and the -Filter * branch beneath it is UNREACHABLE
    #   DEAD CODE. A caller that omitted -SC intending "every user in the OU" silently
    #   got "only users where SmartcardLogonRequired is False".
    #
    #   That is exactly what Get-ServiceAccountExpiration did on every run before S-22:
    #   the expiration report silently omitted every service account that DOES require a
    #   smart card, and reported success. Get-ListOfUsers-MultiDomain declares $SC
    #   untyped with a $null default, so omitting it genuinely reaches -Filter *.
    #
    # $OUPath - the script parameter this function reads - likewise has no reachable
    # caller left. Both are retained only so the two disabled cases still parse.
    [CmdletBinding()]
    param( [parameter (Mandatory = $false)]
    [bool]$SC,

    [parameter (Mandatory = $false)]
    [string]$DomainName    
    )   
    process{
        if($SC -eq $true -OR $SC -eq $false){

            $OUQuery1 = Get-ADUser -Server $DomainName -Filter {SmartcardLogonRequired -eq $SC}  `
            -Properties SamAccountName, UserPrincipalName, smartcardlogonrequired, DisplayName, Office, Enabled, Lockedout, pwdLastSet, AccountExpirationDate, WhenCreated, Description `
            -searchBase $OUPath `
            -searchScope subtree
            $OUQuery1
        }
        else{

            $OUQuery1 = Get-ADUser -Server $DomainName -Filter * `
            -Properties SamAccountName, UserPrincipalName, smartcardlogonrequired, DisplayName, Office, Enabled, Lockedout, pwdLastSet, AccountExpirationDate, WhenCreated, Description `
            -searchBase $OUPath `
            -searchScope subtree
            $OUQuery1
        }
    }

}

function Resolve-DomainOUsMap {
    # S-16: builds the domain -> OU-list map used by Get-AllAdmin-Accounts.
    #
    # Merged in from cvs_functions-v2.ps1, WITH THREE DEFECT FIXES:
    #
    #  (a) In the v2 fork the map was only ever built inside `if ($DomainOUsFile)`.
    #      Passing the map INLINE via -DomainOUs left $DomainOUsMap completely
    #      unset, so Get-ListOfUsers-MultiDomain iterated nothing, the report came
    #      back empty and the run still reported success. Inline JSON is exactly
    #      what the vRO caller uses (Orchestrator invokes a PRE-STAGED script and
    #      has no win_copy step to write domain_ous.json), so this path had to work.
    #
    #  (b) ConvertFrom-Json had no error handling. Malformed JSON produced a raw
    #      PowerShell parser error on the ERROR stream - invisible to the workflow,
    #      which only classifies "Error:" lines on stdout - and the run continued
    #      with a null map. It now throws with a clear message (a bad map is a TOTAL
    #      failure: nothing can be queried, so the run must fail rather than email
    #      an empty compliance report).
    #
    #  (c) The v2 fallback assigned an empty HASHTABLE (@{}) when the JSON was blank.
    #      Every consumer walks the map with .PSObject.Properties.Name, which on a
    #      hashtable returns its .NET members (Keys, Values, Count, ...) rather than
    #      domain names - so the "empty" case silently produced garbage domains. This
    #      returns $null instead and the caller applies an explicit zero guard.
    #
    # This is a FUNCTION rather than v2's top-of-script block on purpose: the block
    # ran before InitializeVariables, so any Write-Log inside it had no
    # $Global:SystemLog to write to.
    [CmdletBinding()]
    Param(
        [Parameter(Mandatory=$false)]
        [string] $Json,          # inline JSON  (-DomainOUs)     - the vRO path

        [Parameter(Mandatory=$false)]
        [string] $Path           # JSON file    (-DomainOUsFile) - the legacy Ansible path
    )
    Process{
        $raw = $null

        if (-not [string]::IsNullOrWhiteSpace($Path)) {
            if (-not [string]::IsNullOrWhiteSpace($Json)) {
                Write-Log "Info: both -DomainOUsFile and -DomainOUs were supplied; the FILE takes precedence and the inline value is ignored." $true
            }
            if (-not (Test-Path -LiteralPath $Path)) {
                Write-Log "Error: DomainOUsFile not found: '$Path'." $true
                throw "DomainOUsFile not found: '$Path'."
            }
            Try {
                $raw = Get-Content -Raw -Path $Path -ErrorAction Stop
            } Catch {
                Write-Log "Error: could not read DomainOUsFile '$Path': $($_.Exception.Message)" $true
                throw "Could not read DomainOUsFile '$Path': $($_.Exception.Message)"
            }
        }
        elseif (-not [string]::IsNullOrWhiteSpace($Json)) {
            $raw = $Json
        }

        if ([string]::IsNullOrWhiteSpace($raw)) {
            Write-Log "Warn: no domain/OU map supplied (-DomainOUs and -DomainOUsFile are both empty)." $true
            return $null
        }

        # Malformed JSON is a TOTAL failure - with no map there is nothing to query,
        # and an empty compliance report is worse than a failed run because it reads
        # as "zero non-compliant accounts".
        Try {
            $map = ConvertFrom-Json $raw -ErrorAction Stop
        } Catch {
            Write-Log "Error: DomainOUs value is not valid JSON: $($_.Exception.Message)" $true
            throw "DomainOUs value is not valid JSON: $($_.Exception.Message)"
        }

        if ($null -eq $map) {
            Write-Log "Warn: domain/OU map parsed to null." $true
            return $null
        }

        $domains = @($map.PSObject.Properties.Name)
        if ($domains.Count -eq 0) {
            Write-Log "Warn: domain/OU map contains no domains." $true
            return $null
        }

        $ouTotal = 0
        foreach ($d in $domains) { $ouTotal += @($map.$d).Count }
        Write-Log "Info: domain/OU map resolved to $($domains.Count) domain(s) and $ouTotal OU(s): $($domains -join ', ')" $true

        return $map
    }
}       # Resolve-DomainOUsMap

function Get-ListOfUsers-MultiDomain {
    # S-16: multi-domain / multi-OU user query, merged in from cvs_functions-v2.ps1.
    #
    # Queries EVERY OU in EVERY domain of the map and returns the combined user set.
    # This is the multi-domain counterpart of Get-ListOfUsers, which can only search
    # one -DomainName / one $OUPath.
    #
    # HARDENING ADDED HERE (not present in the v2 fork):
    #  - Per-OU try/catch with -ErrorAction Stop. Without it a single bad OU DN, a
    #    domain that will not answer, or a trust failure raised a NON-TERMINATING
    #    error on the PS error stream: invisible to the vRO workflow (which
    #    classifies "Error:" lines on stdout), so a partial sweep was reported as a
    #    clean run and the missing accounts read as "compliant". Now each failure is
    #    logged as an "Error:" line - the run is classified Completed with Errors -
    #    and the remaining OUs are still queried. Same defect/fix as S-3 (Move-files)
    #    and S-15 (Remove-files).
    #  - Write-Host "DEBUG: ..." replaced with Write-Log "Info: ...". The v2 DEBUG
    #    lines never reached the log file and carried no prefix the workflow
    #    recognises.
    #
    # The AD query itself (filter, properties, SearchScope Subtree) is UNCHANGED from
    # the v2 fork so the report content matches what the customer receives today.
    [CmdletBinding()]
    param(
        # NOT Mandatory, and AllowNull: a Mandatory parameter REJECTS $null at bind
        # time with a non-terminating "Cannot bind argument ... because it is null",
        # which would make the null guard below unreachable dead code and return
        # nothing without ever logging why. Accept null and handle it explicitly.
        [Parameter(Mandatory=$false)]
        [AllowNull()]
        $DomainOUsMap,

        [Parameter(Mandatory=$false)]
        $SC = $null
    )
    Process{
        $results = @()

        if ($null -eq $DomainOUsMap) {
            Write-Log "Warn: Get-ListOfUsers-MultiDomain called with a null map; nothing to query." $true
            return $results
        }

        foreach ($domain in @($DomainOUsMap.PSObject.Properties.Name)) {
            $OUs = @($DomainOUsMap.$domain)
            foreach ($ou in $OUs) {
                if ([string]::IsNullOrWhiteSpace($ou)) { continue }

                Write-Log "Info: querying domain '$domain' OU '$ou' (SmartcardLogonRequired=$SC)" $true
                Try {
                    if ($SC -eq $true -or $SC -eq $false) {
                        $OUQuery1 = Get-ADUser -Server $domain -Filter {SmartcardLogonRequired -eq $SC} `
                            -Properties SamAccountName, UserPrincipalName, smartcardlogonrequired, DisplayName, Office, Enabled, Lockedout, pwdLastSet, AccountExpirationDate, WhenCreated, Description `
                            -SearchBase $ou `
                            -SearchScope Subtree `
                            -ErrorAction Stop
                    } else {
                        $OUQuery1 = Get-ADUser -Server $domain -Filter * `
                            -Properties SamAccountName, UserPrincipalName, smartcardlogonrequired, DisplayName, Office, Enabled, Lockedout, pwdLastSet, AccountExpirationDate, WhenCreated, Description `
                            -SearchBase $ou `
                            -SearchScope Subtree `
                            -ErrorAction Stop
                    }

                    # Tag every account with where it came from. The report is
                    # sectioned BY DOMAIN, and an ADUser object carries no indication
                    # of which server answered the query - UPN suffix is a convention,
                    # not a guarantee, and says nothing about which OU matched.
                    $found = @($OUQuery1 | ForEach-Object {
                        $_ | Add-Member -NotePropertyName 'SourceDomain' -NotePropertyValue $domain -Force -PassThru |
                             Add-Member -NotePropertyName 'SourceOU'     -NotePropertyValue $ou     -Force -PassThru
                    })
                    Write-Log "Info: found $($found.Count) account(s) in '$ou' ($domain)" $true
                    $results += $found

                } Catch {
                    # Per-OU isolation: one unreachable domain or bad OU DN must not
                    # abort the sweep, but it MUST be visible - an OU silently missing
                    # from a compliance report is indistinguishable from an OU with no
                    # non-compliant accounts.
                    #
                    # Recorded on $Global:QueryFailures as well as logged, so the
                    # emailed report can carry a "could not be read" section. Only the
                    # report reaches the people who act on it.
                    # S-20: capture the exception TYPE as well as the message and
                    # classify the failure, so the report can say what kind of problem
                    # this is and who fixes it. ExceptionType is recorded verbatim so
                    # the real type names can be OBSERVED during lab validation rather
                    # than guessed at (see Get-ADFailureCategory).
                    $exType = ''
                    try { $exType = $_.Exception.GetType().Name } catch { $exType = '' }
                    $exMsg  = $_.Exception.Message
                    $cls    = Get-ADFailureCategory -ExceptionType $exType -Message $exMsg

                    Write-Log "Error: query failed for domain '$domain' OU '$ou' [$($cls.Category)] - this OU is MISSING from the report: $exMsg" $true
                    $Global:QueryFailures += [PSCustomObject]@{
                        Domain        = $domain
                        OU            = $ou
                        Category      = $cls.Category
                        Reason        = $exMsg
                        Guidance      = $cls.Guidance
                        ExceptionType = $exType
                    }
                }
            }
        }

        return $results
    }
}       # Get-ListOfUsers-MultiDomain

function Get-ListOfServers{
    [CmdletBinding()]
    param( 
        [parameter (Mandatory = $true)]
        [string]$SecurityGroup,

        [parameter (Mandatory = $false)]
        [string]$DomainName
    )   
    process{
        if([string]::IsNullOrEmpty($DomainName)){
            $OUQuery1 = Get-ADGroupMember "$($SecurityGroup)" # | ForEach-Object { $OUQuery1 = ($_.Name)}
            $OUQuery1
        }else{
            $OUQuery1 = Get-ADGroupMember "$($SecurityGroup)" -Server $DomainName # | ForEach-Object { $OUQuery1 = ($_.Name)}
            $OUQuery1
        }


    }

}

function Get-ListOfServers-ByCN {
    [CmdletBinding()]
    param(
        [parameter(Mandatory = $true)]
        [string]$SG_CN,       # Group identity - a distinguishedName (DN) is preferred/unambiguous
        [parameter (Mandatory = $false)]
        [string]$DomainName
    )
    process {
        # Group membership resolution. -Identity accepts a distinguishedName
        # (the preferred, unambiguous identifier), CN, sAMAccountName, GUID or SID.
        # -ErrorAction Stop makes a group-level failure (group not found, domain
        # unreachable) terminating: with no members resolvable, EVERY move would
        # fail, so the run should stop and be reported as failed rather than be
        # masked as "0 servers / no action".
        $members = Get-ADGroupMember -Identity "$($SG_CN)" -Server $DomainName -Recursive -ErrorAction Stop |
            Where-Object { $_.objectClass -eq 'computer' }

        $result = @()
        foreach ($m in $members) {
            # Per-object isolation: a single computer object that cannot be
            # resolved must not abort resolution of the rest of the group.
            Try {
                $comp = Get-ADComputer -Identity $m.distinguishedName -Server $DomainName -Properties Enabled -ErrorAction Stop
                if ($comp.Enabled -eq $true) {
                    $result += $comp
                } else {
                    # Disabled/decommissioned accounts are explicitly skipped and logged.
                    Write-Log "Info: skipping disabled computer object $($comp.Name)" $true
                }
            } Catch {
                Write-Log "Warn: could not resolve computer object '$($m.distinguishedName)' - skipped: $($_.Exception.Message)" $true
            }
        }

        return $result
    }
}

function Get-ListOfServers-Direct {
    # S-7: Direct (NON-RECURSIVE) computer-member resolution for Invoke-ServerReboot.
    #
    # NON-RECURSIVE BY DESIGN - read before changing:
    #   - Get-ADGroupMember is called WITHOUT -Recursive, so only TOP-LEVEL
    #     (direct) members of the group are considered.
    #   - Only COMPUTER objects are returned. A nested SUB-GROUP that is a direct
    #     member is filtered out by the objectClass test and is NOT expanded; a
    #     user object is likewise ignored.
    #   - Disabled computer accounts are skipped and logged.
    #
    # This is deliberately different from Get-ListOfServers-ByCN (which IS
    # recursive). Rebooting a machine is destructive, so group membership must be
    # explicit: only what the operator put directly in the group is a target.
    #
    # Why a NEW function rather than changing Get-ListOfServers: that function is
    # also called by Get-ServerPendingRebootStatus, clean-ServerDisk,
    # move-archived-logs and tls-fix. Changing its return shape or filtering would
    # alter those actions' behaviour.
    [CmdletBinding()]
    param(
        [parameter(Mandatory = $true)]
        [string]$SecurityGroup,       # DN preferred (unambiguous); CN / sAMAccountName / GUID / SID also resolve

        [parameter(Mandatory = $false)]
        [string]$DomainName
    )
    process {
        # Group-level failure (group not found / domain unreachable) is a TOTAL
        # failure - with no members resolvable every reboot would be skipped, so
        # let it terminate rather than be masked as "0 servers / no action".
        $adParams = @{ Identity = "$($SecurityGroup)"; ErrorAction = 'Stop' }
        if (-not [string]::IsNullOrWhiteSpace($DomainName)) { $adParams['Server'] = $DomainName }

        $members = Get-ADGroupMember @adParams | Where-Object { $_.objectClass -eq 'computer' }

        $result = @()
        foreach ($m in $members) {
            # Per-object isolation: one unresolvable computer must not abort the group.
            Try {
                $compParams = @{ Identity = $m.distinguishedName; Properties = 'Enabled'; ErrorAction = 'Stop' }
                if (-not [string]::IsNullOrWhiteSpace($DomainName)) { $compParams['Server'] = $DomainName }
                $comp = Get-ADComputer @compParams
                if ($comp.Enabled -eq $true) {
                    $result += $comp
                } else {
                    Write-Log "Info: skipping disabled computer object $($comp.Name)" $true
                }
            } Catch {
                Write-Log "Warn: could not resolve computer object '$($m.distinguishedName)' - skipped: $($_.Exception.Message)" $true
            }
        }

        Write-Log "Info: group '$($SecurityGroup)' resolved to $(($result | Measure-Object).Count) enabled, direct computer member(s)." $true
        return $result
    }
}

function Get-RebootStatus{
    [CmdletBinding()]
    Param(
        [Parameter(Mandatory=$true)]
        [ValidateNotNullOrEmpty()]
        [string[]] $ComputerNames
    )
    process{

        Try {

            Foreach ($ComputerName in $ComputerNames) {
                [string]$Computer = [string]$ComputerName
                $usersession = Get-UserlogonSession $Computer| format-TABLE -HideTableHeaders | out-string
                $CrashOnAuditFail = ""
                Try {
                    $PendingReboot = $false

                    $ComputerlastBootUptime = Get-CimInstance -ComputerName $Computer -ClassName win32_operatingsystem | Select -ExpandProperty lastbootuptime 
                    $HKLM = [UInt32] "0x80000002"
                    $WMI_Reg = [WMIClass] "\\$Computer\root\default:StdRegProv" 

                    if ($WMI_Reg) {

                        $Key = "SYSTEM\CurrentControlSet\Control\Lsa"
                        $Value = "crashonauditfail"
                        $results = $WMI_Reg.GetDWORDValue($HKLM, $Key, $value)
                        if( $results.uValue -eq '2'){
                            #$CrashOnAuditFail = $($results.uValue)
                            $CrashOnAuditFail = 'YES'
                        }else{
                            $CrashOnAuditFail = 'NO'
                        }
                        
                        write-log "Info: crashonauditfail: $($results.uValue)" $true
                        write-log "Info: crashonauditfail: $($CrashOnAuditFail)" $true

                        if (($WMI_Reg.EnumKey($HKLM,"SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\")).sNames -contains 'RebootPending') {$PendingReboot = $true}
                        if (($WMI_Reg.EnumKey($HKLM,"SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\")).sNames -contains 'RebootRequired') {$PendingReboot = $true}
        
                        #Checking for SCCM namespace
                        $SCCM_Namespace = Get-WmiObject -Namespace ROOT\CCM\ClientSDK -List -ComputerName $Computer -ErrorAction Ignore
                        if ($SCCM_Namespace) {
                            if (([WmiClass]"\\$Computer\ROOT\CCM\ClientSDK:CCM_ClientUtilities").DetermineIfRebootPending().RebootPending -eq $true) {$PendingReboot = $true}
                        }

                        ## Testing
                        ##$PendingReboot = $true

                        [PSCustomObject]@{
                            ComputerName  = $Computer.ToUpper()
                            PendingReboot = $PendingReboot
                            ComputerlastBootUptime = $ComputerlastBootUptime
                            UserSession = $usersession
                            CrashOnAuditFail = $CrashOnAuditFail
                        }
                        if( $PendingReboot -eq $true ){
                            Write-Log "Info: $($Computer) Status: required reboot" $true
                        }elseif( $PendingReboot -eq $false ){
                            Write-Log "Info: $($Computer) Status: NO reboot require" $true
                        }
                            
                    }
                } catch {
                    Write-Log "Error: $_.Exception.Message" $true
                        [PSCustomObject]@{
                            ComputerName  = $Computer.ToUpper()
                            PendingReboot = "Error Accessing Server"
                            ComputerlastBootUptime = $ComputerlastBootUptime
                        }
        
                } finally {
                    Write-Log "Info: $Computer RequiredReboot:$($PendingReboot) LastBoot:$($ComputerlastBootUptime)"
                    $null = $WMI_Reg
                    $null = $SCCM_Namespace
                }
            }

        } catch {
            Write-Log "Error: $($_.Exception.Message)" $true
        }

    }

}

function Invoke-ServerReboot{
    [CmdletBinding()]
    Param(
        [Parameter(Mandatory=$true)]
        [ValidateNotNullOrEmpty()]
        [string] $ServerName,

        [Parameter(Mandatory=$false)]
        [ValidateNotNullOrEmpty()]
        [string] $ConsoleOut
    )
    process{

        Try {

            Write-log "Info: invoke server rebooting on $($ServerName)" $true
            #Restart-Computer -ComputerName $($ServerName)

            # S-9: capture shutdown.exe's exit code. shutdown.exe is a NATIVE
            # executable - when it fails (access denied, RPC unavailable, host
            # unreachable) it does NOT raise a PowerShell exception, so the
            # surrounding Try/Catch never fired and a failed reboot was reported
            # as a success. Redirect stderr into the output so the reason is
            # captured, then test $LASTEXITCODE explicitly.
            $shutdownOutput = & shutdown.exe /r /t 2 /c "VCF Orchestrator rebooting server to address pending reboot status on patching" /f /m "\\$($ServerName)" 2>&1
            if ($LASTEXITCODE -ne 0) {
                Write-Log "Error: $($ServerName) - shutdown command failed (exit code $LASTEXITCODE): $($shutdownOutput -join ' ')" $true
                return $false
            }

            Write-Log "Info: $($ServerName) - reboot command accepted" $true
            return $true

        } catch {
            Write-Log "Error: $($ServerName) - $($_.Exception.Message)" $true
            return $false
        }

    }

}

Function Wait-ServersBackOnline {
    # S-10: post-reboot verification pass.
    #
    # Runs ONCE, AFTER every reboot has been issued - not per-server inline.
    # Rationale: servers reboot concurrently in reality, so a single polling pass
    # bounds the whole verification to roughly one boot window (~VerifyTimeoutSec)
    # instead of N x VerifyTimeoutSec. A per-server blocking wait on a large group
    # would run for hours and exceed the WinRM/PSRP operation timeout of the
    # calling Orchestrator PowerShell plug-in session.
    #
    # Proof of reboot: poll win32_operatingsystem.LastBootUpTime and require it to
    # ADVANCE past the value captured before the reboot (Get-RebootStatus already
    # records it as ComputerlastBootUptime). This is stronger than a ping - it
    # proves the OS actually restarted AND is answering WMI again - and it works
    # identically for physical and virtual servers, which a VMware Tools check
    # could not.
    #
    # A server still up (pre-reboot boot time unchanged) simply stays in the
    # pending set until it goes down and returns, or until its own deadline.
    [CmdletBinding()]
    Param(
        [Parameter(Mandatory=$true)]
        [AllowEmptyCollection()]
        [array] $Targets,          # report objects: ComputerName, PreRebootLastBoot, RebootIssued, RebootIssuedAt

        [Parameter(Mandatory=$false)]
        [int] $TimeoutSec = 600,

        [Parameter(Mandatory=$false)]
        [int] $PollSec = 15
    )
    Process{
        $pending = @($Targets | Where-Object { $_.RebootIssued -eq $true })
        if ($pending.Count -eq 0) {
            Write-Log "Info: no successfully-issued reboots to verify." $true
            return
        }

        Write-Log "Info: verifying $($pending.Count) server(s) return online (timeout $($TimeoutSec)s per server, polling every $($PollSec)s)" $true

        while ($true) {
            $stillPending = @()

            foreach ($t in $pending) {
                $deadline = $t.RebootIssuedAt.AddSeconds($TimeoutSec)

                $newBoot = $null
                Try {
                    # Expected to fail while the server is down - that is a normal
                    # part of the cycle, not an error worth logging each poll.
                    $newBoot = Get-CimInstance -ComputerName $t.ComputerName -ClassName win32_operatingsystem -ErrorAction Stop |
                        Select-Object -ExpandProperty lastbootuptime
                } Catch {
                    $newBoot = $null
                }

                if ($newBoot -ne $null -and ($t.PreRebootLastBoot -eq $null -or $newBoot -gt $t.PreRebootLastBoot)) {
                    $t.BackOnline  = $true
                    $t.NewLastBoot = $newBoot
                    $t.DurationSec = [int]((Get-Date) - $t.RebootIssuedAt).TotalSeconds
                    $t.Status      = 'Rebooted'
                    $t.Detail      = "Back online; LastBootUpTime advanced to $newBoot"
                    Write-Log "Success: $($t.ComputerName) back online after $($t.DurationSec)s" $true
                }
                elseif ((Get-Date) -ge $deadline) {
                    $t.BackOnline  = $false
                    $t.DurationSec = [int]((Get-Date) - $t.RebootIssuedAt).TotalSeconds
                    $t.Status      = 'NotReturned'
                    $t.Detail      = "Did not return within $($TimeoutSec)s of the reboot being issued"
                    Write-Log "Error: $($t.ComputerName) did not return within $($TimeoutSec)s after reboot" $true
                }
                else {
                    $stillPending += $t
                }
            }

            $pending = $stillPending
            if ($pending.Count -eq 0) { break }
            Start-Sleep -Seconds $PollSec
        }

        Write-Log "Info: verification pass complete." $true
    }
}

function Get-UserlogonSession($Computer){
    $Session = ""
    Try{
        $Session = query user /server:$Computer 2>&1
        if($Session.count -gt 1){
            $querySession = $Session | ForEach-Object -Process{ $_ -replace '\s{2,}',','}
            $queryObject = $querySession | ConvertFrom-Csv | select-object -ExpandProperty username
            #Write-Log  "Info: $queryObject" $true
        }

    }catch{ }
    finally { $queryObject }
    
}

function SendMail {
	[cmdletBinding()]
	param (
		[Parameter(Mandatory=$False,
		           ValueFromPipeline=$True,
				   ValueFromPipelineByPropertyName=$True,
                   HelpMessage='Body message is NULL')]
		[string]$MailBody,
		[String]$MailSubject=$Global:MailSubject,
		[String]$MailAttachments

	)
    PROCESS{
	    Try
	    {

            # CC is OPTIONAL. $MailCc is derived from $MailCcString.split(','), which
            # yields @('') for an empty/blank string; passing that to
            # Send-MailMessage -Cc throws "argument is null or empty". Filter out
            # blank/whitespace entries and only include -Cc when a real recipient
            # remains, so a report can be sent with no CC at all. Attachments stay
            # optional the same way. All other behaviour is unchanged.
            $ccList = @($MailCc | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object { $_.Trim() })

            $mailParams = @{
                SmtpServer = $SMTPServer
                From       = $MailFrom
                To         = $MailTo
                Subject    = $MailSubject
                Body       = $MailBody
                BodyAsHtml = $true
            }
            if($ccList.Count -gt 0){ $mailParams['Cc'] = $ccList }
            if(-not [string]::IsNullOrEmpty($MailAttachments)){ $mailParams['Attachments'] = $MailAttachments }

            Write-Log "Info: smtpserver:$SMTPServer `nFrom:$MailFrom `nTo:$MailTo `nCc:$($ccList -join ',') `nSubject:$MailSubject `nBody:$MailBody"
            # $Global:MailSent lets a caller confirm the send actually succeeded (e.g.
            # to clean up a generated report file only AFTER it has been emailed).
            $Global:MailSent = $false
            Send-MailMessage @mailParams
            $Global:MailSent = $true
	    }
	    Catch
	    {
            $Global:MailSent = $false
            $ErrorMessage = $_.Exception.Message
            $FailedItem = $_.Exception.ItemName
            Write-Log "Error: $($ErrorMessage)" $true
	    }
    }
}

Function GenerateReport($data) { # GenerateReport
    [string]$body = $data
    $body = $body -replace 'False','<font color="red">False</font>'
    $body = $body -replace 'smartcardlogonrequired', 'SmartCardEnabled'
    $MailAttachments = $Global:UserLogFile
    $MailSubject = "Report: $($Global:UserName) - VMT Report $($Global:Today)"
    SendMail $body

}       # GenerateReport

function GenerateReportServerPendingRebootStatus($data){

    $Style = "<style>"
    $Style = $Style + "BODY{background-color:white;font-family:Segoe UI;font-size:12px}"
    $Style = $Style + "TABLE{border-width: 1px;border-style: solid;border-color: black;border-collapse: collapse;}"
    $Style = $Style + "TH{border-width: 1px;padding: 1px;border-style: solid;border-color: black;background-color:gray;color:white}"
    $Style = $Style + "TD{border-width: 1px;text-align: center;padding: 1px;border-style: solid;border-color: black;background-color:lightgrey}"
    $Style = $Style + "</style>"

    $HeaderNote = "<p> The list of servers were base on the security group called $($HeaderNotesSubstr). The script performed remote WMI registry call to the server to determine if reboot is required. The RPC server service on the remote server need to be available and accessible by the script or it will failed</p>"

    $data | ConvertTo-Html -Property ComputerName, PendingReboot, ComputerlastBootUptime, CrashOnAuditFail -Head $Header | Out-File -FilePath Report.html 
    [string]$body = $data | Sort-Object -Property ComputerName, PendingReboot, ComputerlastBootUptime, CrashOnAuditFail  | ConvertTo-Html -Property ComputerName, PendingReboot, ComputerlastBootUptime, UserSession, CrashOnAuditFail -Head $Style
    $body = $body -replace 'True','<font color="orange">Required Reboot</font>'
    $body = $body -replace 'ComputerlastBootUptime', 'lastBootUptime'
    $body = $body -replace 'Error Accessing Server','<font color="red">Error Accessing Server</font>'
    $body = $body -replace 'False','<font color="green">No Action required</font>'
    $body = $body -replace 'YES','<font color="red">YES</font>'
    $body = $HeaderNote + $body
    $reportFile = "$($Global:DebugDir)\ServerPendingRebootStatus_result.html"
    # Overwrite (NOT append): bounds this file to a single run's size so it cannot
    # accumulate and fill the PS host drive, even on report-only runs or if the
    # post-email cleanup below does not run.
    $body | out-File -FilePath $reportFile
    if($eMailReport -eq 'yes'){
        SendMail -MailBody $body
        # Clean up the generated HTML report from the PS host once the email has
        # ACTUALLY been sent (SendMail sets $Global:MailSent). If the send failed the
        # file is kept so the report is not lost. Removes both the appended result
        # file and the per-run Report.html written above.
        if($Global:MailSent -eq $true){
            foreach($rpt in @($reportFile, 'Report.html')){
                if(Test-Path -LiteralPath $rpt){
                    Try {
                        Remove-Item -LiteralPath $rpt -Force -ErrorAction Stop
                        Write-Log "Info: removed generated report file '$rpt' after email sent." $true
                    } Catch {
                        Write-Log "Warn: could not remove report file '$rpt': $($_.Exception.Message)" $true
                    }
                }
            }
        } else {
            Write-Log "Warn: email not confirmed sent; keeping generated report file '$reportFile'." $true
        }
    }
}

function GenerateReportServerReboot($data){
    # S-11: reporting for the Invoke-ServerReboot action.
    # This action previously produced NO report and sent NO mail - the only record
    # of a reboot run was the stdout transcript. Modelled on
    # GenerateReportServerPendingRebootStatus; gated by -eMailReport as usual.

    $Style = "<style>"
    $Style = $Style + "BODY{background-color:white;font-family:Segoe UI;font-size:12px}"
    $Style = $Style + "TABLE{border-width: 1px;border-style: solid;border-color: black;border-collapse: collapse;}"
    $Style = $Style + "TH{border-width: 1px;padding: 1px;border-style: solid;border-color: black;background-color:gray;color:white}"
    $Style = $Style + "TD{border-width: 1px;text-align: center;padding: 1px;border-style: solid;border-color: black;background-color:lightgrey}"
    $Style = $Style + "</style>"

    $HeaderNote = "<p>The list of servers was based on the direct (non-recursive) enabled computer members of the security group called $($HeaderNotesSubstr). " +
                  "The script performed a remote WMI/registry call to each server to determine whether a reboot was pending; " +
                  "<b>only servers reporting a pending reboot were rebooted</b>. Servers whose pending state could not be read were skipped and NOT rebooted. " +
                  "Each rebooted server was verified as returning to service by confirming its LastBootUpTime advanced past its pre-reboot value " +
                  "(timeout $($RebootIt_VerifyTimeoutSec)s per server). The RPC/WMI service on the remote server must be available and accessible or the server will be reported as an error.</p>"

    [string]$body = $data |
        Sort-Object -Property Status, ComputerName |
        ConvertTo-Html -Property ComputerName, PendingReboot, PreRebootLastBoot, RebootIssued, BackOnline, DurationSec, Status, Detail -Head $Style

    $body = $body -replace '<td>Rebooted</td>','<td><font color="green">Rebooted</font></td>'
    $body = $body -replace '<td>NotReturned</td>','<td><font color="red">Did NOT return</font></td>'
    $body = $body -replace '<td>RebootFailed</td>','<td><font color="red">Reboot FAILED</font></td>'
    $body = $body -replace '<td>Skipped-StatusUnknown</td>','<td><font color="red">Skipped - status unknown</font></td>'
    $body = $body -replace '<td>Skipped-NoRebootRequired</td>','<td><font color="green">Skipped - no reboot required</font></td>'
    $body = $body -replace 'PreRebootLastBoot', 'LastBootUpTime (before)'
    $body = $body -replace 'DurationSec', 'Return time (s)'
    $body = $HeaderNote + $body

    # The Debug folder is not guaranteed to exist on a freshly-staged PS host;
    # create it rather than letting Out-File throw and lose the report.
    Try {
        if ( !(Test-Path -PathType Container $Global:DebugDir) ) {
            New-Item -ItemType Directory -Path $Global:DebugDir -ErrorAction Stop | Out-Null
        }
        $body | out-File -append -FilePath "$($Global:DebugDir)\ServerReboot_result.html"
    } Catch {
        Write-Log "Warn: could not write report file to $($Global:DebugDir): $($_.Exception.Message)" $true
    }

    if($eMailReport -eq 'yes'){ SendMail -MailBody $body }
}

function GenerateReportPKI($data){
    # SUPERSEDED by GenerateReportPKI-v2 (S-16) and currently UNCALLED.
    # Get-AllAdmin-Accounts was its only caller and now uses the v2 report (which
    # adds the domain/OU footnote required for a multi-domain sweep, an account-state
    # column, and an overwrite-instead-of-append report file).
    # Retained, not deleted, as the reference for the single-domain report shape the
    # customer received before the transition - and because this is a shared toolbox
    # in which a future single-domain caller is plausible. Do not extend it; extend
    # GenerateReportPKI-v2.

    $Style = "<style>"
    $Style = $Style + "BODY{background-color:white;font-family:Segoe UI;font-size:12px}"
    $Style = $Style + "TABLE{border-width: 1px;border-style: solid;border-color: black;border-collapse: collapse;}"
    $Style = $Style + "TH{border-width: 1px;padding: 0px;border-style: solid;border-color: black;background-color:gray;color:white}"
    $Style = $Style + "TD{border-width: 1px;padding: 0px;border-style: solid;border-color: black;background-color:lightgrey}"
    $Style = $Style + "</style>"

    [string]$body = $data | Sort-Object -Property smartcardlogonrequired,SamAccountName  | ConvertTo-Html -Property SamAccountName, UserPrincipalName, smartcardlogonrequired, displayName, whenCreated, description -Head $Style
    $body = $body -replace 'False','<font color="red">False</font>'
    $body = $body -replace 'smartcardlogonrequired', 'SmartCardEnabled'
    $body = $body -replace 'whenCreated', 'CreatedOn'
    $body = $body -replace 'displayName', 'DisplayName'
    $body = $body -replace 'description', 'Description'
    $body | out-File -append -FilePath "$($Global:DebugDir)\PKI_result.html"
    if($eMailReport -eq 'yes'){ SendMail $body }

}

Function Format-HtmlTable { # S-16 helper: inline-style a ConvertTo-Html fragment
    # Outlook renders HTML with the WORD engine, which ignores most of a <style>
    # block. A report that looks right in a browser and unstyled in Outlook is worse
    # than no styling at all, so every table gets its styles INLINE on the elements.
    [CmdletBinding()]
    Param(
        # DELIBERATELY UNTYPED. ConvertTo-Html -Fragment emits Object[] (one element
        # per line), which will NOT bind to a [string] parameter - PowerShell raises
        # "Cannot convert value to type System.String". That error is NON-terminating,
        # so a typed parameter here caused every styled table to silently evaluate to
        # nothing: the report still sent, still looked well-formed, and had simply lost
        # its content. Accept whatever ConvertTo-Html produced and flatten it here.
        [Parameter(Mandatory=$false)]
        $Fragment,

        [Parameter(Mandatory=$false)]
        [string] $HeaderColour = '#44546A'
    )
    Process{
        $Fragment = @($Fragment) -join "`n"
        if ([string]::IsNullOrWhiteSpace($Fragment)) { return '' }
        $t = 'border-collapse:collapse;border:1px solid #B4B4B4;font-family:Segoe UI,Arial,sans-serif;font-size:12px;width:100%;'
        $h = "border:1px solid #B4B4B4;padding:5px 7px;background-color:$HeaderColour;color:#FFFFFF;text-align:left;font-weight:600;"
        $d = 'border:1px solid #B4B4B4;padding:4px 7px;background-color:#FFFFFF;vertical-align:top;'
        $out = $Fragment -replace '<table>', "<table style=`"$t`">"
        $out = $out -replace '<th>', "<th style=`"$h`">"
        $out = $out -replace '<td>', "<td style=`"$d`">"
        return $out
    }
}       # Format-HtmlTable

Function Get-ADFailureCategory {
    # S-20: classify a failed directory query so the REPORT can say what kind of
    # problem it is and who fixes it, instead of printing a raw exception string.
    #
    # Why this matters: "A referral was returned from the server" and "The server is
    # not operational" look equally opaque on a report, but they are entirely
    # different problems. A referral means the server ANSWERED and said "that naming
    # context is not mine" - a TARGETING problem, deterministic, fixed by correcting
    # the OU list, and it will fail identically on every run until someone does.
    # "Not operational" means the DC could not be contacted at all - an availability
    # problem that may well be gone by the next run. Retrying helps the second and
    # never helps the first.
    #
    # CLASSIFICATION IS BEST-EFFORT AND FAILS SAFE. It matches on the exception's
    # MESSAGE first-class, with the exception TYPE NAME as a corroborating hint.
    # Anything unrecognised returns 'Unclassified' and the raw message is still shown
    # in full - so a message we have not seen degrades to exactly today's behaviour
    # rather than being confidently mislabelled.
    #
    # NOTE ON TYPE NAMES: the ActiveDirectory module raises ADException subclasses.
    # 'ADServerDownException' and 'ADIdentityNotFoundException' are well established;
    # the referral-specific name is listed as a HINT only and costs nothing if it is
    # wrong, because the message patterns cover the same condition independently.
    # Confirm the real type names during lab validation - every failure record now
    # carries ExceptionType precisely so they can be observed rather than guessed.
    [CmdletBinding()]
    Param(
        [Parameter(Mandatory=$false)][string] $ExceptionType = '',
        [Parameter(Mandatory=$false)][string] $Message = ''
    )
    Process{
        $msg = ("$Message").ToLower()
        $typ = ("$ExceptionType").Trim()

        # Type-name hints. Checked first because a type match is stronger evidence
        # than a substring, but entirely optional - see the note above.
        $typeHints = @{
            'ADServerDownException'        = 'Unreachable'
            'ADIdentityNotFoundException'  = 'Scope error'
            'ADReferralException'          = 'Scope error'     # hint, unverified
            'UnauthorizedAccessException'  = 'Access denied'
        }

        # Message patterns, first match wins. Ordered most-specific first.
        $rules = @(
            @{ Category = 'Scope error'
               Patterns = @('referral','no such object','directory object not found',
                            'cannot find an object with identity','invalid dn syntax',
                            'the object does not exist','does not exist in the directory')
               Guidance = 'The OU distinguishedName is wrong, or does not exist in this domain. A referral means the server answered and said this naming context is not its own. Correct the OU list - retrying will not help.' }

            @{ Category = 'Access denied'
               Patterns = @('access is denied','insufficient access rights','insufficient rights',
                            'you do not have permission')
               Guidance = 'The account the PowerShell host runs as cannot read this OU. Grant it read access to the OU, then re-run.' }

            @{ Category = 'Authentication'
               Patterns = @('logon failure','the supplied credential','credentials are not valid',
                            'unknown user name or bad password','authentication failed')
               Guidance = 'The directory rejected the credentials. Check the PowerShell host service account (password, expiry, lockout) rather than the OU list.' }

            @{ Category = 'Unreachable'
               Patterns = @('server is not operational','unable to contact','cannot contact',
                            'the server is unavailable','rpc server is unavailable','timed out',
                            'timeout','no such host','network path was not found')
               Guidance = 'The domain controller could not be contacted. This is an availability problem, not an OU-list problem - it may clear on its own. Check DNS, network path and DC health.' }
        )

        $hinted = $null
        if ($typ -ne '' -and $typeHints.ContainsKey($typ)) { $hinted = $typeHints[$typ] }

        foreach ($r in $rules) {
            foreach ($p in $r.Patterns) {
                if ($msg -like "*$p*") {
                    return [PSCustomObject]@{ Category = $r.Category; Guidance = $r.Guidance }
                }
            }
        }

        # No message match - fall back to the type hint if there was one.
        if ($null -ne $hinted) {
            $g = @($rules | Where-Object { $_.Category -eq $hinted })
            return [PSCustomObject]@{
                Category = $hinted
                Guidance = if ($g.Count -gt 0) { $g[0].Guidance } else { '' }
            }
        }

        return [PSCustomObject]@{
            Category = 'Unclassified'
            Guidance = 'Not a failure pattern this report recognises. Read the message in the next column and the workflow transcript.'
        }
    }
}       # Get-ADFailureCategory

Function Remove-DuplicateAccounts {
    # S-19: collapse an account that was returned by MORE THAN ONE OU search down to a
    # single entry, so every account is counted and listed exactly once.
    #
    # WHY THIS IS NEEDED: all AD queries run at -SearchScope Subtree, which is FULLY
    # RECURSIVE - a search base returns every descendant at any depth, not just its
    # immediate children. If the supplied OU list contains an OU *and* one of its
    # descendants, the deeper accounts are returned by BOTH searches. Left alone that
    # inflates the account total, the non-compliance figure and the compliance rate.
    #
    # The recursive search is INHERITED BEHAVIOUR and is deliberately NOT changed -
    # the customer's OU list is built against a directory we cannot inspect, so
    # narrowing the scope could silently drop accounts that are in scope today. The
    # overlap is handled here instead, where it is safe.
    #
    # WHICH COPY IS KEPT: the one found via the DEEPEST (most specific) OU, measured
    # by the number of DN components. If an account is returned by both
    # "OU=Admin" and "OU=Servers,OU=Admin", the latter is the closer ancestor and is
    # the more informative place to report it. Ties fall back to first-seen order.
    #
    # IDEMPOTENT - running it on an already-deduplicated set is a no-op, so it is safe
    # to call from both the action and the report.
    #
    # Accepts BOTH object shapes in use: the raw query results (SourceDomain) and the
    # report's projected rows (Domain).
    [CmdletBinding()]
    Param(
        [Parameter(Mandatory=$false)]
        [AllowNull()]
        $Accounts
    )
    Process{
        $all = @($Accounts)
        if ($all.Count -eq 0) { return @() }

        $kept    = @()
        $dupInfo = @()

        $groups = $all | Group-Object {
            $d = if ($null -ne $_.SourceDomain) { $_.SourceDomain } else { $_.Domain }
            "$d|$($_.SamAccountName)".ToLower()
        }

        foreach ($g in $groups) {
            if ($g.Count -eq 1) { $kept += $g.Group[0]; continue }

            # Deepest DN first. Sort-Object is stable in PowerShell, so equal depths
            # keep their original (first-seen) order.
            $ordered = @($g.Group | Sort-Object -Property @{
                Expression = { @(("$($_.SourceOU)") -split ',').Count }; Descending = $true })
            $keep = $ordered[0]
            $kept += $keep

            $dupInfo += [PSCustomObject]@{
                Account       = $keep.SamAccountName
                Domain        = if ($null -ne $keep.SourceDomain) { $keep.SourceDomain } else { $keep.Domain }
                'Counted under' = $keep.SourceOU
                'Times returned' = $g.Count
                'Returned by these OUs' = (@($g.Group | ForEach-Object { $_.SourceOU } | Sort-Object -Unique) -join '  |  ')
            }
        }

        if ($dupInfo.Count -gt 0) {
            # ACCUMULATE, never overwrite - this may be called more than once per run
            # and the report reads the collected list to explain what it collapsed.
            $Global:DuplicateAccounts += $dupInfo
            # "Warn:" NOT "Error:" - deliberately. The figures are CORRECT after
            # deduplication, so this must not flip parseScriptOutput to success=false
            # and route the workflow to "Completed with Errors". It signals redundancy
            # in the OU list that the operator may want to tidy, not a broken report.
            Write-Log "Warn: $($dupInfo.Count) account(s) were returned by more than one OU search (the OU list contains an OU and one of its sub-OUs; searches are recursive). Each is counted ONCE, under the most specific OU. Totals are correct." $true
        }

        return $kept
    }
}       # Remove-DuplicateAccounts

Function Format-PKIAccountTable { # S-19 helper: one styled account table
    # Extracted so the domain-level and OU-level sections render IDENTICALLY - the
    # only difference between them is which rows are passed in.
    [CmdletBinding()]
    Param(
        [Parameter(Mandatory=$false)]
        [AllowNull()]
        $Rows
    )
    Process{
        $r = @($Rows)
        if ($r.Count -eq 0) { return '' }

        # Non-compliant first ('False' sorts before 'True'), then by name.
        $frag = Format-HtmlTable -Fragment (
            $r | Sort-Object SmartCardEnabled, DisplayName, SamAccountName |
            ConvertTo-Html -Fragment -Property DisplayName, SamAccountName, UserPrincipalName, SmartCardEnabled, AccountState, CreatedOn, Description
        )
        # 'False' only ever appears in SmartCardEnabled (account state renders as
        # Enabled/Disabled), so this highlight is unambiguous.
        $frag = $frag -replace '<td([^>]*)>False</td>',    '<td$1><font color="#C00000"><b>False</b></font></td>'
        $frag = $frag -replace '<td([^>]*)>Disabled</td>', '<td$1><font color="#808080">Disabled</font></td>'
        $frag = $frag -replace '<th([^>]*)>SmartCardEnabled</th>', '<th$1>Smart card enforced</th>'
        $frag = $frag -replace '<th([^>]*)>AccountState</th>',     '<th$1>Account state</th>'
        $frag = $frag -replace '<th([^>]*)>UserPrincipalName</th>','<th$1>UPN</th>'
        $frag = $frag -replace '<th([^>]*)>DisplayName</th>',      '<th$1>Name</th>'
        $frag = $frag -replace '<th([^>]*)>SamAccountName</th>',   '<th$1>Account</th>'
        $frag = $frag -replace '<th([^>]*)>CreatedOn</th>',        '<th$1>Created</th>'
        return $frag
    }
}       # Format-PKIAccountTable

Function ConvertFrom-ADFileTime { # S-22 helper: pwdLastSet -> DateTime, or $null
    # pwdLastSet is a Windows FILETIME (100ns ticks since 1601-01-01 UTC) held as an
    # Int64 on the AD object. It has TWO sentinel values that are NOT timestamps:
    #
    #   0                    - the password has NEVER been set, or the account is
    #                          flagged "user must change password at next logon".
    #   0x7FFFFFFFFFFFFFFF   - "never" (seen on accountExpires; guarded here too).
    #
    # THE DEFECT THIS FIXES (see Change Register S-22). The original report computed
    #   if($_.pwdLastSet -ne 0){ (New-TimeSpan ...).Days } else { 0 }
    # so a password that had NEVER BEEN SET was reported as a password age of ZERO -
    # rendered identically to a password changed this morning, and sorted to the very
    # bottom of a report sorted by age descending. For a service-account hygiene
    # report that inverts the meaning of the single most important column: the
    # accounts most in need of attention looked like the freshest ones.
    # It also called [datetime]::FromFileTime for display but FromFileTimeUTC for the
    # age arithmetic, so the two columns disagreed by the host's UTC offset.
    #
    # Returns $null for every non-timestamp case. Callers render $null as text
    # ("Never set"), which cannot be confused with a real age.
    [CmdletBinding()]
    Param(
        [Parameter(Mandatory=$false)]
        [AllowNull()]
        $FileTime
    )
    Process{
        if ($null -eq $FileTime) { return $null }

        $raw = 0
        # The property arrives as Int64 from Get-ADUser but as a string through a
        # serialisation boundary (and in the test fixtures), so parse defensively
        # rather than casting - a failed cast would be a terminating error here.
        if (-not [Int64]::TryParse(("$FileTime").Trim(), [ref]$raw)) { return $null }

        if ($raw -le 0 -or $raw -ge 0x7FFFFFFFFFFFFFFF) { return $null }

        # FromFileTime (NOT FromFileTimeUTC) returns LOCAL time, which is what
        # $Global:Today is. Both columns and the age arithmetic now use the same
        # basis. An out-of-range tick count throws, so guard that too.
        Try   { return [datetime]::FromFileTime($raw) }
        Catch { return $null }
    }
}       # ConvertFrom-ADFileTime

Function Get-AccountExpiryState { # S-22 helper: classify one account's expiry
    # Turns AccountExpirationDate into the state the report is organised around:
    #
    #   Expired        - the expiration date is in the past. The account can no longer
    #                    authenticate; if a service still depends on it, it is already
    #                    broken or about to be.
    #   Expiring       - expires within the look-ahead window (-ExpiringWithinDays).
    #                    This is the actionable set - the whole point of the report.
    #   Active         - has an expiration date, beyond the window.
    #   Never expires  - AccountExpirationDate is not set. This is the DEFAULT for most
    #                    accounts and is NOT a finding by itself; it is reported as its
    #                    own state rather than being lumped in with 'Active' so the
    #                    reader can see how much of the estate has no expiry at all.
    #
    # NOTHING IS FILTERED OUT by the window - it only decides which section an account
    # is listed under and whether it is counted in the subject line.
    [CmdletBinding()]
    Param(
        [Parameter(Mandatory=$false)]
        [AllowNull()]
        $ExpirationDate,

        [Parameter(Mandatory=$false)]
        [int] $WithinDays = 30,

        # Injectable for testing; defaults to the run's own clock.
        [Parameter(Mandatory=$false)]
        [AllowNull()]
        $Now = $null
    )
    Process{
        if ($null -eq $Now) {
            if ($null -ne $Global:Today) { $Now = $Global:Today } else { $Now = Get-Date }
        }

        $noExpiry = [PSCustomObject]@{ State = 'Never expires'; DaysToExpiry = $null; ExpiresOn = $null }

        if ($null -eq $ExpirationDate -or [string]::IsNullOrWhiteSpace("$ExpirationDate")) { return $noExpiry }

        $exp = $null
        Try   { $exp = [datetime]$ExpirationDate }
        Catch { return $noExpiry }

        # AD's "never" sentinels surface as extreme dates if they ever reach here
        # un-normalised. Treat them as no expiry rather than as an account that
        # expired in 1601 or expires in 9999 - either would be a fictitious finding.
        if ($exp.Year -le 1601 -or $exp.Year -ge 9999) { return $noExpiry }

        # WHOLE DAYS REMAINING, ROUNDED DOWN - which makes the window INCLUSIVE at its
        # edge: an account 29.6 days away reports 29 and IS flagged by a 29-day window.
        # That is the deliberate direction for a warning report - warn slightly early
        # rather than one scheduled run too late, by which point the account has
        # already expired. An account that has expired reports a NEGATIVE number, read
        # as days overdue.
        $days  = [int][math]::Floor(($exp - $Now).TotalDays)

        $state =
            if     ($exp -lt $Now)       { 'Expired'  }
            elseif ($days -le $WithinDays){ 'Expiring' }
            else                          { 'Active'   }

        return [PSCustomObject]@{ State = $state; DaysToExpiry = $days; ExpiresOn = $exp }
    }
}       # Get-AccountExpiryState

Function GenerateReportPKI-v2($data, $DomainOUsMap, $Failures, $Duplicates){
    # S-16: multi-domain PKI/smartcard compliance report, merged in from
    # cvs_functions-v2.ps1 and then RESTRUCTURED for a management audience.
    #
    # STRUCTURE (top to bottom - deliberately ordered by what a reader must not miss):
    #   1. Data-quality alert  - ONLY when something could not be read. Placed FIRST,
    #      above the numbers, because every figure below it is understated when an OU
    #      failed to return.
    #   2. Executive summary   - overall totals and a compliance rate.
    #   3. Per-domain summary  - one row per domain with a plain-language status.
    #   4. Per-domain detail   - a section per domain, non-compliant accounts first.
    #   5. Scope footnote      - exactly which domains and OUs were searched.
    #
    # WHY SECTIONED BY DOMAIN: the report spans 7 domains. A single merged table
    # forces the reader to infer the domain from the UPN suffix (a convention, not a
    # guarantee) and gives no per-domain totals, so it cannot answer "which domain is
    # worst?" - the actual management question. Accounts are tagged with SourceDomain
    # by Get-ListOfUsers-MultiDomain.
    #
    # WHY FAILURES ARE ON THE REPORT: a failed OU produces no rows, which reads
    # exactly like a fully-compliant OU. The people who act on this report read the
    # email, not the Orchestrator transcript, so an unread OU has to be visible here.
    # $Failures comes from $Global:QueryFailures.
    #
    # Sections are driven by the SCOPE MAP, not by the returned data, so a domain that
    # returned nothing still gets a section stating that - rather than vanishing and
    # being mistaken for "not in scope".
    #
    # OTHER CHANGES vs the v2 fork:
    #  - Booleans are PROJECTED to explicit text before ConvertTo-Html. The v2 report
    #    coloured red by blind string-replacing 'False' across the whole document,
    #    which would also have hit any second boolean column.
    #  - Added the ACCOUNT STATE column. The query already selects Enabled, but
    #    neither the v1 nor v2 report displayed it - so a DISABLED account with
    #    SmartcardLogonRequired=$false was counted in the headline "N Non-Compliance"
    #    figure with no way for the reader to tell. The COUNT IS DELIBERATELY
    #    UNCHANGED (confirmed decision - disabled accounts remain in scope and in the
    #    figure); this only makes the composition visible.
    #  - Styles are INLINE (see Format-HtmlTable) so the report survives Outlook.
    #  - Writes to the Debug folder, creating it if absent, and OVERWRITES rather than
    #    appends - the v1 report appended unboundedly across scheduled runs.

    $fail = @($Failures)
    # The sweep runs twice per OU (smartcard required = true, then false), so a dead
    # OU is recorded twice. Collapse to one row per Domain+OU for the report.
    $failUnique = @($fail | Group-Object Domain, OU | ForEach-Object { $_.Group[0] })

    # -- Project once; every section below is a filter over $rows ------------------
    # Defensive de-duplication (S-19). The action already does this before counting,
    # so this is normally a no-op - Remove-DuplicateAccounts is idempotent. It is
    # repeated here so that ANY caller of this function gets a report in which every
    # account is listed exactly once, rather than depending on the caller to have
    # remembered. If it does find anything, it accumulates onto $Global:DuplicateAccounts.
    $data = @(Remove-DuplicateAccounts -Accounts $data)
    if ($null -eq $Duplicates) { $Duplicates = $Global:DuplicateAccounts }

    # SourceOU MUST survive this projection: the per-OU sub-sections (S-19) group on
    # it. It is deliberately NOT one of the columns rendered in the account tables -
    # the OU is the sub-section heading, so repeating it on every row would be noise.
    $rows = @($data) | Select-Object -Property `
        @{Name='Domain';           Expression={ $_.SourceDomain }}, `
        @{Name='SourceOU';         Expression={ $_.SourceOU }}, `
        @{Name='DisplayName';      Expression={ $_.displayName }}, `
        @{Name='SamAccountName';   Expression={ $_.SamAccountName }}, `
        @{Name='UserPrincipalName';Expression={ $_.UserPrincipalName }}, `
        @{Name='SmartCardEnabled'; Expression={ if($_.smartcardlogonrequired -eq $true){'True'}else{'False'} }}, `
        @{Name='AccountState';     Expression={ if($_.Enabled -eq $true){'Enabled'}else{'Disabled'} }}, `
        @{Name='CreatedOn';        Expression={ if($_.whenCreated){ (Get-Date $_.whenCreated -Format 'yyyy-MM-dd') } else { '' } }}, `
        @{Name='Description';      Expression={ $_.description }}

    $totalAll  = @($rows).Count
    $totalOk   = @($rows | Where-Object { $_.SmartCardEnabled -eq 'True'  }).Count
    $totalBad  = @($rows | Where-Object { $_.SmartCardEnabled -eq 'False' }).Count
    $ratePct   = if ($totalAll -gt 0) { [math]::Round(($totalOk / $totalAll) * 100, 1) } else { 0 }

    $fnt   = 'font-family:Segoe UI,Arial,sans-serif;'
    $body  = "<div style=`"$fnt font-size:12px;color:#1F1F1F;`">"
    $body += "<h2 style=`"$fnt font-size:18px;margin:0 0 2px 0;`">Administrative Account Smart Card (PKI) Compliance Report</h2>"
    $body += "<p style=`"$fnt font-size:11px;color:#666666;margin:0 0 14px 0;`">Generated $((Get-Date).ToString('yyyy-MM-dd HH:mm')) &nbsp;|&nbsp; Source: $($env:COMPUTERNAME)</p>"

    # -- 1. Data-quality alert (only when something failed) -----------------------
    if ($failUnique.Count -gt 0) {
        $affected = @($failUnique | Select-Object -ExpandProperty Domain -Unique)

        # S-20: project with FALLBACKS. Failure records written before the classifier
        # existed (or by any other caller) carry no Category/Guidance; defaulting them
        # to 'Unclassified' keeps the table honest instead of rendering blank cells.
        $failRows = @($failUnique | Sort-Object Domain, OU | Select-Object -Property `
            @{Name='Problem';   Expression={ if ([string]::IsNullOrWhiteSpace($_.Category)) { 'Unclassified' } else { $_.Category } }}, `
            @{Name='Domain';    Expression={ $_.Domain }}, `
            @{Name='OU';        Expression={ $_.OU }}, `
            @{Name='Detail';    Expression={ $_.Reason }}, `
            @{Name='What to do';Expression={ if ([string]::IsNullOrWhiteSpace($_.Guidance)) { 'Read the detail and the workflow transcript.' } else { $_.Guidance } }})

        # Category breakdown for the summary sentence - tells the reader at a glance
        # whether this is one problem or several different ones.
        $byCat = @($failRows | Group-Object Problem | Sort-Object Name |
                   ForEach-Object { "$($_.Count) $($_.Name.ToLower())" })

        $body += "<div style=`"border:2px solid #C00000;background-color:#FDECEA;padding:10px 12px;margin:0 0 16px 0;`">"
        $body += "<p style=`"$fnt font-size:14px;font-weight:700;color:#C00000;margin:0 0 6px 0;`">&#9888; THIS REPORT IS INCOMPLETE</p>"
        $body += "<p style=`"$fnt font-size:12px;margin:0 0 8px 0;`">"
        $body += "$($failUnique.Count) organisational unit(s) across $($affected.Count) domain(s) could not be read"
        if ($byCat.Count -gt 0) { $body += " (" + ($byCat -join ', ') + ")" }
        $body += ". <b>Accounts in these OUs are NOT included in any figure below</b>, so the compliance counts are understated. "
        $body += "An OU that failed to return looks identical to an OU with no findings - treat the totals as a floor, not a total.</p>"

        $failFrag = Format-HtmlTable -HeaderColour '#C00000' -Fragment (
            $failRows | ConvertTo-Html -Fragment -Property Problem, Domain, OU, Detail, 'What to do'
        )
        # Colour the category cell by what kind of problem it is: a scope error is
        # someone's to fix now; an unreachable DC may already have cleared.
        $failFrag = $failFrag -replace '<td([^>]*)>Scope error</td>',   '<td$1><font color="#C00000"><b>Scope error</b></font></td>'
        $failFrag = $failFrag -replace '<td([^>]*)>Access denied</td>', '<td$1><font color="#C00000"><b>Access denied</b></font></td>'
        $failFrag = $failFrag -replace '<td([^>]*)>Authentication</td>','<td$1><font color="#C00000"><b>Authentication</b></font></td>'
        $failFrag = $failFrag -replace '<td([^>]*)>Unreachable</td>',   '<td$1><font color="#B26B00"><b>Unreachable</b></font></td>'
        $failFrag = $failFrag -replace '<td([^>]*)>Unclassified</td>',  '<td$1><font color="#666666">Unclassified</font></td>'
        $body += $failFrag
        $body += "</div>"
    }

    # -- 1B. Overlapping-scope notice (S-19) --------------------------------------
    # By the time we get here the account set has ALREADY been de-duplicated (the
    # action calls Remove-DuplicateAccounts before counting, and this function calls
    # it again defensively above). Every figure on this report is therefore correct
    # and counts each account exactly once.
    #
    # This notice is INFORMATIONAL, not an alarm: it explains that the OU list
    # contains redundant entries, so the operator can tidy it, and it accounts for why
    # an account appears under one OU rather than another. It is deliberately styled
    # and worded more quietly than the INCOMPLETE banner above, which reports figures
    # that genuinely cannot be trusted.
    $dupSeen = @($Duplicates)
    if ($dupSeen.Count -gt 0) {
        $body += "<div style=`"border:1px solid #B26B00;background-color:#FFF6E5;padding:10px 12px;margin:0 0 16px 0;`">"
        $body += "<p style=`"$fnt font-size:13px;font-weight:700;color:#8A5300;margin:0 0 6px 0;`">Note &#8212; overlapping OU list (totals are correct)</p>"
        $body += "<p style=`"$fnt font-size:12px;margin:0 0 8px 0;`">"
        $body += "$($dupSeen.Count) account(s) were returned by more than one of the OU searches, because the OU list contains "
        $body += "an OU <b>and</b> one of its sub-OUs and searches include all sub-OUs. "
        $body += "<b>Each account has been counted once</b> and is listed below under the most specific OU that returned it, so "
        $body += "the figures on this report are accurate. Removing the redundant entry from the OU list will make this notice "
        $body += "go away.</p>"
        $body += Format-HtmlTable -HeaderColour '#8A5300' -Fragment (
            $dupSeen | Sort-Object Domain, Account |
            ConvertTo-Html -Fragment -Property Account, Domain, 'Counted under', 'Times returned', 'Returned by these OUs'
        )
        $body += "</div>"
    }

    # -- 2. Executive summary ------------------------------------------------------
    $rateColour = if ($ratePct -ge 95) { '#107C10' } elseif ($ratePct -ge 80) { '#B26B00' } else { '#C00000' }
    $body += "<h3 style=`"$fnt font-size:15px;margin:0 0 6px 0;`">Summary</h3>"
    $body += "<table style=`"border-collapse:collapse;$fnt font-size:12px;margin:0 0 18px 0;`"><tr>"
    $body += "<td style=`"border:1px solid #B4B4B4;padding:8px 16px;background-color:#F2F2F2;`">Accounts in scope<br><b style=`"font-size:20px;`">$totalAll</b></td>"
    $body += "<td style=`"border:1px solid #B4B4B4;padding:8px 16px;background-color:#F2F2F2;`">Smart card enforced<br><b style=`"font-size:20px;color:#107C10;`">$totalOk</b></td>"
    $body += "<td style=`"border:1px solid #B4B4B4;padding:8px 16px;background-color:#F2F2F2;`">NOT enforced<br><b style=`"font-size:20px;color:#C00000;`">$totalBad</b></td>"
    $body += "<td style=`"border:1px solid #B4B4B4;padding:8px 16px;background-color:#F2F2F2;`">Compliance rate<br><b style=`"font-size:20px;color:$rateColour;`">$ratePct%</b></td>"
    $body += "</tr></table>"

    # -- 3. Per-domain summary -----------------------------------------------------
    # Driven from the scope map so an empty or fully-failed domain still appears.
    $domainList = if ($null -eq $DomainOUsMap) {
        @($rows | Select-Object -ExpandProperty Domain -Unique | Where-Object { $_ })
    } else {
        @($DomainOUsMap.PSObject.Properties.Name)
    }

    $summaryRows = @()
    foreach ($dom in $domainList) {
        $dRows = @($rows | Where-Object { $_.Domain -eq $dom })
        $dOk   = @($dRows | Where-Object { $_.SmartCardEnabled -eq 'True'  }).Count
        $dBad  = @($dRows | Where-Object { $_.SmartCardEnabled -eq 'False' }).Count
        $dFail = @($failUnique | Where-Object { $_.Domain -eq $dom }).Count

        $status =
            if     ($dFail -gt 0)      { 'INCOMPLETE - see alert above' }
            elseif ($dRows.Count -eq 0){ 'No accounts found' }
            elseif ($dBad -gt 0)       { 'Action required' }
            else                       { 'Fully compliant' }

        $summaryRows += [PSCustomObject]@{
            Domain          = $dom
            Accounts        = $dRows.Count
            'Enforced'      = $dOk
            'Not enforced'  = $dBad
            'Compliance %'  = if ($dRows.Count -gt 0) { [math]::Round(($dOk / $dRows.Count) * 100, 1) } else { 'n/a' }
            'OUs unread'    = $dFail
            Status          = $status
        }
    }

    $body += "<h3 style=`"$fnt font-size:15px;margin:0 0 6px 0;`">By domain</h3>"
    $summaryHtml = Format-HtmlTable -Fragment (
        $summaryRows | ConvertTo-Html -Fragment -Property Domain, Accounts, 'Enforced', 'Not enforced', 'Compliance %', 'OUs unread', Status
    )
    $summaryHtml = $summaryHtml -replace '<td([^>]*)>Fully compliant</td>',            '<td$1><font color="#107C10"><b>Fully compliant</b></font></td>'
    $summaryHtml = $summaryHtml -replace '<td([^>]*)>Action required</td>',            '<td$1><font color="#B26B00"><b>Action required</b></font></td>'
    $summaryHtml = $summaryHtml -replace '<td([^>]*)>INCOMPLETE - see alert above</td>','<td$1><font color="#C00000"><b>INCOMPLETE &#8212; see alert above</b></font></td>'
    $summaryHtml = $summaryHtml -replace '<td([^>]*)>No accounts found</td>',          '<td$1><font color="#666666">No accounts found</font></td>'
    $body += $summaryHtml
    $body += "<p style=`"$fnt font-size:11px;color:#666666;margin:4px 0 20px 0;`">&quot;Not enforced&quot; = the account does not require a smart card to log on. Disabled accounts are included in these figures; the Account state column in each section below identifies them.</p>"

    # -- 4. Per-domain detail ------------------------------------------------------
    $body += "<h3 style=`"$fnt font-size:15px;margin:0 0 10px 0;`">Account detail by domain</h3>"

    foreach ($dom in $domainList) {
        $dRows = @($rows | Where-Object { $_.Domain -eq $dom })
        $dBad  = @($dRows | Where-Object { $_.SmartCardEnabled -eq 'False' }).Count
        $dFailRows = @($failUnique | Where-Object { $_.Domain -eq $dom })

        $body += "<div style=`"margin:0 0 22px 0;`">"
        $body += "<h4 style=`"$fnt font-size:13px;background-color:#44546A;color:#FFFFFF;padding:6px 9px;margin:0 0 6px 0;`">$dom</h4>"

        if ($dFailRows.Count -gt 0) {
            $body += "<p style=`"$fnt font-size:12px;color:#C00000;margin:0 0 6px 0;`">"
            $body += "&#9888; $($dFailRows.Count) OU(s) in this domain could not be read - the accounts below are a PARTIAL list:</p><ul style=`"$fnt font-size:11px;color:#C00000;margin:0 0 8px 0;`">"
            foreach ($fr in $dFailRows) { $body += "<li>$($fr.OU) &#8212; $($fr.Reason)</li>" }
            $body += "</ul>"
        }

        # -- S-19: sub-section BY OU when the domain has more than one ------------
        # The OU list comes from the SCOPE MAP (so an OU that returned nothing still
        # gets a heading saying so), in the order the operator supplied it. Any
        # SourceOU seen in the data but absent from the map is appended defensively -
        # it should not happen, and silently dropping those accounts would understate
        # the report.
        $ouList = @()
        if ($null -ne $DomainOUsMap) {
            foreach ($p in @($DomainOUsMap.PSObject.Properties.Name)) {
                if ($p -eq $dom) { $ouList = @(@($DomainOUsMap.$p) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) }
            }
        }
        foreach ($sr in $dRows) {
            if (-not [string]::IsNullOrWhiteSpace($sr.SourceOU) -and ($ouList -notcontains $sr.SourceOU)) {
                $ouList += $sr.SourceOU
            }
        }

        if ($dRows.Count -eq 0 -and $ouList.Count -le 1) {
            $body += "<p style=`"$fnt font-size:12px;color:#666666;margin:0;`"><i>No accounts were returned from the OUs queried in this domain.</i></p>"
        }
        elseif ($ouList.Count -le 1) {
            # Single OU in this domain - a sub-heading would just repeat the scope
            # footnote, so render one table as before.
            $body += "<p style=`"$fnt font-size:11px;color:#666666;margin:0 0 5px 0;`">$($dRows.Count) account(s), $dBad not enforcing smart card logon.</p>"
            $body += Format-PKIAccountTable -Rows $dRows
        }
        else {
            $body += "<p style=`"$fnt font-size:11px;color:#666666;margin:0 0 9px 0;`">$($dRows.Count) account(s) across $($ouList.Count) OUs, $dBad not enforcing smart card logon.</p>"

            foreach ($ou in $ouList) {
                $oRows = @($dRows | Where-Object { $_.SourceOU -eq $ou })
                $oBad  = @($oRows | Where-Object { $_.SmartCardEnabled -eq 'False' }).Count
                $ouDead = @($failUnique | Where-Object { $_.Domain -eq $dom -and $_.OU -eq $ou })

                $body += "<div style=`"margin:0 0 14px 18px;border-left:3px solid #C9D2E0;padding-left:12px;`">"
                $body += "<p style=`"$fnt font-size:12px;font-weight:650;margin:0 0 3px 0;color:#44546A;word-break:break-all;`">$ou</p>"

                if ($ouDead.Count -gt 0) {
                    $ouCat = if ([string]::IsNullOrWhiteSpace($ouDead[0].Category)) { '' } else { "<b>$($ouDead[0].Category)</b> &#8212; " }
                    $body += "<p style=`"$fnt font-size:11px;color:#C00000;margin:0;`">&#9888; This OU could not be read: $ouCat$($ouDead[0].Reason). Its accounts are absent from this report.</p>"
                } elseif ($oRows.Count -eq 0) {
                    $body += "<p style=`"$fnt font-size:11px;color:#666666;margin:0;`"><i>No accounts found in this OU.</i></p>"
                } else {
                    $body += "<p style=`"$fnt font-size:11px;color:#666666;margin:0 0 5px 0;`">$($oRows.Count) account(s), $oBad not enforcing smart card logon.</p>"
                    $body += Format-PKIAccountTable -Rows $oRows
                }
                $body += "</div>"
            }
        }
        $body += "</div>"
    }

    # -- 5. Scope footnote ---------------------------------------------------------
    $body += "<hr style=`"border:none;border-top:1px solid #B4B4B4;margin:20px 0 10px 0;`">"
    $body += "<p style=`"$fnt font-size:12px;font-weight:700;margin:0 0 4px 0;`">Scope - OUs queried</p>"
    if ($null -eq $DomainOUsMap) {
        $body += "<p style=`"$fnt font-size:12px;color:#C00000;margin:0;`">No domain/OU map was available - report scope unknown.</p>"
    } else {
        $body += "<ul style=`"$fnt font-size:11px;margin:0 0 8px 0;`">"
        foreach ($domain in @($DomainOUsMap.PSObject.Properties.Name)) {
            $body += "<li><b>$domain</b><ul>"
            foreach ($ou in @($DomainOUsMap.$domain)) {
                $isDead = @($failUnique | Where-Object { $_.Domain -eq $domain -and $_.OU -eq $ou }).Count -gt 0
                if ($isDead) { $body += "<li><font color=`"#C00000`">$ou &#8212; NOT READ</font></li>" }
                else         { $body += "<li>$ou</li>" }
            }
            $body += "</ul></li>"
        }
        $body += "</ul>"
    }
    $body += "<p style=`"$fnt font-size:11px;color:#666666;margin:0;`"><i>An OU listed as NOT READ could not be queried; its accounts are absent from this report. Automated report - do not reply.</i></p>"
    $body += "</div>"

    # Persist a copy on the PS host. Non-fatal: a report that cannot be written to
    # disk must still be emailed.
    Try {
        if ( !(Test-Path -PathType Container $Global:DebugDir) ) {
            New-Item -ItemType Directory -Path $Global:DebugDir -ErrorAction Stop | Out-Null
        }
        $body | out-File -FilePath "$($Global:DebugDir)\PKI_result.html" -ErrorAction Stop
    } Catch {
        Write-Log "Warn: could not write PKI report to $($Global:DebugDir): $($_.Exception.Message)" $true
    }

    if($eMailReport -eq 'yes'){ SendMail -MailBody $body }
}       # GenerateReportPKI-v2

Function Sort-ServiceAccountRows { # S-23 helper: one ordering, used by every section
    # WORST FIRST, on every table, so a reader who stops after the first few rows has
    # seen the accounts that matter most:
    #   1. Expiry state - Expired, then Expiring, then Active, then Never expires.
    #   2. Within a state, soonest to expire first.
    #   3. Then OLDEST PASSWORD first, which is how the v1 report was sorted (descending
    #      password age) and is the customer's existing habit. "Never set" sorts to the
    #      TOP of that group - v1 gave it an age of 0 and buried it at the bottom.
    #
    # Sorting is on the NUMERIC fields, never their display strings: "9" sorts after
    # "80" as text, and "Never set" would land wherever the alphabet put it.
    [CmdletBinding()]
    Param(
        [Parameter(Mandatory=$false)]
        [AllowNull()]
        $Rows
    )
    Process{
        $r = @($Rows)
        if ($r.Count -eq 0) { return @() }
        return @($r | Sort-Object `
            @{Expression = { switch ("$($_.ExpiryState)") { 'Expired' {0} 'Expiring' {1} 'Active' {2} default {3} } }}, `
            @{Expression = { if ($null -eq $_.DaysToExpiry) { [int]::MaxValue } else { [int]$_.DaysToExpiry } }}, `
            @{Expression = { if ($null -eq $_.PWAgeDays)    { [int]::MaxValue } else { [int]$_.PWAgeDays    } }; Descending = $true }, `
            SamAccountName)
    }
}       # Sort-ServiceAccountRows

Function Get-ServiceAccountSectionNote { # S-23 helper: the one-line note above a table
    # Every section carries its own composition so the reader never has to count rows
    # to find out whether the table below holds anything actionable.
    [CmdletBinding()]
    Param(
        [Parameter(Mandatory=$false)]
        [AllowNull()]
        $Rows,

        # Overrides the leading "N account(s)" - used by the multi-OU heading, which
        # needs to say "N account(s) across M OUs" without repeating the count.
        [Parameter(Mandatory=$false)]
        [string] $Prefix = ''
    )
    Process{
        $r = @($Rows)
        $e = @($r | Where-Object { $_.ExpiryState -eq 'Expired'       }).Count
        $g = @($r | Where-Object { $_.ExpiryState -eq 'Expiring'      }).Count
        $n = @($r | Where-Object { $_.ExpiryState -eq 'Never expires' }).Count

        $note = if ([string]::IsNullOrWhiteSpace($Prefix)) { "$($r.Count) account(s)" } else { $Prefix }

        $parts = @()
        if ($e -gt 0) { $parts += "$e expired" }
        if ($g -gt 0) { $parts += "$g expiring" }
        if ($n -gt 0) { $parts += "$n with no expiry date" }
        if ($parts.Count -gt 0) { $note += " &#8212; " + ($parts -join ', ') }

        return "$note."
    }
}       # Get-ServiceAccountSectionNote

Function Format-ServiceAccountTable { # S-23 helper: one styled service-account table
    # Extracted so the action sections at the top of the report and the per-domain /
    # per-OU inventory sections below it render IDENTICALLY - the only differences are
    # which rows are passed in and whether a Domain column is wanted. Mirrors
    # Format-PKIAccountTable (S-19), for the same reason: two hand-built tables drift.
    [CmdletBinding()]
    Param(
        [Parameter(Mandatory=$false)]
        [AllowNull()]
        $Rows,

        # The cross-domain action tables need a Domain column; the per-domain
        # inventory sections do not - there the domain is the heading.
        [Parameter(Mandatory=$false)]
        [bool] $IncludeDomain = $false,

        [Parameter(Mandatory=$false)]
        [string] $HeaderColour = '#44546A'
    )
    Process{
        $r = @($Rows)
        if ($r.Count -eq 0) { return '' }

        $cols = @('SamAccountName','DisplayName','Office','AccountState','ExpiresOn',
                  'DaysToExpiryText','ExpiryState','PWAgeText','PWLastSetText','Description')
        if ($IncludeDomain) { $cols = @('Domain') + $cols }

        $frag = Format-HtmlTable -HeaderColour $HeaderColour -Fragment (
            $r | ConvertTo-Html -Fragment -Property $cols
        )

        # Colour by WHOLE CELL VALUE, never by loose substring. The v1 report
        # string-replaced across the entire document, so any column - or a description
        # - containing the matched word was recoloured too. Anchoring on <td>...</td>
        # keeps this to the status cells. (A Description whose ENTIRE text is one of
        # these words would still match; that is a deliberate, bounded trade-off.)
        $frag = $frag -replace '<td([^>]*)>Expired</td>',       '<td$1><font color="#C00000"><b>Expired</b></font></td>'
        $frag = $frag -replace '<td([^>]*)>Expiring</td>',      '<td$1><font color="#B26B00"><b>Expiring</b></font></td>'
        $frag = $frag -replace '<td([^>]*)>Never expires</td>', '<td$1><font color="#666666">Never expires</font></td>'
        $frag = $frag -replace '<td([^>]*)>Disabled</td>',      '<td$1><font color="#808080">Disabled</font></td>'
        $frag = $frag -replace '<td([^>]*)>Locked out</td>',    '<td$1><font color="#C00000"><b>Locked out</b></font></td>'
        # "Never set" is the password column's version of a finding, not a formatting
        # quirk - it means the password has never been set or must be changed at next
        # logon. The v1 report showed it as an age of 0 (see ConvertFrom-ADFileTime).
        $frag = $frag -replace '<td([^>]*)>Never set</td>',     '<td$1><font color="#C00000"><b>Never set</b></font></td>'

        $frag = $frag -replace '<th([^>]*)>SamAccountName</th>',   '<th$1>Account</th>'
        $frag = $frag -replace '<th([^>]*)>DisplayName</th>',      '<th$1>Name</th>'
        $frag = $frag -replace '<th([^>]*)>AccountState</th>',     '<th$1>Account state</th>'
        $frag = $frag -replace '<th([^>]*)>ExpiresOn</th>',        '<th$1>Expires on</th>'
        $frag = $frag -replace '<th([^>]*)>DaysToExpiryText</th>', '<th$1>Days to expiry</th>'
        $frag = $frag -replace '<th([^>]*)>ExpiryState</th>',      '<th$1>Status</th>'
        $frag = $frag -replace '<th([^>]*)>PWAgeText</th>',        '<th$1>Password age (days)</th>'
        $frag = $frag -replace '<th([^>]*)>PWLastSetText</th>',    '<th$1>Password last set</th>'
        return $frag
    }
}       # Format-ServiceAccountTable

function GenerateReportServiceAccountExpiration($data, $DomainOUsMap, $Failures, $Duplicates, $WithinDays){
    # S-23: service-account expiration report, rebuilt for the same management
    # audience as the PKI report (S-17) and using the same helpers, so the two
    # deliverables look and behave like one product rather than two.
    #
    # WHAT THE V1 REPORT DID WRONG - all four are content defects, not cosmetics:
    #
    #  1. IT NEVER SHOWED AN EXPIRATION DATE. AccountExpirationDate was selected by
    #     the action and then omitted from the ConvertTo-Html -Property list, so the
    #     "Service Account Expiration Report" reported password age and nothing else.
    #     The line `$body -replace 'AccountExpirationDate','ExpirationDate'` right
    #     underneath had nothing to match and had presumably never worked.
    #  2. A password that had never been set was rendered as an age of 0 - see
    #     ConvertFrom-ADFileTime. The worst rows looked like the best ones.
    #  3. It APPENDED to ServiceAccountExpiration_result.html, so the file grew without
    #     bound across scheduled runs and every copy but the first was a concatenation
    #     of reports. It also assumed $Global:DebugDir already existed.
    #  4. It wrote the ENTIRE HTML BODY to the log with Write-Log "Info: $body", which
    #     goes to stdout - the stream the vRO workflow parses - and SendMail then
    #     logged the whole body a second time. A multi-kilobyte HTML blob in the
    #     transcript buries the Error:/Warn: lines that the run is classified on.
    #
    # STRUCTURE (ordered by what a reader must not miss):
    #   1. Data-quality alert   - only when an OU could not be read. FIRST, above the
    #                             numbers, because every figure below is understated.
    #   2. Overlapping-scope note - only when the OU list overlaps (S-19).
    #   3. Executive summary    - accounts in scope / expired / expiring / no expiry.
    #   4. ACTION REQUIRED      - the expired and expiring accounts, across all
    #                             domains, soonest first. This is the part of the
    #                             report anyone is expected to act on.
    #   5. By domain            - one summary row per domain.
    #   6. Full inventory       - every account, sectioned by domain and sub-sectioned
    #                             by OU exactly as the PKI report (S-19).
    #   7. Scope footnote       - exactly which OUs were searched, NOT READ flagged.
    #
    # The action tables are deliberately ABOVE the inventory and carry a Domain column:
    # an expiring account is acted on by whoever owns the service, and they should not
    # have to find it inside a per-domain table first. The inventory is retained in
    # full below because dropping it would turn an empty report into an ambiguous one.

    $fail       = @($Failures)
    # Unlike the PKI sweep (twice per OU, once per smartcard state) this action queries
    # each OU ONCE, so duplicate failure records are not expected. Collapsing anyway
    # costs nothing and keeps the two reports' failure handling identical.
    $failUnique = @($fail | Group-Object Domain, OU | ForEach-Object { $_.Group[0] })

    # TryParse rather than a [int] cast in a try/catch: a caught exception is still
    # recorded on $Error, which defeats the "did this run raise any non-terminating
    # error?" guard the regression suite relies on (the S-17 lesson). Parsed the same
    # way as the action case, so the two cannot disagree about what a window is.
    $win = 30
    $winParsed = 0
    if ($null -ne $WithinDays -and [int]::TryParse(("$WithinDays").Trim(), [ref]$winParsed) -and $winParsed -ge 0) {
        $win = $winParsed
    }

    # Defensive de-duplication (S-19). The action already did this before counting, so
    # this is normally a no-op - Remove-DuplicateAccounts is idempotent - but it means
    # ANY caller of this function gets a report in which each account appears once.
    $data = @(Remove-DuplicateAccounts -Accounts $data)
    if ($null -eq $Duplicates) { $Duplicates = $Global:DuplicateAccounts }

    # -- Project once; every section below is a filter over $rows ------------------
    # SourceOU MUST survive the projection - the per-OU sub-sections group on it.
    # Numeric sort keys (DaysToExpiry, PWAgeDays) are carried ALONGSIDE their display
    # strings: sorting on the display text would order "9" after "80" and put
    # "Never set" wherever the alphabet happened to place it.
    $rows = @($data) | ForEach-Object {
        $exp = Get-AccountExpiryState -ExpirationDate $_.AccountExpirationDate -WithinDays $win
        $pwSet = ConvertFrom-ADFileTime -FileTime $_.pwdLastSet
        $pwAge = $null
        if ($null -ne $pwSet) { $pwAge = [int][math]::Floor(((Get-Date) - $pwSet).TotalDays) }

        [PSCustomObject]@{
            Domain           = $_.SourceDomain
            SourceOU         = $_.SourceOU
            SamAccountName   = $_.SamAccountName
            DisplayName      = $_.DisplayName
            Office           = $_.Office
            AccountState     = if ($_.LockedOut -eq $true) { 'Locked out' } elseif ($_.Enabled -eq $true) { 'Enabled' } else { 'Disabled' }
            ExpiryState      = $exp.State
            DaysToExpiry     = $exp.DaysToExpiry
            DaysToExpiryText = if ($null -eq $exp.DaysToExpiry) { '' } else { "$($exp.DaysToExpiry)" }
            ExpiresOn        = if ($null -eq $exp.ExpiresOn) { '' } else { (Get-Date $exp.ExpiresOn -Format 'yyyy-MM-dd') }
            PWAgeDays        = $pwAge
            PWAgeText        = if ($null -eq $pwAge) { 'Never set' } else { "$pwAge" }
            PWLastSetText    = if ($null -eq $pwSet) { 'Never set' } else { (Get-Date $pwSet -Format 'yyyy-MM-dd') }
            CreatedOn        = if ($_.WhenCreated) { (Get-Date $_.WhenCreated -Format 'yyyy-MM-dd') } else { '' }
            Description      = $_.Description
        }
    }
    $rows = @($rows)

    $totalAll      = $rows.Count
    $expiredRows   = @($rows | Where-Object { $_.ExpiryState -eq 'Expired'  } | Sort-Object DaysToExpiry, SamAccountName)
    $expiringRows  = @($rows | Where-Object { $_.ExpiryState -eq 'Expiring' } | Sort-Object DaysToExpiry, SamAccountName)
    $noExpiryCount = @($rows | Where-Object { $_.ExpiryState -eq 'Never expires' }).Count

    $fnt   = 'font-family:Segoe UI,Arial,sans-serif;'
    $body  = "<div style=`"$fnt font-size:12px;color:#1F1F1F;`">"
    $body += "<h2 style=`"$fnt font-size:18px;margin:0 0 2px 0;`">Service Account Expiration Report</h2>"
    $body += "<p style=`"$fnt font-size:11px;color:#666666;margin:0 0 14px 0;`">Generated $((Get-Date).ToString('yyyy-MM-dd HH:mm')) &nbsp;|&nbsp; Source: $($env:COMPUTERNAME) &nbsp;|&nbsp; Look-ahead window: $win day(s)</p>"

    # -- 1. Data-quality alert (only when something failed) -----------------------
    # Identical in behaviour and wording to the PKI report (S-17/S-20): an OU that
    # could not be read produces no rows, which is indistinguishable from an OU whose
    # accounts are all healthy. The people who act on this read the email, not the
    # Orchestrator transcript.
    if ($failUnique.Count -gt 0) {
        $affected = @($failUnique | Select-Object -ExpandProperty Domain -Unique)

        $failRows = @($failUnique | Sort-Object Domain, OU | Select-Object -Property `
            @{Name='Problem';   Expression={ if ([string]::IsNullOrWhiteSpace($_.Category)) { 'Unclassified' } else { $_.Category } }}, `
            @{Name='Domain';    Expression={ $_.Domain }}, `
            @{Name='OU';        Expression={ $_.OU }}, `
            @{Name='Detail';    Expression={ $_.Reason }}, `
            @{Name='What to do';Expression={ if ([string]::IsNullOrWhiteSpace($_.Guidance)) { 'Read the detail and the workflow transcript.' } else { $_.Guidance } }})

        $byCat = @($failRows | Group-Object Problem | Sort-Object Name |
                   ForEach-Object { "$($_.Count) $($_.Name.ToLower())" })

        $body += "<div style=`"border:2px solid #C00000;background-color:#FDECEA;padding:10px 12px;margin:0 0 16px 0;`">"
        $body += "<p style=`"$fnt font-size:14px;font-weight:700;color:#C00000;margin:0 0 6px 0;`">&#9888; THIS REPORT IS INCOMPLETE</p>"
        $body += "<p style=`"$fnt font-size:12px;margin:0 0 8px 0;`">"
        $body += "$($failUnique.Count) organisational unit(s) across $($affected.Count) domain(s) could not be read"
        if ($byCat.Count -gt 0) { $body += " (" + ($byCat -join ', ') + ")" }
        $body += ". <b>Service accounts in these OUs are NOT included in any figure below</b>. "
        $body += "An account that is about to expire in an unread OU will not appear here and will not warn anyone before it stops working.</p>"

        $failFrag = Format-HtmlTable -HeaderColour '#C00000' -Fragment (
            $failRows | ConvertTo-Html -Fragment -Property Problem, Domain, OU, Detail, 'What to do'
        )
        $failFrag = $failFrag -replace '<td([^>]*)>Scope error</td>',   '<td$1><font color="#C00000"><b>Scope error</b></font></td>'
        $failFrag = $failFrag -replace '<td([^>]*)>Access denied</td>', '<td$1><font color="#C00000"><b>Access denied</b></font></td>'
        $failFrag = $failFrag -replace '<td([^>]*)>Authentication</td>','<td$1><font color="#C00000"><b>Authentication</b></font></td>'
        $failFrag = $failFrag -replace '<td([^>]*)>Unreachable</td>',   '<td$1><font color="#B26B00"><b>Unreachable</b></font></td>'
        $failFrag = $failFrag -replace '<td([^>]*)>Unclassified</td>',  '<td$1><font color="#666666">Unclassified</font></td>'
        $body += $failFrag
        $body += "</div>"
    }

    # -- 2. Overlapping-scope notice (S-19) ---------------------------------------
    $dupSeen = @($Duplicates)
    if ($dupSeen.Count -gt 0) {
        $body += "<div style=`"border:1px solid #B26B00;background-color:#FFF6E5;padding:10px 12px;margin:0 0 16px 0;`">"
        $body += "<p style=`"$fnt font-size:13px;font-weight:700;color:#8A5300;margin:0 0 6px 0;`">Note &#8212; overlapping OU list (totals are correct)</p>"
        $body += "<p style=`"$fnt font-size:12px;margin:0 0 8px 0;`">"
        $body += "$($dupSeen.Count) account(s) were returned by more than one of the OU searches, because the OU list contains "
        $body += "an OU <b>and</b> one of its sub-OUs and searches include all sub-OUs. "
        $body += "<b>Each account has been counted once</b> and is listed below under the most specific OU that returned it, so "
        $body += "the figures on this report are accurate. Removing the redundant entry from the OU list will make this notice go away.</p>"
        $body += Format-HtmlTable -HeaderColour '#8A5300' -Fragment (
            $dupSeen | Sort-Object Domain, Account |
            ConvertTo-Html -Fragment -Property Account, Domain, 'Counted under', 'Times returned', 'Returned by these OUs'
        )
        $body += "</div>"
    }

    # -- 3. Executive summary ------------------------------------------------------
    $expiredColour  = if ($expiredRows.Count  -gt 0) { '#C00000' } else { '#107C10' }
    $expiringColour = if ($expiringRows.Count -gt 0) { '#B26B00' } else { '#107C10' }
    $body += "<h3 style=`"$fnt font-size:15px;margin:0 0 6px 0;`">Summary</h3>"
    $body += "<table style=`"border-collapse:collapse;$fnt font-size:12px;margin:0 0 18px 0;`"><tr>"
    $body += "<td style=`"border:1px solid #B4B4B4;padding:8px 16px;background-color:#F2F2F2;`">Accounts in scope<br><b style=`"font-size:20px;`">$totalAll</b></td>"
    $body += "<td style=`"border:1px solid #B4B4B4;padding:8px 16px;background-color:#F2F2F2;`">Already expired<br><b style=`"font-size:20px;color:$expiredColour;`">$($expiredRows.Count)</b></td>"
    $body += "<td style=`"border:1px solid #B4B4B4;padding:8px 16px;background-color:#F2F2F2;`">Expiring within $win day(s)<br><b style=`"font-size:20px;color:$expiringColour;`">$($expiringRows.Count)</b></td>"
    $body += "<td style=`"border:1px solid #B4B4B4;padding:8px 16px;background-color:#F2F2F2;`">No expiry date set<br><b style=`"font-size:20px;color:#666666;`">$noExpiryCount</b></td>"
    $body += "</tr></table>"

    # -- 4. Action required --------------------------------------------------------
    $body += "<h3 style=`"$fnt font-size:15px;margin:0 0 6px 0;`">Action required</h3>"

    if ($expiredRows.Count -eq 0 -and $expiringRows.Count -eq 0) {
        $body += "<p style=`"$fnt font-size:12px;color:#107C10;margin:0 0 18px 0;`">"
        $body += "No account in scope has expired or expires within the next $win day(s)."
        if ($failUnique.Count -gt 0) { $body += " <b>Note the incomplete-scope warning above &#8212; this statement covers only the OUs that could be read.</b>" }
        $body += "</p>"
    }

    if ($expiredRows.Count -gt 0) {
        $body += "<h4 style=`"$fnt font-size:13px;background-color:#C00000;color:#FFFFFF;padding:6px 9px;margin:0 0 6px 0;`">Already expired &#8212; $($expiredRows.Count) account(s)</h4>"
        $body += "<p style=`"$fnt font-size:11px;color:#666666;margin:0 0 5px 0;`">These accounts are past their expiration date and can no longer authenticate. Anything still depending on them has already stopped working, or is about to. Most overdue first.</p>"
        $body += Format-ServiceAccountTable -Rows $expiredRows -IncludeDomain $true -HeaderColour '#C00000'
        $body += "<div style=`"height:14px;`"></div>"
    }

    if ($expiringRows.Count -gt 0) {
        $body += "<h4 style=`"$fnt font-size:13px;background-color:#B26B00;color:#FFFFFF;padding:6px 9px;margin:0 0 6px 0;`">Expiring within $win day(s) &#8212; $($expiringRows.Count) account(s)</h4>"
        $body += "<p style=`"$fnt font-size:11px;color:#666666;margin:0 0 5px 0;`">Soonest first. Renew or extend these before the date shown, or confirm the service they support has been retired.</p>"
        $body += Format-ServiceAccountTable -Rows $expiringRows -IncludeDomain $true -HeaderColour '#B26B00'
        $body += "<div style=`"height:14px;`"></div>"
    }

    # -- 5. Per-domain summary -----------------------------------------------------
    # Driven from the SCOPE MAP, not the returned data, so a domain that returned
    # nothing still gets a row saying so rather than vanishing and being mistaken for
    # "not in scope".
    $domainList = if ($null -eq $DomainOUsMap) {
        @($rows | Select-Object -ExpandProperty Domain -Unique | Where-Object { $_ })
    } else {
        @($DomainOUsMap.PSObject.Properties.Name)
    }

    $summaryRows = @()
    foreach ($dom in $domainList) {
        $dRows     = @($rows | Where-Object { $_.Domain -eq $dom })
        $dExpired  = @($dRows | Where-Object { $_.ExpiryState -eq 'Expired'  }).Count
        $dExpiring = @($dRows | Where-Object { $_.ExpiryState -eq 'Expiring' }).Count
        $dNone     = @($dRows | Where-Object { $_.ExpiryState -eq 'Never expires' }).Count
        $dFail     = @($failUnique | Where-Object { $_.Domain -eq $dom }).Count

        $status =
            if     ($dFail -gt 0)        { 'INCOMPLETE - see alert above' }
            elseif ($dRows.Count -eq 0)  { 'No accounts found' }
            elseif ($dExpired -gt 0)     { 'Action required' }
            elseif ($dExpiring -gt 0)    { 'Action soon' }
            else                         { 'No action' }

        $summaryRows += [PSCustomObject]@{
            Domain          = $dom
            Accounts        = $dRows.Count
            'Expired'       = $dExpired
            'Expiring'      = $dExpiring
            'No expiry set' = $dNone
            'OUs unread'    = $dFail
            Status          = $status
        }
    }

    $body += "<h3 style=`"$fnt font-size:15px;margin:0 0 6px 0;`">By domain</h3>"
    $summaryHtml = Format-HtmlTable -Fragment (
        $summaryRows | ConvertTo-Html -Fragment -Property Domain, Accounts, 'Expired', 'Expiring', 'No expiry set', 'OUs unread', Status
    )
    $summaryHtml = $summaryHtml -replace '<td([^>]*)>No action</td>',                   '<td$1><font color="#107C10"><b>No action</b></font></td>'
    $summaryHtml = $summaryHtml -replace '<td([^>]*)>Action soon</td>',                 '<td$1><font color="#B26B00"><b>Action soon</b></font></td>'
    $summaryHtml = $summaryHtml -replace '<td([^>]*)>Action required</td>',             '<td$1><font color="#C00000"><b>Action required</b></font></td>'
    $summaryHtml = $summaryHtml -replace '<td([^>]*)>INCOMPLETE - see alert above</td>','<td$1><font color="#C00000"><b>INCOMPLETE &#8212; see alert above</b></font></td>'
    $summaryHtml = $summaryHtml -replace '<td([^>]*)>No accounts found</td>',           '<td$1><font color="#666666">No accounts found</font></td>'
    $body += $summaryHtml
    $body += "<p style=`"$fnt font-size:11px;color:#666666;margin:4px 0 20px 0;`">&quot;No expiry set&quot; means the account has no expiration date at all. That is the Active Directory default and is not a finding by itself, but a service account that never expires also never prompts a review.</p>"

    # -- 6. Full inventory ---------------------------------------------------------
    $body += "<h3 style=`"$fnt font-size:15px;margin:0 0 10px 0;`">Full inventory by domain</h3>"

    foreach ($dom in $domainList) {
        $dRows     = @($rows | Where-Object { $_.Domain -eq $dom })
        $dFailRows = @($failUnique | Where-Object { $_.Domain -eq $dom })

        $body += "<div style=`"margin:0 0 22px 0;`">"
        $body += "<h4 style=`"$fnt font-size:13px;background-color:#44546A;color:#FFFFFF;padding:6px 9px;margin:0 0 6px 0;`">$dom</h4>"

        if ($dFailRows.Count -gt 0) {
            $body += "<p style=`"$fnt font-size:12px;color:#C00000;margin:0 0 6px 0;`">"
            $body += "&#9888; $($dFailRows.Count) OU(s) in this domain could not be read - the accounts below are a PARTIAL list:</p><ul style=`"$fnt font-size:11px;color:#C00000;margin:0 0 8px 0;`">"
            foreach ($fr in $dFailRows) { $body += "<li>$($fr.OU) &#8212; $($fr.Reason)</li>" }
            $body += "</ul>"
        }

        # OU list from the SCOPE MAP in the operator's own order, so an OU that
        # returned nothing still gets a heading saying so. Any SourceOU present in the
        # data but absent from the map is appended defensively - dropping those rows
        # would silently shorten the inventory.
        $ouList = @()
        if ($null -ne $DomainOUsMap) {
            foreach ($p in @($DomainOUsMap.PSObject.Properties.Name)) {
                if ($p -eq $dom) { $ouList = @(@($DomainOUsMap.$p) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) }
            }
        }
        foreach ($sr in $dRows) {
            if (-not [string]::IsNullOrWhiteSpace($sr.SourceOU) -and ($ouList -notcontains $sr.SourceOU)) {
                $ouList += $sr.SourceOU
            }
        }

        if ($dRows.Count -eq 0 -and $ouList.Count -le 1) {
            $body += "<p style=`"$fnt font-size:12px;color:#666666;margin:0;`"><i>No accounts were returned from the OUs queried in this domain.</i></p>"
        }
        elseif ($ouList.Count -le 1) {
            $body += "<p style=`"$fnt font-size:11px;color:#666666;margin:0 0 5px 0;`">$(Get-ServiceAccountSectionNote -Rows $dRows)</p>"
            $body += Format-ServiceAccountTable -Rows (Sort-ServiceAccountRows -Rows $dRows)
        }
        else {
            $body += "<p style=`"$fnt font-size:11px;color:#666666;margin:0 0 9px 0;`">$(Get-ServiceAccountSectionNote -Rows $dRows -Prefix "$($dRows.Count) account(s) across $($ouList.Count) OUs")</p>"

            foreach ($ou in $ouList) {
                $oRows  = @($dRows | Where-Object { $_.SourceOU -eq $ou })
                $ouDead = @($failUnique | Where-Object { $_.Domain -eq $dom -and $_.OU -eq $ou })

                $body += "<div style=`"margin:0 0 14px 18px;border-left:3px solid #C9D2E0;padding-left:12px;`">"
                $body += "<p style=`"$fnt font-size:12px;font-weight:650;margin:0 0 3px 0;color:#44546A;word-break:break-all;`">$ou</p>"

                if ($ouDead.Count -gt 0) {
                    $ouCat = if ([string]::IsNullOrWhiteSpace($ouDead[0].Category)) { '' } else { "<b>$($ouDead[0].Category)</b> &#8212; " }
                    $body += "<p style=`"$fnt font-size:11px;color:#C00000;margin:0;`">&#9888; This OU could not be read: $ouCat$($ouDead[0].Reason). Its accounts are absent from this report.</p>"
                } elseif ($oRows.Count -eq 0) {
                    $body += "<p style=`"$fnt font-size:11px;color:#666666;margin:0;`"><i>No accounts found in this OU.</i></p>"
                } else {
                    $body += "<p style=`"$fnt font-size:11px;color:#666666;margin:0 0 5px 0;`">$(Get-ServiceAccountSectionNote -Rows $oRows)</p>"
                    $body += Format-ServiceAccountTable -Rows (Sort-ServiceAccountRows -Rows $oRows)
                }
                $body += "</div>"
            }
        }
        $body += "</div>"
    }

    # -- 7. Scope footnote ---------------------------------------------------------
    $body += "<hr style=`"border:none;border-top:1px solid #B4B4B4;margin:20px 0 10px 0;`">"
    $body += "<p style=`"$fnt font-size:12px;font-weight:700;margin:0 0 4px 0;`">Scope - OUs queried</p>"
    if ($null -eq $DomainOUsMap) {
        $body += "<p style=`"$fnt font-size:12px;color:#C00000;margin:0;`">No domain/OU map was available - report scope unknown.</p>"
    } else {
        $body += "<ul style=`"$fnt font-size:11px;margin:0 0 8px 0;`">"
        foreach ($domain in @($DomainOUsMap.PSObject.Properties.Name)) {
            $body += "<li><b>$domain</b><ul>"
            foreach ($ou in @($DomainOUsMap.$domain)) {
                $isDead = @($failUnique | Where-Object { $_.Domain -eq $domain -and $_.OU -eq $ou }).Count -gt 0
                if ($isDead) { $body += "<li><font color=`"#C00000`">$ou &#8212; NOT READ</font></li>" }
                else         { $body += "<li>$ou</li>" }
            }
            $body += "</ul></li>"
        }
        $body += "</ul>"
    }
    $body += "<p style=`"$fnt font-size:11px;color:#666666;margin:0;`"><i>Searches include all sub-OUs. An OU listed as NOT READ could not be queried; its accounts are absent from this report. Automated report - do not reply.</i></p>"
    $body += "</div>"

    # Persist a copy on the PS host. Non-fatal: a report that cannot be written to
    # disk must still be emailed. OVERWRITES - the v1 report appended, so the file
    # grew without bound across scheduled runs.
    Try {
        if ( !(Test-Path -PathType Container $Global:DebugDir) ) {
            New-Item -ItemType Directory -Path $Global:DebugDir -ErrorAction Stop | Out-Null
        }
        $body | Out-File -FilePath "$($Global:DebugDir)\ServiceAccountExpiration_result.html" -ErrorAction Stop
    } Catch {
        Write-Log "Warn: could not write service account report to $($Global:DebugDir): $($_.Exception.Message)" $true
    }

    # A ONE-LINE summary, not the HTML. v1 logged the entire body here and SendMail
    # logged it again - a multi-kilobyte blob on stdout, which is the stream the vRO
    # workflow classifies, burying the Error:/Warn: lines that decide the end state.
    Write-Log "Info: service account report built - $totalAll account(s) in scope, $($expiredRows.Count) expired, $($expiringRows.Count) expiring within $win day(s), $noExpiryCount with no expiry date." $true

    if($eMailReport -eq 'yes'){ SendMail -MailBody $body }
}       # GenerateReportServiceAccountExpiration

function Main($Action){
    $scriptDir = Get-ScriptDirectory

    switch($Action){
        'Get-Users-SCenable'{
            $strModule = 'ActiveDirectory' 
            if (Invoke-Module $strModule){
                Get-ListOfUsers -DomainName $DomainName -SC $true | select SamAccountName, UserPrincipalName, smartcardlogonrequired
            }else{ 
                Write-Log "Error: Unable to import PS Modules $($strModule) or it is NOT install" $true 
            }
        }
        'Get-AllAdmin-Accounts'{
            # S-16: rewritten as the MULTI-DOMAIN report, merging in the capability
            # that previously existed only in the cvs_functions-v2.ps1 fork.
            #
            # WHAT CHANGED FOR CALLERS: this action no longer reads -DomainName and
            # -OUPath (one domain, one OU). It is driven by the domain -> OU-list map
            # supplied via -DomainOUs (inline JSON, the vRO path) or -DomainOUsFile
            # (a JSON file, the legacy Ansible path), and sweeps EVERY OU in EVERY
            # domain of that map. This matches what the customer runs today through
            # admin_accounts_report-v2.yml, which fed 7 domains x 2 OUs.
            #
            # HARDENED to the standard set by the other actions in this transition:
            #  - AD module guard now THROWS. Previously it logged an "Error:" line and
            #    fell through, so the run ended "Completed with Errors" having sent
            #    nothing - indistinguishable from a report with no findings. Without
            #    the module NOTHING can be queried, so this is a total failure and the
            #    vRO caller must route to its failure end state (matches S-14 /
            #    move-archived-logs-ByCN).
            #  - Zero-scope guard: an absent or empty domain/OU map stops the run
            #    instead of emailing an empty compliance report, which would read as
            #    "zero non-compliant accounts found".
            #  - Counts are taken with Measure-Object on forced arrays. The original
            #    incremented a global inside foreach; because $Global:PKIEnabledCount
            #    is only zeroed in InitializeVariables, that was also fragile to reuse.
            $strModule = 'ActiveDirectory'
            if (-not (Invoke-Module $strModule)) {
                Write-Log "Error: Unable to import PS Module $($strModule) or it is NOT installed. Cannot query accounts - aborting." $true
                throw "ActiveDirectory module not available on the PS host; cannot run Get-AllAdmin-Accounts."
            }

            # Build the domain -> OU map. A malformed map or an unreadable file throws
            # (see Resolve-DomainOUsMap) and terminates the run.
            $DomainOUsMap = Resolve-DomainOUsMap -Json $DomainOUs -Path $DomainOUsFile

            if ($null -eq $DomainOUsMap) {
                # S-21: NO LEGACY FALLBACK. There is exactly ONE way to scope this
                # action - the OU map - and no scope means the run FAILS.
                #
                # S-18 previously promoted a legacy `-DomainName` + `-OUPath` pair to a
                # one-entry map here. That was removed once it was confirmed that
                # Orchestrator uses a PowerShell host SEPARATE from the Ansible
                # templates in BOTH development and production, so no caller can reach
                # this action the legacy way.
                #
                # It was not merely dead - it was a SILENT ALTERNATE PATH. $DomainName
                # is a shared script parameter used by several other actions, so a
                # hand-run or a future caller that set -DomainName/-OUPath but forgot
                # -DomainOUs would have quietly produced a report covering ONE OU and
                # reported success, instead of failing and saying what was missing. For
                # a compliance report, silently narrowing the scope is the worst
                # available outcome - which is the same reasoning behind every other
                # guard in this action.
                #
                # NOTE (was): "-OUPath and -DomainName remain in the param block because
                # Get-ServiceAccountExpiration still uses them via Get-ListOfUsers."
                # THAT IS NO LONGER TRUE. S-22 moved Get-ServiceAccountExpiration onto
                # the same OU map, so -OUPath is now read by NO reachable action - see
                # the SUPERSEDED note on Get-ListOfUsers. -DomainName is still live for
                # the server-side actions (Get-ListOfServers*, the reboot actions).
                #
                # Fail rather than send: an empty or partial report is actively
                # misleading for a compliance deliverable.
                Write-Log "Error: Get-AllAdmin-Accounts - no scope supplied. Provide -DomainOUs (inline JSON) or -DomainOUsFile. No report produced." $true
                throw "Get-AllAdmin-Accounts requires a domain/OU map via -DomainOUs or -DomainOUsFile."
            }

            # SourceDomain / SourceOU are added by Get-ListOfUsers-MultiDomain and MUST
            # be carried through this projection - the report is sectioned by domain
            # and an ADUser object otherwise has no reliable indication of which
            # directory answered.
            $selectProps = 'SamAccountName','UserPrincipalName','smartcardlogonrequired','displayName','whenCreated','description','Enabled','SourceDomain','SourceOU'

            # Compliant: smartcard logon IS required.
            $Result  = @(Get-ListOfUsers-MultiDomain -DomainOUsMap $DomainOUsMap -SC $true |
                Select-Object $selectProps)

            # Non-compliant: smartcard logon is NOT required.
            $Result2 = @(Get-ListOfUsers-MultiDomain -DomainOUsMap $DomainOUsMap -SC $false |
                Select-Object $selectProps)

            # S-19: DEDUPLICATE BEFORE COUNTING.
            # Searches are recursive (SearchScope Subtree), so an OU list containing an
            # OU and one of its sub-OUs returns the deeper accounts twice. The counts
            # below feed the SUBJECT LINE, so this has to happen here and not only in
            # the report - otherwise the subject would advertise inflated figures that
            # disagree with the report body underneath it.
            $All = @(Remove-DuplicateAccounts -Accounts (@($Result) + @($Result2)))

            $Global:PKIEnabledCount  = @($All | Where-Object { $_.smartcardlogonrequired -eq $true }).Count
            $Global:PKIDisabledCount = @($All | Where-Object { $_.smartcardlogonrequired -ne $true }).Count

            # Visibility only - the headline counts above are UNCHANGED in meaning.
            # Disabled accounts are still included in the non-compliance figure exactly
            # as today; this line simply records how many of them there are so the
            # customer can decide whether that is the metric they want.
            $disabledNonCompliant = @($All | Where-Object { $_.smartcardlogonrequired -ne $true -and $_.Enabled -ne $true }).Count
            Write-Log "Info: Get-AllAdmin-Accounts - $($Global:PKIEnabledCount) compliant (smartcard required), $($Global:PKIDisabledCount) non-compliant (smartcard NOT required), of which $disabledNonCompliant are DISABLED accounts." $true

            # Flag an incomplete sweep in the SUBJECT LINE. A recipient triaging by
            # subject must not read "12 Non-Compliance" as a complete picture when
            # some OUs never returned. Failures are recorded twice (the sweep runs
            # once per smartcard state), so count distinct Domain+OU pairs.
            $failedOUs = @(@($Global:QueryFailures) | Group-Object Domain, OU).Count
            $subjectPrefix = if ($failedOUs -gt 0) { "[INCOMPLETE] " } else { "" }
            $Global:MailSubject = "$($subjectPrefix)$($MailSubjectstring) ( $Global:PKIDisabledCount Non-Compliance - $Global:PKIEnabledCount Compliance )"
            if ($failedOUs -gt 0) {
                Write-Log "Error: Get-AllAdmin-Accounts - $failedOUs OU(s) could not be queried; the compliance counts above are UNDERSTATED and the report is marked INCOMPLETE." $true
            }

            if ($All.Count -eq 0) {
                # Not an error: the scope was valid and was queried, it just held no
                # accounts. Logged as a Warn so it is obvious in the transcript, and
                # the (empty) report is still produced with its scope footnote so the
                # recipient can see exactly which OUs were searched.
                Write-Log "Warn: Get-AllAdmin-Accounts - the supplied OUs contain no user accounts. An empty report will be produced; check the scope footnote for the OUs actually queried." $true
            }

            GenerateReportPKI-v2 $All $DomainOUsMap $Global:QueryFailures $Global:DuplicateAccounts
        }
        'Get-ServiceAccountExpiration'{
            # S-22: rebuilt on the SAME multi-domain, per-OU-isolated sweep the admin
            # accounts report uses (Resolve-DomainOUsMap + Get-ListOfUsers-MultiDomain),
            # and hardened to the standard set by the other actions in this transition.
            #
            # WHAT CHANGED FOR CALLERS: this action no longer reads -DomainName and
            # -OUPath (one domain, one OU). It is driven by the domain -> OU-list map
            # supplied via -DomainOUs (inline JSON, the vRO path) or -DomainOUsFile
            # (a JSON file, the legacy Ansible path). Today's single OU is simply a map
            # with one entry, so the customer's existing scope is expressible unchanged.
            #
            # DEFECTS FIXED HERE (all four were silent - the run reported success):
            #
            #  1. SILENT SCOPE NARROWING. The old code called
            #       Get-ListOfUsers -DomainName $DomainName
            #     with NO -SC argument. Get-ListOfUsers declares [bool]$SC, so the
            #     unbound parameter BOUND TO $false rather than staying null, and its
            #     guard `if ($SC -eq $true -OR $SC -eq $false)` is ALWAYS TRUE - making
            #     the -Filter * branch underneath it unreachable dead code. Every run
            #     therefore queried `SmartcardLogonRequired -eq $false` and silently
            #     omitted every service account that DOES require a smart card. The
            #     multi-domain function takes $SC as an UNTYPED $null-defaulted
            #     parameter, so omitting it genuinely reaches -Filter * and returns
            #     every account in the OU, which is what this report always intended.
            #
            #  2. NO PER-OU ERROR HANDLING. Get-ADUser ran without -ErrorAction Stop
            #     inside no try/catch, so a bad OU DN or an unreachable DC raised a
            #     NON-TERMINATING error on the PS error stream - invisible to the vRO
            #     workflow, which classifies "Error:" lines on stdout. An empty report
            #     was emailed and the run reported success. Get-ListOfUsers-MultiDomain
            #     isolates and records each failure (S-16/S-20).
            #
            #  3. THE AD MODULE GUARD DID NOT FAIL THE RUN. A missing module logged an
            #     "Error:" line and fell through, sending nothing - indistinguishable
            #     from a report with no findings. Without the module NOTHING can be
            #     queried, so this is a total failure and must throw (matches S-14/S-16).
            #
            #  4. `$Result += $Result2` - $Result2 IS NEVER ASSIGNED in this case. It is
            #     copy-paste residue from the admin-accounts case, where it holds the
            #     second sweep. Appending an unset variable adds a $null element to the
            #     array, which ConvertTo-Html rendered as a blank row on every report.
            $strModule = 'ActiveDirectory'
            if (-not (Invoke-Module $strModule)) {
                Write-Log "Error: Unable to import PS Module $($strModule) or it is NOT installed. Cannot query accounts - aborting." $true
                throw "ActiveDirectory module not available on the PS host; cannot run Get-ServiceAccountExpiration."
            }

            # Build the domain -> OU map. A malformed map or an unreadable file throws
            # (see Resolve-DomainOUsMap) and terminates the run.
            $DomainOUsMap = Resolve-DomainOUsMap -Json $DomainOUs -Path $DomainOUsFile

            if ($null -eq $DomainOUsMap) {
                # No silent fallback to -DomainName/-OUPath, for exactly the reason
                # S-21 removed one from Get-AllAdmin-Accounts: $DomainName is a SHARED
                # script parameter, so a caller that set the legacy pair but omitted
                # the map would quietly produce a report covering ONE OU and report
                # success. For an expiration report, a silently narrowed scope means an
                # account expires without anyone being warned - the exact failure this
                # report exists to prevent. No scope means the run FAILS and says so.
                Write-Log "Error: Get-ServiceAccountExpiration - no scope supplied. Provide -DomainOUs (inline JSON) or -DomainOUsFile. No report produced." $true
                throw "Get-ServiceAccountExpiration requires a domain/OU map via -DomainOUs or -DomainOUsFile."
            }

            # Look-ahead window. Bad input DEGRADES to the 30-day default with a Warn
            # rather than failing the run: the window only decides which section an
            # account is listed under and what the subject line says - nothing is
            # filtered out by it - so a typo must not cost the customer the report.
            # buildServiceAccountExpirationInvocation validates this properly upstream.
            $win = 30
            $winParsed = 0
            if (-not [int]::TryParse(("$ExpiringWithinDays").Trim(), [ref]$winParsed)) {
                Write-Log "Warn: -ExpiringWithinDays value '$ExpiringWithinDays' is not a whole number; using the default of 30 days." $true
            } elseif ($winParsed -lt 0) {
                Write-Log "Warn: -ExpiringWithinDays value '$ExpiringWithinDays' is negative; using 0 (accounts expiring today)." $true
                $win = 0
            } else {
                $win = $winParsed
            }

            # NO -SC ARGUMENT: every account in the OU, whatever its smartcard setting.
            # See defect 1 above - this is the whole scope fix.
            $Accounts = @(Get-ListOfUsers-MultiDomain -DomainOUsMap $DomainOUsMap)

            # DEDUPLICATE BEFORE COUNTING (S-19). Searches run at SearchScope Subtree,
            # which is fully recursive, so an OU list holding an OU and one of its
            # sub-OUs returns the deeper accounts twice. The counts below feed the
            # SUBJECT LINE, so this must happen here and not only in the report -
            # otherwise the subject would advertise figures the body contradicts.
            $Accounts = @(Remove-DuplicateAccounts -Accounts $Accounts)

            # Classified with the SAME function the report uses, so the subject line and
            # the report body cannot disagree about what "expiring" means.
            $expired  = 0
            $expiring = 0
            $noExpiry = 0
            foreach ($a in $Accounts) {
                $st = Get-AccountExpiryState -ExpirationDate $a.AccountExpirationDate -WithinDays $win
                switch ($st.State) {
                    'Expired'       { $expired++ }
                    'Expiring'      { $expiring++ }
                    'Never expires' { $noExpiry++ }
                }
            }
            Write-Log "Info: Get-ServiceAccountExpiration - $($Accounts.Count) account(s) in scope; $expired expired, $expiring expiring within $win day(s), $noExpiry with no expiry date set." $true

            # Flag an incomplete sweep in the SUBJECT LINE. A recipient triaging by
            # subject must not read "0 expired" as a complete picture when some OUs
            # never returned.
            $failedOUs = @(@($Global:QueryFailures) | Group-Object Domain, OU).Count
            $subjectPrefix = if ($failedOUs -gt 0) { "[INCOMPLETE] " } else { "" }
            $Global:MailSubject = "$($subjectPrefix)$($MailSubjectstring) ( $expired expired - $expiring expiring within $win days )"
            if ($failedOUs -gt 0) {
                Write-Log "Error: Get-ServiceAccountExpiration - $failedOUs OU(s) could not be queried; the counts above are UNDERSTATED and the report is marked INCOMPLETE." $true
            }

            if ($Accounts.Count -eq 0) {
                # Not an error: the scope was valid and was queried, it just held no
                # accounts. Warn so it is obvious in the transcript, and still send the
                # (empty) report WITH its scope footnote so the recipient can see which
                # OUs were actually searched.
                Write-Log "Warn: Get-ServiceAccountExpiration - the supplied OUs contain no user accounts. An empty report will be produced; check the scope footnote for the OUs actually queried." $true
            }

            GenerateReportServiceAccountExpiration $Accounts $DomainOUsMap $Global:QueryFailures $Global:DuplicateAccounts $win
        }
        'Set-L3-Admin-Accounts'{
            $strModule = 'ActiveDirectory' 
            if (Invoke-Module $strModule){
                $OUQuery1 = Get-ListOfUsers -DomainName $DomainName -SC $false
                $objT = @()
                $obj = @()
                foreach($user in $OUQuery1) {
                    $Global:PKIDisabledCount++
                    
                    if($user.SamAccountName.contains("ADMNguyenTD4")){
                        #write-host $user.SamAccountName
                        #Get-AdUser -Identity $($user) | Set-AdUser -SmartcardLogonRequired $True
                    }
                    Get-AdUser -Identity $($user) | Set-AdUser -SmartcardLogonRequired $True

                    $obj = $null
                    $obj = New-Object psobject -Property @{
                
                        SamAccountName = $user.SamAccountName
                        SmartcardLogonRequired = $user.smartcardlogonrequired
                        UserPrincipalName = $user.UserPrincipalName
                    }
                    $objT += $obj  

                }

                $Global:MailSubject = "$($MailSubjectstring) ( $Global:PKIDisabledCount modified )"
                GenerateReport $objT

            }else{ 
                Write-Log "Error: Unable to import PS Modules $($strModule) or it is NOT install" $true 
            }

        }
        'Get-ServerRebootReportStatus-ByCN'{
            $strModule = 'ActiveDirectory' 
            if (Invoke-Module $strModule ){

                $ListOfComputers = Get-ListOfServers-ByCN -SG_CN $SecurityGroup_CN -DomainName $DomainName
                $ListOfServers = @()
                foreach($L in $ListOfComputers){ $ListOfServers += ($L.name) }
                $Result = Get-RebootStatus -ComputerNames $ListOfServers
                $NumberOfRequiredReboot = 0
                $TotalNumberOfRequiredReboot = 0
    
                foreach($r in $Result){
                $TotalNumberOfRequiredReboot++
                if(!([string]$r.PendingReboot -eq "False")){ $NumberOfRequiredReboot++ }
                }
                $Global:MailSubject = "$($MailSubjectstring) - $NumberOfRequiredReboot of $TotalNumberOfRequiredReboot server might required reboot"
                GenerateReportServerPendingRebootStatus $Result

            }else{ 
                Write-Log "Error: Unable to import PS Modules $($strModule) or it is NOT install" $true 
            }

        }
        'Get-ServerPendingRebootStatus'{
            $strModule = 'ActiveDirectory' 
            if (Invoke-Module $strModule ){

                $ListOfComputers = Get-ListOfServers -SecurityGroup $ADGroupMember -DomainName $DomainName # | select -ExpandProperty Name
                $ListOfServers = @()
                foreach($L in $ListOfComputers){ $ListOfServers += ($L.name) }
                $Result = Get-RebootStatus -ComputerNames $ListOfServers
                $NumberOfRequiredReboot = 0
                $TotalNumberOfRequiredReboot = 0
    
                foreach($r in $Result){
                $TotalNumberOfRequiredReboot++
                if(!([string]$r.PendingReboot -eq "False")){ $NumberOfRequiredReboot++ }
                }
                $Global:MailSubject = "$($MailSubjectstring) - $NumberOfRequiredReboot of $TotalNumberOfRequiredReboot server might required reboot"
                GenerateReportServerPendingRebootStatus $Result

            }else{ 
                Write-Log "Error: Unable to import PS Modules $($strModule) or it is NOT install" $true 
            }

        }
        'Invoke-ServerReboot'{
            $strModule = 'ActiveDirectory'
            if (-not (Invoke-Module $strModule)) {
                # No AD module = no server resolution = EVERY reboot fails. This is a
                # total failure, so throw (terminating) - the vRO caller routes a
                # terminating error to its failure end-state.
                Write-Log "Error: Unable to import PS Module $($strModule) or it is NOT installed. Cannot resolve servers - aborting." $true
                throw "ActiveDirectory module not available on the PS host; cannot resolve group '$($ADGroupMember)'."
            }

            # S-7: DIRECT (non-recursive) enabled COMPUTER members only. Rebooting is
            # destructive, so only what the operator placed directly in the group is a
            # target - nested sub-groups are never expanded.
            $ListOfComputers = Get-ListOfServers-Direct -SecurityGroup $ADGroupMember -DomainName $DomainName

            if (($ListOfComputers | Measure-Object).Count -eq 0) {
                Write-Log "Warn: Invoke-ServerReboot - group '$($ADGroupMember)' resolved to zero enabled, direct computer members. No action taken." $true
                return
            }

            $ListOfServers = @()
            foreach($L in $ListOfComputers){ $ListOfServers += ($L.name) }
            write-log "Info: list of servers: $($ListOfServers -join ', ')" $true

            $Result = Get-RebootStatus -ComputerNames $ListOfServers

            # -- Build the per-server record set --------------------------------
            # Driven from the RESOLVED server list, not from Get-RebootStatus output,
            # so a server that returned no status at all still appears in the report
            # rather than vanishing silently.
            $report = @()
            foreach($s in $ListOfServers){
                $sUpper = $s.ToUpper()
                $r = $Result | Where-Object { $_.ComputerName -eq $sUpper } | Select-Object -First 1

                $pending = 'No status returned'
                $preBoot = $null
                if ($r) { $pending = [string]$r.PendingReboot; $preBoot = $r.ComputerlastBootUptime }

                $rec = [PSCustomObject]@{
                    ComputerName      = $sUpper
                    PendingReboot     = $pending
                    PreRebootLastBoot = $preBoot
                    RebootIssued      = $false
                    RebootIssuedAt    = $null
                    BackOnline        = $false
                    NewLastBoot       = $null
                    DurationSec       = 0
                    Status            = ''
                    Detail            = ''
                }

                # S-8: ONLY an explicit 'True' is a reboot target.
                # Previously the test was !(PendingReboot -eq 'False'), which is also
                # true for 'Error Accessing Server' - so a server whose pending state
                # could NOT be read was force-rebooted (shutdown /f) anyway. Never
                # reboot a machine we could not first interrogate.
                if ($pending -eq 'True') {
                    $rec.Status = 'PendingReboot'
                    $rec.Detail = 'Pending reboot detected; queued for reboot.'
                } elseif ($pending -eq 'False') {
                    $rec.Status = 'Skipped-NoRebootRequired'
                    $rec.Detail = 'No pending reboot; not rebooted.'
                } else {
                    $rec.Status = 'Skipped-StatusUnknown'
                    $rec.Detail = "Pending-reboot state could not be determined ('$pending'); server skipped and NOT rebooted."
                    Write-Log "Error: $($sUpper) - pending-reboot state could not be determined ('$pending'); server SKIPPED and NOT rebooted." $true
                }

                $report += $rec
            }

            $rebootTargets = @($report | Where-Object { $_.Status -eq 'PendingReboot' })
            $NumberOfRequiredReboot = $rebootTargets.Count
            Write-Log "Info: number of server required reboot - $($NumberOfRequiredReboot)" $true

            if ( $RebootIt -eq 'simpleMode' -and $NumberOfRequiredReboot -gt 0){

                # -- Phase 1: issue reboots sequentially, delay between each -----
                # Unchanged cadence from the Ansible-era behaviour.
                foreach($t in $rebootTargets){

                    # S-13: pre-reboot step is OPT-IN and defaults to OFF.
                    # ownership_w2k.ps1 takes ownership of and loosens ACLs on
                    # usbstor.inf (USB mass-storage driver INF) and termsrv.dll
                    # (Terminal Services). The S-6 defect meant it never actually
                    # ran, so enabling it now is a security-posture CHANGE, not a
                    # restoration of working behaviour. It executes only when
                    # -RebootIt_RunPreRebootScript is 'yes'.
                    #
                    # When enabled, failure is non-fatal by design (matches the
                    # historic intent): log an Error: and still reboot the server.
                    if ($RebootIt_RunPreRebootScript -eq 'yes') {
                        Try {
                            write-log "Info: invoke script $($scriptDir)/ownership_w2k.ps1 against $($t.ComputerName)" $true
                            Invoke-Command -ComputerName $($t.ComputerName) -FilePath "$($scriptDir)/ownership_w2k.ps1" -ErrorAction Stop
                        } Catch {
                            Write-Log "Error: $($t.ComputerName) - pre-reboot script ownership_w2k.ps1 failed: $($_.Exception.Message)" $true
                        }
                    } else {
                        Write-Log "Info: $($t.ComputerName) - pre-reboot script step is disabled (RebootIt_RunPreRebootScript='$($RebootIt_RunPreRebootScript)'); ownership_w2k.ps1 NOT run." $true
                    }

                    # S-9: Invoke-ServerReboot now returns $true/$false based on shutdown.exe's exit code.
                    $issued = Invoke-ServerReboot -ServerName $($t.ComputerName)
                    if ($issued -eq $true) {
                        $t.RebootIssued   = $true
                        $t.RebootIssuedAt = Get-Date
                        $t.Status         = 'RebootIssued'
                        $t.Detail         = 'Reboot command accepted; awaiting verification.'
                    } else {
                        $t.RebootIssued = $false
                        $t.Status       = 'RebootFailed'
                        $t.Detail       = 'shutdown command failed; see the Error: line in the transcript.'
                    }

                    Start-Sleep -Seconds ([int]$RebootIt_DelayBetweenServer)
                }

                # -- Phase 2: S-10 single verification pass ----------------------
                # One pass over everything actually rebooted, bounding total
                # verification to ~one boot window instead of N x timeout.
                Wait-ServersBackOnline -Targets $report `
                    -TimeoutSec ([int]$RebootIt_VerifyTimeoutSec) `
                    -PollSec ([int]$RebootIt_VerifyPollSec)

            }
            elseif ($NumberOfRequiredReboot -gt 0) {
                # Report-only run: pending reboots found, but the RebootIt safety
                # gate was not set to 'simpleMode'.
                Write-Log "Info: RebootIt='$($RebootIt)' (not 'simpleMode') - report-only run; $($NumberOfRequiredReboot) server(s) require a reboot but none were rebooted." $true
                foreach($t in $rebootTargets){
                    $t.Status = 'Skipped-ReportOnly'
                    $t.Detail = "Pending reboot detected but RebootIt was '$($RebootIt)', not 'simpleMode'."
                }
            }
            else {
                Write-Log "Info: no servers require a reboot." $true
            }

            # -- S-11: report + optional mail (this action previously did neither) --
            $rebootedOk = @($report | Where-Object { $_.Status -eq 'Rebooted' }).Count
            $Global:MailSubject = "$($MailSubjectstring) - $($rebootedOk) of $($NumberOfRequiredReboot) pending server(s) rebooted and verified"
            GenerateReportServerReboot $report

        }
        'get_datastores_75_100_used'{
            # Measured Limits High/Low
            $high = 90 # # Only Modify This Value, the rest are calculated, value should be 95 (don't go below 20)
            $med = [int]$high - 10
            $low = [int]$med - 10
            $med_limit = [int]$high - .01
            $low_limit = [int]$med - .01
            [int]$dsPercentUsed = $low

            # Variables for data gathering
            Set-Variable BYTES_IN_GB -option Constant -value ([int32]1073741824) -Visibility Private 
            [array]$allDsData = @() #array to store all of the Datastore data from each vCenter

            # Check for PowerCLI module and load if it isn't already; required for 'Connect-VIServer'
            if (!(Get-Module VMware.VimAutomation.Core)) {Import-Module VMware.VimAutomation.Core}

            # Check for Connected Servers, if exist disconnect
            if($Global:DefaultVIServers.count -gt 0){DisConnect-VIServer * -Force -Confirm:$False}

            # Connect to vCenters
            foreach ($vcenter in $vCenterList.split(",")) {
                $vcenter = $vcenter.trim()
                Write-Log "vCenter: $($vcenter)"
                Connect-VIServer -Server $vcenter -warningaction 0 -ErrorAction Stop | Out-Null
                [array]$datastores = $null
                [array]$datastores = Get-View -ViewType DataStore -Property Summary
                foreach($ds in $datastores){
                    [decimal]$percentUsed = ([Math]::Round((($ds.summary.capacity - $ds.summary.freespace) / $ds.summary.capacity) * 10000))/100
                    [decimal]$percentFree = ([Math]::Round(($ds.summary.freespace / $ds.summary.capacity) * 10000))/100

                    if(($percentUsed -gt $dsPercentUsed) -and ($ds.summary.uncommitted -gt $ds.summary.freespace)){
                        [pscustomobject]$dsProperties=[ordered]@{
                            'Datastore' = $ds.Summary.Name
                            'vCenter' = $vcenter | %{$_.Split('.')[0];}
                            'CapacityGB' = ([Math]::Round($ds.summary.capacity/$BYTES_IN_GB))
                            'UsedGB' = ([Math]::Round(($ds.summary.capacity - $ds.summary.freespace)/$BYTES_IN_GB))
                            'FreeSpaceGB' = ([Math]::Round($ds.summary.freespace/$BYTES_IN_GB))
                            'UncommittedGB' = ([Math]::Round($ds.summary.uncommitted/$BYTES_IN_GB))
                            'PercentUsed' = $percentUsed
                            'PercentFree' = $percentFree
                        }
                        $singleDsData = New-Object PSObject -Property $dsProperties
                        $allDsData += $singleDsData
                    }
                }
                if($Global:DefaultVIServers.count -gt 0){DisConnect-VIServer * -Force -Confirm:$False}
            }

            # Check for Connected Servers, if exist disconnect
            if($Global:DefaultVIServers.count -gt 0){DisConnect-VIServer * -Force -Confirm:$False}
            ### End VMware Connection

            # Identify over 95%
            $alert_high = $allDsData | Where-Object {$_.PercentUsed -gt $high}
            $alert_high_cnt = $alert_high.Count
            $alert_title = "$alert_high_cnt Datastores @ $high%"
            #$subject = "Datastore Report | "+"$alert_title"+""

            # Email Report
            $ds_high = $allDsData | Where-Object {$_.PercentUsed -gt $high} | Sort-Object -Property Datastore -Unique | Sort-Object -Property PercentFree | ConvertTo-Html -Fragment 
            $ds_med = $allDsData | Where-Object {$_.PercentUsed -gt $med} | Where-Object {$_.PercentUsed -lt $med_limit} | Sort-Object -Property Datastore -Unique | Sort-Object -Property PercentFree | ConvertTo-Html -Fragment
            $ds_low = $allDsData | Where-Object {$_.PercentUsed -gt $low} | Where-Object {$_.PercentUsed -lt $low_limit} | Sort-Object -Property Datastore -Unique | Sort-Object -Property PercentFree | ConvertTo-Html -Fragment

            $Global:MailSubject = "$($MailSubjectstring) | "+"$alert_title"+""
            # Body - Summary
            $body = "<h4>Datastores with Percent Used "+"$low"+"-100% & Less Free Space than Uncommitted will be counted</h4>"
            $body += "<b>Datastores @ "+"$high"+"-100%</b><br>"
            $body += $ds_high
            $body += "<br><b>Datastores @ "+"$med"+"-"+"$med_limit"+"%</b><br>"
            $body += $ds_med
            $body += "<br><b>Datastores @ "+"$low"+"-"+"$low_limit"+"%</b><br>"
            $body += $ds_low

            $body | out-File -append -FilePath "$($Global:DebugDir)\result.html"
            if($eMailReport -eq 'yes'){ SendMail $body }
        }
        'VMware_Disable_SSH'{

            # Output Variables
            $col_head = @{N="vCenter";E={$_.Uid.Split("@")[-1].Split(".")[-4].ToUpper()}},@{N="Host";E={$_.VMHost}},@{N="Service";E={$_.Label}},@{N="Enabled";E={$_.Running}}
            $filter_1 = {$_.Label -eq 'SSH'}
            $filter_2 = {($_.Label -eq 'SSH') -and ($_.Running -eq 'True')}
            $enabled = @()

            $Style = "<style>"
            $Style = $Style + "BODY{background-color:white;font-family:Segoe UI;font-size:12px}"
            $Style = $Style + "TABLE{border-width: 1px;border-style: solid;border-color: black;border-collapse: collapse;}"
            $Style = $Style + "TH{border-width: 1px;padding: 0px;border-style: solid;border-color: black;background-color:gray;color:white}"
            $Style = $Style + "TD{border-width: 1px;padding: 0px;border-style: solid;border-color: black;background-color:lightgrey}"
            $Style = $Style + "</style>"

            if (!(Get-Module VMware.VimAutomation.Core)) {Import-Module VMware.VimAutomation.Core}
            if ($Global:DefaultVIServers.count -gt 0) {DisConnect-VIServer * -Force -Confirm:$False}

            foreach ($vcenter in $vCenterList.split(",")) {           
                $vcenter = $vcenter.trim()
                Write-Log "vCenter: $($vcenter)"
                Connect-VIServer -Server $vcenter -warningaction 0 -ErrorAction Stop | Out-Null
                $vmhosts = $null
                $vmhosts = Get-VMHost
                foreach ($vmhost in $vmhosts) {
                    # Enable; Testing
                        #Get-VMHost -Name $vmhost | Get-VMHostService | Where-Object $filter_1 | Start-VMHostService | Select-Object $col_Head
                    # Verify; Testing
                        #Get-VMHost -Name $vmhost | Get-VMHostService | Where-Object $filter_1 | Select-Object $col_Head
                    # Disable
                        Write-Log "ESXi: $($vmhost)"
                        $enabled += Get-VMHost -Name $vmhost | Get-VMHostService | Where-Object $filter_2 | Select-Object $col_Head
                        Get-VMHost -Name $vmhost | Get-VMHostService | Where-Object $filter_2 | Stop-VMHostService -Confirm:$false | Select-Object $col_Head
                }
                if ($Global:DefaultVIServers.count -gt 0) {DisConnect-VIServer * -Force -Confirm:$False}
            }
            if ($Global:DefaultVIServers.count -gt 0) {DisConnect-VIServer * -Force -Confirm:$False}

            ## Email Body
            $body = "<h3>VMware SSH Enabled Report</h3>"
            $body += "<h4>$($enabled.Count) Hosts Were Disabled</h4>"
            $body += "<h4>VMware Hosts below were set to Enabled and were Disabled by the automated script</h4>"
            $body += $enabled | Sort-Object vCenter,Host | ConvertTo-Html -Head $Style

            $Global:MailSubject = "$($MailSubjectstring)" #"VMware SSH Enabled Report"

            $body | out-File -append -FilePath "$($Global:DebugDir)\result.html"
            if($eMailReport -eq 'yes'){ SendMail $body }

        }
        'clean-ServerDisk'{
            # S-14: hardened to the standards of the other AD-group actions
            # (move-archived-logs-ByCN, Invoke-ServerReboot). Behaviour changes:
            #  - AD module guard: no module => no server resolution => EVERY clean would
            #    fail, so throw (terminating -> the vRO caller routes to its failure end
            #    state) rather than silently doing nothing.
            #  - DIRECT (non-recursive) ENABLED computer members only, via
            #    Get-ListOfServers-Direct. Deleting files is destructive, so only what
            #    the operator placed DIRECTLY in the group is a target - nested
            #    sub-groups are never expanded and disabled accounts are skipped+logged.
            #    (Replaces the legacy flat, UNFILTERED Get-ListOfServers, which also
            #    returned user objects and disabled computers.)
            #  - whatIf safety gate ($WhatIf): 'yes' => report-only (list would-delete,
            #    delete nothing); 'no' => live delete; anything else => Error + no action.
            #    Fails SAFE - only an explicit 'no' deletes.
            #  - Per-server try/catch isolation and a zero-result guard, so one
            #    unreachable server (or an empty group / empty folder list) neither
            #    aborts the run nor is silently mistaken for success.
            $strModule = 'ActiveDirectory'
            if (-not (Invoke-Module $strModule)) {
                Write-Log "Error: Unable to import PS Module $($strModule) or it is NOT installed. Cannot resolve servers - aborting." $true
                throw "ActiveDirectory module not available on the PS host; cannot resolve group '$($ADGroupMember)'."
            }

            # whatIf gate - fail safe: only an explicit 'no' deletes; anything that is
            # not 'yes'/'no' logs an Error and takes no action.
            $wi = ("$WhatIf").Trim().ToLower()
            if ($wi -eq 'no') {
                $reportOnly = $false
            } elseif ($wi -eq 'yes') {
                $reportOnly = $true
            } else {
                Write-Log "Error: clean-ServerDisk - invalid WhatIf value '$WhatIf' (expected 'yes' or 'no'). No action taken." $true
                return
            }

            # DIRECT enabled computer members only. A group-resolution failure is a total
            # failure (see Get-ListOfServers-Direct) and is allowed to terminate the run.
            $ListOfComputers = Get-ListOfServers-Direct -SecurityGroup $ADGroupMember -DomainName $DomainName
            if (($ListOfComputers | Measure-Object).Count -eq 0) {
                Write-Log "Warn: clean-ServerDisk - group '$($ADGroupMember)' resolved to zero enabled, direct computer members. No action taken." $true
                return
            }

            # Folder targets: Convert-YAMLList tolerates the YAML list form carried over
            # from the Ansible vars (e.g. "[ 'c:\Windows\ccmcache' ]"); a plain
            # comma-separated string passes through unchanged. Empty entries are dropped.
            $ListOfFolder = Convert-YAMLList $FolderTarget
            $parsedArray = @(($ListOfFolder -split ',') | ForEach-Object { $_.Trim() } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
            if ($parsedArray.Count -eq 0) {
                Write-Log "Error: clean-ServerDisk - no folder targets supplied (FolderTarget='$FolderTarget'). No action taken." $true
                return
            }

            Write-Log "Info: clean-ServerDisk - $(($ListOfComputers | Measure-Object).Count) server(s), $($parsedArray.Count) folder target(s), ReportOnly=$reportOnly, FilterOn='$FilterOn', NumberOfDays='$NumberOfDays', FolderIncluded='$FolderIncluded', ForceEnable='$ForceEnable'." $true

            foreach($L in $ListOfComputers){
                # Per-server isolation: one unreachable/failed server must not stop the
                # rest. Remove-files logs its own failures; this Catch is a backstop.
                Try {
                    foreach($f in $parsedArray){
                        $unc  = $f.replace(':', '$')                 # c:\path -> c$\path (admin share)
                        $path = "\\$($L.name)\$($unc)"
                        Write-Log "Info: $($L.name) - $(if($reportOnly){'previewing'}else{'cleaning'}) $($path) - FolderIncluded=$FolderIncluded FilterOn=$FilterOn NumberOfDays=$NumberOfDays" $true
                        Remove-files -Path $path -FilterOn $FilterOn -NumberOfDays $NumberOfDays -FolderIncluded $FolderIncluded -ForceEnable $ForceEnable -ReportOnly $reportOnly -ServerName $L.name
                    }
                } Catch {
                    Write-Log "Error: $($L.name) - disk clean failed and was skipped: $($_.Exception.Message)" $true
                }
            }

        }
        'move-archived-logs'{
            $ListOfComputers = Get-ListOfServers -SecurityGroup $ADGroupMember -DomainName $DomainName
            $ListOfServers = @()
            foreach($L in $ListOfComputers){ 
                $ListOfServers += ($L.name)
                Write-Log "Info: $($L.name) - moving archived files to $($FileShareTarget)\$($L.name)" $true
                Move-files -Path "\\$($L.name)\C$\Windows\System32\winevt\Logs" `
                -ServerName $L.name -TargetPath "$($FileShareTarget)\$($L.name)" `
                -FilterOn "Archive*.evtx" -Days '-1' -F 'force'
            }

        }
        'move-archived-logs-ByCN'{
            $strModule = 'ActiveDirectory'
            if (-not (Invoke-Module $strModule)) {
                # No AD module = no server resolution = ALL moves fail. This is a
                # total failure, so throw (terminating) - the vRO caller routes a
                # terminating error to its failure end-state.
                Write-Log "Error: Unable to import PS Module $($strModule) or it is NOT installed. Cannot resolve servers - aborting." $true
                throw "ActiveDirectory module not available on the PS host; cannot resolve group '$($SecurityGroup_CN)'."
            }

            # File filter and age are supplied by the caller (vRO workflow inputs
            # -FilterOn / -NumberOfDays). Fall back to the proven archive-log
            # defaults if left at the script defaults, so a stray manual call
            # never sweeps every file at a 0-day age.
            $moveFilter = if ([string]::IsNullOrWhiteSpace($FilterOn) -or $FilterOn -eq '*') { 'Archive*.evtx' } else { $FilterOn }
            $moveDays   = if ([string]::IsNullOrWhiteSpace($NumberOfDays)) { '-1' } else { $NumberOfDays }

            # Server resolution. A failure here is a total failure (see
            # Get-ListOfServers-ByCN) and is allowed to terminate the run.
            $ListOfComputers = Get-ListOfServers-ByCN -SG_CN $SecurityGroup_CN -DomainName $DomainName

            if (($ListOfComputers | Measure-Object).Count -eq 0) {
                Write-Log "Warn: move-archived-logs-ByCN - group '$($SecurityGroup_CN)' resolved to zero enabled computer objects. No action taken." $true
                return
            }

            Write-Log "Info: move-archived-logs-ByCN - $(($ListOfComputers | Measure-Object).Count) enabled server(s) to process. Filter='$moveFilter' AgeDays='$moveDays'" $true

            $ListOfServers = @()
            foreach($L in $ListOfComputers){
                $ListOfServers += ($L.name)
                # Per-server isolation: one unreachable/failed server must not
                # stop the remaining moves. Move-files logs its own failures;
                # this Catch is a backstop for anything it does not swallow.
                Try {
                    Write-Log "Info: $($L.name) - moving archived files to $($FileShareTarget)\$($L.name)" $true
                    Move-files -Path "\\$($L.name)\C$\Windows\System32\winevt\Logs" `
                        -ServerName $L.name -TargetPath "$($FileShareTarget)\$($L.name)" `
                        -FilterOn $moveFilter -Days $moveDays -F 'force'
                } Catch {
                    Write-Log "Error: $($L.name) - archive-log move failed and was skipped: $($_.Exception.Message)" $true
                }
            }
        }
        'tls-fix'{

                $ListOfComputers = Get-ListOfServers -SecurityGroup $ADGroupMember -DomainName $DomainName
                $ListOfServers = @()
                foreach($L in $ListOfComputers){ 
                    $ListOfServers += ($L.name)
                    write-log "Info: invoke script $($scriptDir)/$ActionRemoteFile $($L.name)" $true
                    Invoke-Command -ComputerName $($L.name) -FilePath "$($scriptDir)/$ActionRemoteFile"
                }

        }
        'Delete-OldFiles-UNC-Share'{
            if($WhatIf -eq 'yes'){
                # Report-only: lists candidate files, deletes nothing.
                # Safe for non-interactive execution (vRO PowerShell plug-in).
                Remove-OldFiles-UNCPath -path $UNC_SharePath -OlderThanDays $OlderThanDays -ReportOnly $true
            }elseif($WhatIf -eq 'no'){
                # Live deletion, no interactive prompt.
                Remove-OldFiles-UNCPath -path $UNC_SharePath -OlderThanDays $OlderThanDays -Force $true
            }else{
                write-log "Error: Delete-OldFiles-UNC-Share - invalid WhatIf value '$WhatIf' (expected 'yes' or 'no'). No action taken." $true
            }
            
        }
    } # switch Action selection

}

InitializeVariables # Initialize Variables into memory
CertificateValidation # Certificate Validation for selt-sign issue

Main $Action

#$LogContent = get-Content -Path $Global:SystemLog
#Write-host $LogContent

