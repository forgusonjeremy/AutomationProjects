
$DisableTLSCipherSuiteList = @('TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA256',
'TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA384',
'TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA',
'TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA',
'TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA',
'TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA',
'TLS_DH_DSS_WITH_AES_128_GCM_SHA256',
'TLS_DH_DSS_WITH_AES_256_GCM_SHA384',
'TLS_DH_DSS_WITH_AES_128_CBC_SHA256',
'TLS_DH_DSS_WITH_AES_256_CBC_SHA256',
'TLS_DHE_DSS_WITH_AES_128_CBC_SHA',
'TLS_DHE_DSS_WITH_AES_256_CBC_SHA',
'TLS_DH_DSS_WITH_AES_128_CBC_SHA',
'TLS_DH_DSS_WITH_AES_256_CBC_SHA',
'TLS_DH_RSA_WITH_AES_128_CBC_SHA',
'TLS_DH_RSA_WITH_AES_256_CBC_SHA',
'TLS_DH_RSA_WITH_AES_128_GCM_SHA256',
'TLS_DH_RSA_WITH_AES_256_GCM_SHA384',
'TLS_DH_RSA_WITH_AES_256_CBC_SHA256',
'TLS_DH_RSA_WITH_AES_128_CBC_SHA256',
'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256',
'TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384',
'TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA256',
'TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA384',
'TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA',
'TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA',
'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256',
'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384',
'TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA',
'TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA',
'TLS_DHE_RSA_WITH_AES_128_CBC_SHA',
'TLS_DHE_RSA_WITH_AES_256_CBC_SHA',
'TLS_RSA_WITH_AES_128_CBC_SHA',
'TLS_RSA_WITH_AES_128_CBC_SHA256',
'TLS_RSA_WITH_AES_128_GCM_SHA256',
'TLS_RSA_WITH_AES_256_CBC_SHA',
'TLS_RSA_WITH_AES_256_CBC_SHA256',
'TLS_RSA_WITH_AES_256_GCM_SHA384')

$EnableCipherSuiteList = @('TLS_AES_128_GCM_SHA256', 
'TLS_AES_256_GCM_SHA384', 
'TLS_AES_128_CCM_SHA256', 
'TLS_AES_128_CCM_8_SHA256',
'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256', 
'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384',
'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256',
'TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384')

function EnableTLSSuite {

    try {
            write-host "Starting to enable list of TLS setting"
            # Enable TLS 1.3
            If (-Not (Test-Path 'HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.3\Server')) {
                New-Item 'HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.3\Server' -Force | Out-Null
            }
            New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.3\Server' -Name 'Enabled' -value '1' -PropertyType 'DWord' -Force | Out-Null
            New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.3\Server' -Name 'DisabledByDefault' -value 0 -PropertyType 'DWord' -Force | Out-Null

            If (-Not (Test-Path 'HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.3\Client')) {
                New-Item 'HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.3\Client' -Force | Out-Null
            }
            New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.3\Client' -Name 'Enabled' -value '1' -PropertyType 'DWord' -Force | Out-Null
            New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.3\Client' -Name 'DisabledByDefault' -value 0 -PropertyType 'DWord' -Force | Out-Null
            #Write-Host 'TLS 1.3 has been enabled.' -ForegroundColor Cyan

            # Enable TLS 1.2
            If (-Not (Test-Path 'HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.2\Server')) {
                New-Item 'HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.2\Server' -Force | Out-Null
            }
            New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.2\Server' -Name 'Enabled' -value '1' -PropertyType 'DWord' -Force | Out-Null
            New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.2\Server' -Name 'DisabledByDefault' -value 0 -PropertyType 'DWord' -Force | Out-Null

            If (-Not (Test-Path 'HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.2\Client')) {
                New-Item 'HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.2\Client' -Force | Out-Null
            }
            New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.2\Client' -Name 'Enabled' -value '1' -PropertyType 'DWord' -Force | Out-Null
            New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.2\Client' -Name 'DisabledByDefault' -value 0 -PropertyType 'DWord' -Force | Out-Null
            #Write-Host 'TLS 1.2 has been enabled.' -ForegroundColor Cyan

            # Disable TLS 1.1
            If (-Not (Test-Path 'HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.1\Server')) {
                New-Item 'HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.1\Server' -Force | Out-Null
            }
            New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.1\Server' -Name 'Enabled' -value '0' -PropertyType 'DWord' -Force | Out-Null
            New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.1\Server' -Name 'DisabledByDefault' -value 1 -PropertyType 'DWord' -Force | Out-Null

            If (-Not (Test-Path 'HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.1\Client')) {
                New-Item 'HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.1\Client' -Force | Out-Null
            }
            New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.1\Client' -Name 'Enabled' -value '0' -PropertyType 'DWord' -Force | Out-Null
            New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.1\Client' -Name 'DisabledByDefault' -value 1 -PropertyType 'DWord' -Force | Out-Null
            #Write-Host 'TLS 1.1 has been disabled.' -ForegroundColor Cyan

            # Disable TLS 1.0
            If (-Not (Test-Path 'HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.0\Server')) {
                New-Item 'HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.0\Server' -Force | Out-Null
            }
            New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.0\Server' -Name 'Enabled' -value '0' -PropertyType 'DWord' -Force | Out-Null
            New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.0\Server' -Name 'DisabledByDefault' -value 1 -PropertyType 'DWord' -Force | Out-Null

            If (-Not (Test-Path 'HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.0\Client')) {
                New-Item 'HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.0\Client' -Force | Out-Null
            }
            New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.0\Client' -Name 'Enabled' -value '0' -PropertyType 'DWord' -Force | Out-Null
            New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.0\Client' -Name 'DisabledByDefault' -value 1 -PropertyType 'DWord' -Force | Out-Null
            #Write-Host 'TLS 1.0 has been disabled.' -ForegroundColor Cyan
            #Write-Host 'You must restart the Windows Server for the changes to take effect.' -ForegroundColor Cyan

    }
    catch {
        <#Do this if a terminating exception happens#>
    }

}

function EnableTLSSuite {
            
    foreach ($tls in $EnableCipherSuiteList) {
        #Write-Host "Enabling - $tls " -ForegroundColor DarkYellow
        try{

            Enable-TlsCipherSuite -Name $tls -ErrorAction SilentlyContinue  
        }
        catch{

        }

    }

}

function DisableTLSSuite {
            
    foreach ($tls in $DisableTLSCipherSuiteList) {
        #Write-Host "Disabling - $tls " -ForegroundColor DarkYellow
        try{

            Disable-TlsCipherSuite -Name $tls -ErrorAction SilentlyContinue  
        }
        catch{

        }

    }

}

function Get-TLSSuite-result {
            
    $TLS= GET-TlsCipherSuite
    try{
        foreach($suite in $TLS)
        {
            Write-Host "Enabled TLSSuite - $($suite.Name)"  -ForegroundColor DarkGreen
        }
    }
    catch{

    }
}

EnableTLSSuite
DisableTLSSuite
Get-TLSSuite-result


