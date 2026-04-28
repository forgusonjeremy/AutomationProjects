param (
    [Parameter(Mandatory=$true)]
    [string]$StartIP,
    [Parameter(Mandatory=$true)]
    [string]$EndIP
)

# Function to convert IP to integer for range iteration
function Convert-IPToInt {
    param ([string]$IP)
    $octets = $IP -split '\.'
    return [int]$octets[0] * 16777216 + [int]$octets[1] * 65536 + [int]$octets[2] * 256 + [int]$octets[3]
}

# Function to convert integer back to IP
function Convert-IntToIP {
    param ([int]$Int)
    return "$([math]::Floor($Int / 16777216)).$([math]::Floor(($Int % 16777216) / 65536)).$([math]::Floor(($Int % 65536) / 256)).$($Int % 256)"
}

$startInt = Convert-IPToInt -IP $StartIP
$endInt = Convert-IPToInt -IP $EndIP

for ($i = $startInt; $i -le $endInt; $i++) {
    $currentIP = Convert-IntToIP -Int $i
    try {
        $pingResult = Test-Connection -ComputerName $currentIP -Count 1 -Quiet
        if ($pingResult) {
            Write-Host "$currentIP - Taken"
        } else {
            Write-Host "$currentIP - Available"
        }
    } catch {
        Write-Host "$currentIP - Available"
    }
}