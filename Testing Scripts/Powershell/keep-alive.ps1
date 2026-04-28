$wsh = New-Object -ComObject WScript.Shell
while ($true) {
    $wsh.SendKeys("{SCROLLLOCK}")
    Start-Sleep -Seconds 60
}