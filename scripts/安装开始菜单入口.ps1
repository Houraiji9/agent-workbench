$ErrorActionPreference = 'Stop'
$desktopProject = Split-Path -Parent $PSScriptRoot
$desktopExe = Join-Path $desktopProject '桌面版\工作台\工作台.exe'
if (-not (Test-Path -LiteralPath $desktopExe)) { throw '请先构建桌面版。' }
$desktopPrograms = [Environment]::GetFolderPath('Programs')
$desktopShortcutPath = Join-Path $desktopPrograms 'Agent 工作台.lnk'
$desktopShell = New-Object -ComObject WScript.Shell
$desktopShortcut = $desktopShell.CreateShortcut($desktopShortcutPath)
if ((Test-Path -LiteralPath $desktopShortcutPath) -and $desktopShortcut.TargetPath -and $desktopShortcut.TargetPath -ne $desktopExe) { throw '已有同名入口指向其他程序，未覆盖。' }
$desktopShortcut.TargetPath = $desktopExe
$desktopShortcut.WorkingDirectory = $desktopProject
$desktopShortcut.IconLocation = $desktopExe + ',0'
$desktopShortcut.Description = '项目、任务与 Agent 工作台；最小化到托盘，关闭退出。'
$desktopShortcut.Save()
$desktopVerify = $desktopShell.CreateShortcut($desktopShortcutPath)
if ($desktopVerify.TargetPath -ne $desktopExe) { throw '快捷方式写入验证失败。' }
Write-Output ('开始菜单入口已创建：' + $desktopShortcutPath)
Write-Output '可在开始菜单搜索 Agent 工作台。需要固定时，右键搜索结果并选择“固定到开始屏幕”。此脚本没有执行固定。'
