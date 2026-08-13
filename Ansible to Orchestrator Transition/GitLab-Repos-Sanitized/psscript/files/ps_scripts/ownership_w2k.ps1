
Function Invoke-OwnershipProcess { # Invoke-OwnershipProcess
    [CmdletBinding()]
    Param(
        [Parameter(Mandatory=$false)]
        [ValidateNotNullOrEmpty()]
        [string] $computername

    )
    Begin{
 
    }
    Process{
        Try {

                # Run a dos command prompt with elevated priviledges
                # Make files owned by administrator
                & takeown /A /F c:\windows\inf\usbstor.inf
                & takeown /A /F c:\windows\system32\termsrv.dll

                # Adjust from DENY to ALLOW
                & icacls c:\windows\inf\usbstor.inf /grant Users:RX
                & icacls c:\windows\inf\usbstor.inf /grant Administrators:F

                #REM grant full permissions
                & icacls c:\windows\system32\termsrv.dll /grant :r administrator:F

        }Catch{ Write-Host "$_.Exception.message" $true} 
    }
}   # Invoke-OwnershipProcess

Invoke-OwnershipProcess

