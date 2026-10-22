$ErrorActionPreference = 'Stop'
$desktopExePath = Join-Path $PSScriptRoot '桌面版\工作台\工作台.exe'
if (-not (Test-Path -LiteralPath $desktopExePath)) { throw '尚未构建桌面版。' }
Start-Process -FilePath $desktopExePath -ArgumentList '--quit' -WindowStyle Hidden -Wait
for ($desktopAttempt=0; $desktopAttempt -lt 30; $desktopAttempt++) {
    $desktopRunning = @(Get-CimInstance Win32_Process -Filter "Name = '工作台.exe'" | Where-Object { $_.ExecutablePath -eq $desktopExePath -and $_.CommandLine -notmatch '--type=' })
    if (-not $desktopRunning.Count) { Write-Output '桌面工作台已退出，数据保留。'; exit 0 }
    Start-Sleep -Milliseconds 500
}
throw '桌面工作台仍在清理本次数据服务，请稍后检查运行日志。未强制停止任何进程。'
