[CmdletBinding()]
param (
    [ValidateSet('move-archived-logs-ByCN','move-archived-logs-ByHostList','Delete-OldFiles-UNC-Share','tls-fix','move-archived-logs','clean-ServerDisk','Invoke-ServerReboot','Get-ServerPendingRebootStatus','Get-ServerRebootReportStatus-ByCN','Get-AllAdmin-Accounts','Get-ServiceAccountExpiration','get_datastores_75_100_used','VMware_Disable_SSH')]
    [string]$Action,
    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$eMailReport='yes',
    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$SMTPServer,
    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$MailToString = 'admin@corp.local',
    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$MailCcString = 'admin@corp.local',
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
    [Parameter(Mandatory=$false, ValueFromPipeline=$true)]
    [string]$HostList
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
                $global:PSScriptRoot
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
        [bool]$Force=$false
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
            
            # Confirm deletion if not using -Force or -WhatIf
            if (-not $Force -and -not $WhatIfPreference) {
                $Confirmation = Read-Host "Are you sure you want to delete these files? (Y/N)"
                if ($Confirmation -ne 'Y') {
                    write-log "Info: Operation cancelled by user" $true
                    return
                }
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
                new-item -ItemType Directory -Path $TargetPath
            }
            
            Get-ChildItem -Path $Path -Recurse -File -Filter $FilterOn | Where-Object { $_.LastWriteTime -lt $dateTime } | Move-Item -Destination "$($TargetPath)" -Force

        }Catch{ 
            Write-Log "error: $_.Exception.message" $true 
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
            $Global:MailFrom = $env:COMPUTERNAME + '_Do_Not_Reply@corp.local'
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
                Import-Module $moduleName -ErrorAction SilentlyContinue
                Write-Log "Info: Success - loaded module $($moduleName)" $true
            }catch{ Write-log "Error: Issue importing module $($moduleName)" $true; return $false }
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
        [string]$SG_CN,
        [parameter (Mandatory = $false)]
        [string]$DomainName
    )
    process {
        $OUQuery1 = Get-ADGroupMember "$($SG_CN)" -Server $DomainName -Recursive |
            Where-Object { $_.objectClass -eq 'computer' } |
            Get-ADComputer -Server $DomainName -Properties Enabled |
            Where-Object { $_.Enabled -eq $true }

        return $OUQuery1
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
            shutdown /r /t 2 /c "Ansible rebooting server to address pending reboot status on patching" /f /m "\\$($ServerName)"

        } catch {
            Write-Log "Error: $($_.Exception.Message)" $true
        }

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

            Write-Log "Info: smtpserver:$SMTPServer `nFrom:$MailFrom `nTo:$MailTo `nSubject:$MailSubject `nBody:$MailBody"
            if([string]::IsNullOrEmpty($MailAttachments)){
                Send-MailMessage -smtpserver $SMTPServer -from $MailFrom -to $MailTo -cc $MailCc -subject $MailSubject -body $MailBody -bodyashtml
            }
            else{
                Send-MailMessage -smtpserver $SMTPServer -from $MailFrom -to $MailTo -cc $MailCc -subject $MailSubject -body $MailBody -bodyashtml -Attachments $MailAttachments
            }  
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
            if (Invoke-Module $strModule ){

                $ListOfComputers = Get-ListOfServers -SecurityGroup $ADGroupMember  -DomainName $DomainName
                $ListOfServers = @()
                write-log "Info: server count $($ListOfComputers.count)" $true
                foreach($L in $ListOfComputers){ 
                    $ListOfServers += ($L.name)
                    
                }
                write-log "Info: list of servers: $($ListOfServers)" $true
                $Result = Get-RebootStatus -ComputerNames $ListOfServers
                $NumberOfRequiredReboot = 0

                # checking for reboot requirements
                foreach($r in $Result){
                    $TotalNumberOfRequiredReboot++
                    if(!([string]$r.PendingReboot -eq "False")){ $NumberOfRequiredReboot++ }
                }

                Write-Log "Info: number of server required reboot - $($NumberOfRequiredReboot)" $true
                if ( $RebootIt -eq 'simpleMode' -and $NumberOfRequiredReboot -gt 0){

                    foreach($r in $Result){

                        if(!([string]$r.PendingReboot -eq "False")){ 
                            write-log "Info: invoke script $($scriptDir)/ownership_w2k.ps1 against $($r.ComputerName)" $true
                            Invoke-Command -ComputerName $($r.ComputerName) -FilePath "$($scriptDir)/ownership_w2k.ps1"

                            Invoke-ServerReboot -ServerName $($r.ComputerName)
                            Start-Sleep -Seconds $RebootIt_DelayBetweenServer                           
                        }

                    }

                }

            }else{ 
                Write-Log "Error: Unable to import PS Modules $($strModule) or it is NOT install" $true 
            }

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
            $ListOfComputers = Get-ListOfServers-ByCN -SG_CN $SecurityGroup_CN -DomainName $DomainName
            $ListOfServers = @()
            foreach($L in $ListOfComputers){ 
                $ListOfServers += ($L.name)
                Write-Log "Info: $($L.name) - moving archived files to $($FileShareTarget)\$($L.name)" $true
                Move-files -Path "\\$($L.name)\C$\Windows\System32\winevt\Logs" `
                -ServerName $L.name -TargetPath "$($FileShareTarget)\$($L.name)" `
                -FilterOn "Archive*.evtx" -Days '-1' -F 'force'
            }
        }
        'move-archived-logs-ByHostList'{
            # Accepts a comma-separated list of FQDNs.
            # Source path is constructed as a UNC admin share path for each host,
            # consistent with move-archived-logs and move-archived-logs-ByCN.
            # Used by the Move-ArchivedLogs-LocalHost vRO workflow where the PS
            # host FQDN is passed as the single HostList entry, ensuring all
            # source access is via UNC admin shares regardless of whether the
            # executing host is itself in the list.

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
                Remove-OldFiles-UNCPath -path $UNC_SharePath -OlderThanDays $OlderThanDays -Force $false
            }elseif($WhatIf -eq 'no'){
                Remove-OldFiles-UNCPath -path $UNC_SharePath -OlderThanDays $OlderThanDays -Force $true
            }else{

            }
            
        }
    } # switch Action selection

}

InitializeVariables # Initialize Variables into memory
CertificateValidation # Certificate Validation for selt-sign issue

Main $Action

#$LogContent = get-Content -Path $Global:SystemLog
#Write-host $LogContent

