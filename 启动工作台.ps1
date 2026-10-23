param([switch]$NoBuild)
$ErrorActionPreference = 'Stop'
# 保留旧参数兼容已有快捷方式，日常启动统一打开桌面版。
$workbenchExe = Join-Path $PSScriptRoot '桌面版\工作台\工作台.exe'
if (-not (Test-Path -LiteralPath $workbenchExe -PathType Leaf)) { throw '尚未构建桌面版，请先按 README 的开发说明构建。' }
Start-Process -FilePath $workbenchExe -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
Write-Output '已打开桌面工作台。最小化留在任务栏，关闭窗口收进托盘；右键托盘选择“退出工作台”可彻底退出。'
