param([string]$OwnerId = '')
$ErrorActionPreference = 'Stop'
$integrationRoot = Split-Path -Parent $PSScriptRoot
foreach ($name in @('token-monitor','agentsview')) {
    $recordFile = Join-Path $integrationRoot ('data\integrations\' + $name + '-process.json')
    if (-not (Test-Path -LiteralPath $recordFile)) { continue }
    $record = Get-Content -LiteralPath $recordFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($OwnerId -and $record.owner -ne $OwnerId) { continue }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$record.pid)" -ErrorAction SilentlyContinue
    if ($process) {
        if ($record.root -ne $integrationRoot -or $process.ExecutablePath -ne $record.exe -or -not $process.CommandLine.Contains($record.identity) -or $process.CreationDate.ToUniversalTime().ToString('o') -ne $record.created) { throw "拒绝停止身份不匹配的数据服务 $name。" }
        Stop-Process -Id $process.ProcessId -ErrorAction Stop
    }
    Remove-Item -LiteralPath $recordFile
}
Write-Output '本项目的数据服务已停止；Token Monitor 桌面应用继续保留。'
