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
    [string]$OlderThanDays
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
        [string] $NumberOfDays = 0
    )
    Begin{
        $dateTime = (Get-Date).AddDays([int]$NumberOfDays)
    }
    Process{
        Try {
            $FolderIncluded = $FolderIncluded.ToLower()
            $ForceEnable = $ForceEnable.ToLower()
            $FileExclude = "vmware-vmsvc-SYSTEM.log"
            if( $ForceEnable -eq 'yes'){
                if( $FolderIncluded -eq 'yes' ){
                    Write-Log "Info: cleaning $($path) - FolderIncluded:$FolderIncluded FilterOn:$FilterOn ForceEnable:$ForceEnable NumberOfDays:$NumberOfDays" $true
                    Get-ChildItem -recurse -Filter $FilterOn -Path $Path | Where-Object { $_.LastWriteTime -lt $dateTime -and $_.Name -cne $FileExclude } | Remove-Item -Force -recurse -Confirm:$false

                }else{
                    Write-Log "Info: cleaning $($path) - FolderIncluded:$FolderIncluded FilterOn:$FilterOn ForceEnable:$ForceEnable NumberOfDays:$NumberOfDays" $true
                    Get-ChildItem -recurse -File -Filter $FilterOn -Path $Path | Where-Object { $_.LastWriteTime -lt $dateTime -and $_.Name -cne $FileExclude } | Remove-Item -Force -recurse -Confirm:$false
                }
            }else{
                if( $FolderIncluded -eq 'yes' ){
                    Write-Log "Info: cleaning $($path) - FolderIncluded:$FolderIncluded FilterOn:$FilterOn ForceEnable:$ForceEnable NumberOfDays:$NumberOfDays" $true
                    Get-ChildItem -recurse -Filter $FilterOn -Path $Path | Where-Object { $_.LastWriteTime -lt $dateTime  -and $_.Name -cne $FileExclude} | Remove-Item -recurse -Confirm:$false
                }else{
                    Write-Log "Info: cleaning $($path) - FolderIncluded:$FolderIncluded FilterOn:$FilterOn ForceEnable:$ForceEnable NumberOfDays:$NumberOfDays" $true
                    Get-ChildItem -recurse -File -Filter $FilterOn -Path $Path | Where-Object { $_.LastWriteTime -lt $dateTime -and $_.Name  -and $_.Name -cne $FileExclude } | Remove-Item -recurse -Confirm:$false
                }
            }

        }Catch{ Write-Log "Error: $_.Exception.message" $true} 
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
            Send-MailMessage @mailParams
	    }
	    Catch
	    {
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
    $body | out-File -append -FilePath "$($Global:DebugDir)\ServerPendingRebootStatus_result.html"
    if($eMailReport -eq 'yes'){ SendMail -MailBody $body }
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

function GenerateReportServiceAccountExpiration($data){

    $Style = "<style>"
    $Style = $Style + "BODY{background-color:white;font-family:Segoe UI;font-size-adjust: .58}"
    $Style = $Style + "TABLE{border-width: 1px;border-style: solid;border-color: black;border-collapse: collapse;}"
    $Style = $Style + "TH{border-width: 1px;padding: 0px;border-style: solid;border-color: black;background-color:gray;color:white}"
    $Style = $Style + "TD{border-width: 1px;padding: 0px;border-style: solid;border-color: black;background-color:lightgrey}"
    $Style = $Style + "</style>"

    [string]$body = $data | ConvertTo-Html -Property SamAccountName, DisplayName, Office, Enabled, Lockedout, "PW Age", "PW LastSet",Description, WhenCreated  -Head $Style
    #$body = $body -replace 'Thieu N','<font color="red">Thieu N</font>'

    #$body = $body -replace 'SamAccountName', 'AccountName'
    $body = $body -replace 'AccountExpirationDate', 'ExpirationDate'
    $body = $body -replace 'WhenCreated', 'CreatedOn'
    $body | out-File -append -FilePath "$($Global:DebugDir)\ServiceAccountExpiration_result.html"

    Write-Log "Info: $($body)" $true
    if($eMailReport -eq 'yes'){ SendMail $body }

}

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
            $strModule = 'ActiveDirectory' 
            if (Invoke-Module $strModule){

                $Result = Get-ListOfUsers -DomainName $DomainName -SC $true | select SamAccountName, UserPrincipalName, smartcardlogonrequired, displayName, whenCreated, description, Enabled
                foreach($r in $Result){
                    $Global:PKIEnabledCount++
                    write-Log "Info: $($r) PKI enabled $($Global:PKIEnabledCount)" $true
                }
                

                $Result2 = Get-ListOfUsers -DomainName $DomainName -SC $false | select SamAccountName, UserPrincipalName, smartcardlogonrequired, displayName, whenCreated, description, Enabled
                if($Result2 -eq $null){
                    $Global:PKIDisabledCount = 0

                }                
                else
                {

                    foreach($r in $Result2){
                        $Global:PKIDisabledCount++
                        write-Log "Info: $($r) PKI disabled $($Global:PKIDisabledCount)" $true
                    }
                }
                
                $Global:MailSubject = "$($MailSubjectstring) ( $Global:PKIDisabledCount Non-Compliance - $Global:PKIEnabledCount Compliance )"
                $Result += $Result2
                GenerateReportPKI $Result

            }else{ 
                Write-Log "Error: Unable to import PS Modules $($strModule) or it is NOT install" $true 
            }

        }
        'Get-ServiceAccountExpiration'{
            $strModule = 'ActiveDirectory' 
            if (Invoke-Module $strModule){
                $Result = Get-ListOfUsers -DomainName $DomainName | Select-object "SamAccountName","DisplayName","Office", "pwdLastSet","AccountExpirationDate","WhenCreated","Enabled","Lockedout","Description" |
                    Select-Object -Property "SamAccountName","DisplayName","Office","Enabled","Lockedout",`
                    @{Name="PW Age";Expression={if($_.pwdLastSet -ne 0){(new-TimeSpan([datetime]::FromFileTimeUTC($_.PwdLastSet)) $($Global:Today)).days}else{0}}},"AccountExpirationDate",`
                    @{Name="PW LastSet";Expression={[datetime]::FromFileTime($_."pwdLastSet")}},"Description","WhenCreated" | Sort-Object -Property "PW Age" -Descending

                Write-Log "Info: $($Result)" $true
                $Global:MailSubject = "$($MailSubjectstring)"
                $Result += $Result2
                GenerateReportServiceAccountExpiration $Result

            }else{ 
                Write-Log "Error: Unable to import PS Modules $($strModule) or it is NOT install" $true 
            }

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
            $delimiter = ','
            $ListOfComputers = Get-ListOfServers -SecurityGroup $ADGroupMember -DomainName $DomainName
            $ListOfServers = @()
            $ListOfFolder = $FolderTarget
            $ListOfFolder = Convert-YAMLList $ListOfFolder
            foreach($L in $ListOfComputers){ 
                $ListOfServers += ($L.name)
                $parsedArray = ($ListOfFolder -split $delimiter).Trim()    
                foreach( $f in $parsedArray){
                    $f = $f.replace(':', '$')
                    $path = "\\$($L.name)\$($f)"
                    #Write-Log "Info: $($L.name) - cleaning $($path) - FolderIncluded=$FolderIncluded" $true
                    Remove-files -Path $path -FilterOn $FilterOn -NumberOfDays $NumberOfDays -FolderIncluded $FolderIncluded -ForceEnable $ForceEnable
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

