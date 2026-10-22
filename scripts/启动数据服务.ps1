param([string]$OwnerId = '')
$ErrorActionPreference = 'Stop'
$integrationRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $integrationRoot 'config\local.json'))) { exit 0 }
$integrationSettings = Get-Content -LiteralPath (Join-Path $integrationRoot 'config\local.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$integrationData = Join-Path $integrationRoot 'data\integrations'
$integrationNode = if ($env:WORKBENCH_NODE) { $env:WORKBENCH_NODE } else { (Get-Command node.exe).Source }
function Start-OwnedService($name, $exe, $arguments, $identity, $port) {
    $recordFile = Join-Path $integrationData ($name + '-process.json')
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
    if (-not $listeners.Count -and (Test-Path -LiteralPath $recordFile)) {
        $record = Get-Content -LiteralPath $recordFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$record.pid)" -ErrorAction SilentlyContinue
        if ($process) {
            if ($record.root -ne $integrationRoot -or $process.ExecutablePath -ne $exe -or -not $process.CommandLine.Contains($identity) -or $process.CreationDate.ToUniversalTime().ToString('o') -ne $record.created) { throw "数据服务 $name 的进程身份不匹配。" }
            return # Existing owned service may still be indexing before listening.
        }
    }
    if ($listeners.Count) {
        if (-not (Test-Path -LiteralPath $recordFile)) { throw "数据服务端口 $port 被占用，未接管未知进程。" }
        $record = Get-Content -LiteralPath $recordFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$record.pid)" -ErrorAction SilentlyContinue
        if (-not $process -or $record.root -ne $integrationRoot -or $process.ExecutablePath -ne $exe -or -not $process.CommandLine.Contains($identity) -or $process.CreationDate.ToUniversalTime().ToString('o') -ne $record.created -or @($listeners | Where-Object { $_.OwningProcess -ne $record.pid -or $_.LocalAddress -ne '127.0.0.1' }).Count) { throw "数据服务 $name 的身份或监听地址不匹配。" }
        return
    }
    $logDir = Join-Path $integrationData 'logs'; New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $child = Start-Process -FilePath $exe -ArgumentList $arguments -WorkingDirectory $integrationRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir ($name + '.log')) -RedirectStandardError (Join-Path $logDir ($name + '-error.log')) -PassThru
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($child.Id)"
    @{ owner=$OwnerId; pid=$child.Id; root=$integrationRoot; exe=$exe; identity=$identity; created=$process.CreationDate.ToUniversalTime().ToString('o'); port=$port } | ConvertTo-Json | Set-Content -LiteralPath $recordFile -Encoding UTF8
}
if ($integrationSettings.integrations.tokenMonitor.managed) {
    $entry = Join-Path $integrationRoot 'scripts\token-monitor-hub.cjs'
    Start-OwnedService 'token-monitor' $integrationNode @(('"' + $entry + '"')) $entry ([uri]$integrationSettings.integrations.tokenMonitor.baseUrl).Port
    $desktop = $integrationSettings.integrations.tokenMonitor.desktopExe
    if ($desktop -and -not @(Get-CimInstance Win32_Process -Filter "Name = 'Token Monitor.exe'" | Where-Object { $_.ExecutablePath -eq $desktop }).Count) {
        $previousSecret = $env:TOKEN_MONITOR_SECRET
        try {
            $env:TOKEN_MONITOR_SECRET = [IO.File]::ReadAllText((Join-Path $integrationRoot $integrationSettings.integrations.tokenMonitor.secretFile)).Trim()
            Start-Process -FilePath $desktop -WorkingDirectory (Split-Path -Parent $desktop) -WindowStyle Hidden | Out-Null
        } finally { $env:TOKEN_MONITOR_SECRET = $previousSecret }
    }
}
if ($integrationSettings.integrations.agentsView.managed) {
    $previousData = $env:AGENTSVIEW_DATA_DIR; $previousAuth = $env:AGENTSVIEW_AUTH_TOKEN; $previousTelemetry = $env:AGENTSVIEW_TELEMETRY_ENABLED
    try {
        $env:AGENTSVIEW_DATA_DIR = Join-Path $integrationData 'agentsview\state'
        $env:AGENTSVIEW_AUTH_TOKEN = [IO.File]::ReadAllText((Join-Path $integrationRoot $integrationSettings.integrations.agentsView.secretFile)).Trim()
        $env:AGENTSVIEW_TELEMETRY_ENABLED = '0'
        $exe = Join-Path $integrationData 'agentsview\bin\agentsview.exe'
        $port = ([uri]$integrationSettings.integrations.agentsView.baseUrl).Port
        Start-OwnedService 'agentsview' $exe @('serve','--host','127.0.0.1','--port',"$port",'--no-browser','--no-update-check','--require-auth') 'serve --host 127.0.0.1' $port
    } finally { $env:AGENTSVIEW_DATA_DIR=$previousData; $env:AGENTSVIEW_AUTH_TOKEN=$previousAuth; $env:AGENTSVIEW_TELEMETRY_ENABLED=$previousTelemetry }
}
Write-Output '本机额度转接与执行记录服务已启动；首次整理记录可能需要一些时间。'
