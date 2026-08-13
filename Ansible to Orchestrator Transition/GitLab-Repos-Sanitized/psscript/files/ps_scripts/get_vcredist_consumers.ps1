param(
    [Parameter(Mandatory)]
    [string]$ComputerName,                 # comma-separated, e.g. "BBB,CCC"
    [string]$OutputDirectory = 'C:\Temp'
)

$targets = $ComputerName -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }

$scriptBlock = {
    $legacyMap = @{
        'msvcr80'='VC++ 2005'; 'msvcp80'='VC++ 2005'; 'mfc80'='VC++ 2005'; 'atl80'='VC++ 2005'
        'msvcr90'='VC++ 2008'; 'msvcp90'='VC++ 2008'; 'mfc90'='VC++ 2008'; 'atl90'='VC++ 2008'
        'msvcr100'='VC++ 2010'; 'msvcp100'='VC++ 2010'; 'mfc100'='VC++ 2010'; 'atl100'='VC++ 2010'
        'msvcr110'='VC++ 2012'; 'msvcp110'='VC++ 2012'; 'mfc110'='VC++ 2012'; 'atl110'='VC++ 2012'
        'msvcr120'='VC++ 2013'; 'msvcp120'='VC++ 2013'; 'mfc120'='VC++ 2013'; 'atl120'='VC++ 2013'
    }

    # Live consumers of legacy runtime DLLs
    foreach ($p in Get-Process) {
        try {
            foreach ($m in $p.Modules) {
                $base = [IO.Path]::GetFileNameWithoutExtension($m.ModuleName).ToLower()
                if ($legacyMap.ContainsKey($base)) {
                    [PSCustomObject]@{
                        Type    = 'Usage'
                        Family  = $legacyMap[$base]
                        Module  = $m.ModuleName
                        Version = $m.FileVersionInfo.FileVersion
                        Process = $p.ProcessName
                        PID     = $p.Id
                        Path    = $m.FileName
                    }
                }
            }
        } catch {
            [PSCustomObject]@{ Type='Usage'; Family='UNREADABLE'; Module=''; Version=''
                Process=$p.ProcessName; PID=$p.Id; Path='' }
        }
    }

    # Installed legacy VC++ redistributable packages
    $uninstallPaths = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    Get-ItemProperty $uninstallPaths -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -match 'Microsoft Visual C\+\+ (2005|2008|2010|2012|2013)' } |
        ForEach-Object {
            $year = [regex]::Match($_.DisplayName, '2005|2008|2010|2012|2013').Value
            [PSCustomObject]@{
                Type    = 'Installed'
                Family  = "VC++ $year"
                Module  = $_.DisplayName
                Version = $_.DisplayVersion
                Process = ''
                PID     = $null
                Path    = ''
            }
        }
}

$raw = Invoke-Command -ComputerName $targets -ScriptBlock $scriptBlock -ErrorAction Continue

$usage     = $raw | Where-Object Type -eq 'Usage'
$installed = $raw | Where-Object Type -eq 'Installed'

if (-not (Test-Path $OutputDirectory)) {
    New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
}
$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'

# Detail CSV: every legacy runtime DLL loaded, by process
$detailPath = Join-Path $OutputDirectory "vc_legacy_usage_$stamp.csv"
$usage |
    Select-Object @{n='Computer';e={$_.PSComputerName}}, Family, Module, Version, Process, PID, Path |
    Sort-Object Computer, Family, Process |
    Export-Csv -Path $detailPath -NoTypeInformation -Encoding UTF8

# Summary CSV: one row per computer + family with a removal verdict
$families = 'VC++ 2005','VC++ 2008','VC++ 2010','VC++ 2012','VC++ 2013'
$summary = foreach ($c in $targets) {
    $unreadable = @($usage | Where-Object { $_.PSComputerName -eq $c -and $_.Family -eq 'UNREADABLE' })
    foreach ($f in $families) {
        $inst = @($installed | Where-Object { $_.PSComputerName -eq $c -and $_.Family -eq $f })
        $use  = @($usage     | Where-Object { $_.PSComputerName -eq $c -and $_.Family -eq $f })
        $verdict = if ($use) { 'IN USE - DO NOT REMOVE' }
                   elseif ($inst) { 'Installed, no live consumers' }
                   else { 'Not installed' }
        [PSCustomObject]@{
            Computer           = $c
            Family             = $f
            Installed          = [bool]$inst
            InstalledPackages  = ($inst.Module | Sort-Object -Unique) -join '; '
            InUse              = [bool]$use
            Processes          = ($use.Process | Sort-Object -Unique) -join ', '
            UnreadableProcs    = $unreadable.Count
            Verdict            = $verdict
        }
    }
}
$summaryPath = Join-Path $OutputDirectory "vc_legacy_summary_$stamp.csv"
$summary | Sort-Object Computer, Family |
    Export-Csv -Path $summaryPath -NoTypeInformation -Encoding UTF8

Write-Output "Summary : $summaryPath"
Write-Output "Detail  : $detailPath"
$summary | Where-Object InUse | ForEach-Object {
    Write-Output "IN USE  : $($_.Computer) $($_.Family) -> $($_.Processes)"
}