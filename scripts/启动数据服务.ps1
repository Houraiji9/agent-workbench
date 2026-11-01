param([string]$OwnerId = '')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$integrationRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $integrationRoot 'config\local.json'))) { exit 0 }
$integrationSettings = Get-Content -LiteralPath (Join-Path $integrationRoot 'config\local.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$integrationDataRoot = if ($env:WORKBENCH_DATA_DIR) { $env:WORKBENCH_DATA_DIR } else { Join-Path $integrationRoot 'data' }
$integrationData = Join-Path $integrationDataRoot 'integrations'
function Write-OwnedJson($file, $value) {
    $tempFile = $file + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    $value | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $tempFile -Encoding UTF8
    Move-Item -LiteralPath $tempFile -Destination $file -Force
}
function Start-OwnedService($name, $exe, $arguments, $identity, $port) {
    $recordFile = Join-Path $integrationData ($name + '-process.json')
    $listenerErrors = @()
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue -ErrorVariable listenerErrors)
    if (@($listenerErrors | Where-Object { $_.CategoryInfo.Category -ne 'ObjectNotFound' }).Count) { throw "数据服务 $name 的监听状态无法确认，未尝试启动。" }
    $record = $null; $process = $null
    if (Test-Path -LiteralPath $recordFile) {
        $record = Get-Content -LiteralPath $recordFile -Raw -Encoding UTF8 | ConvertFrom-Json
        # Validate persisted identity even when its former PID no longer exists.
        if ($record.root -ne $integrationRoot -or $record.exe -ne $exe -or $record.identity -ne $identity -or $record.port -ne $port -or [int]$record.pid -le 0) { throw "数据服务 $name 的记录身份不匹配。" }
        $created = [DateTimeOffset]::Parse([string]$record.created).UtcTicks
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$record.pid)" -ErrorAction Stop
        if ($process) {
            if ($process.ExecutablePath -ne $exe -or -not $process.CommandLine -or -not $process.CommandLine.Contains($identity) -or $process.CreationDate.ToUniversalTime().Ticks -ne $created) { throw "数据服务 $name 的进程身份不匹配。" }
        }
    }
    if ($listeners.Count) {
        if (-not $process -or @($listeners | Where-Object { $_.OwningProcess -ne $record.pid -or $_.LocalAddress -ne '127.0.0.1' }).Count) { throw "数据服务 $name 的身份或监听地址不匹配，未接管端口 $port。" }
    }
    if ($process) {
        # A live service can still be indexing. Never kill, relaunch or claim it.
        $state = if ($listeners.Count) { '运行中' } else { '准备中，保留现有进程' }
        $ownership = if ($record.owner -eq $OwnerId) { '本次服务' } else { '已有服务，未接管' }
        Write-Output ($name + ': ' + $ownership + '；' + $state)
        return
    }
    $logDir = Join-Path $integrationData 'logs'; New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $budgetFile = Join-Path $integrationData ($name + '-recovery.json')
    $now = [DateTimeOffset]::UtcNow
    $attempts = @()
    if (Test-Path -LiteralPath $budgetFile) {
        $budget = Get-Content -LiteralPath $budgetFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($budget.root -ne $integrationRoot -or $budget.exe -ne $exe -or $budget.port -ne $port) { throw "数据服务 $name 的恢复记录身份不匹配。" }
        $attempts = @($budget.attempts | Where-Object { [DateTimeOffset]::Parse([string]$_) -gt $now.AddMinutes(-5) })
    }
    if ($attempts.Count -ge 3) { throw "数据服务 $name 已达到 5 分钟最多 3 次启动的恢复上限，等待冷却。" }
    # Count failed launches too. Each invocation shares this budget.
    Write-OwnedJson $budgetFile @{root=$integrationRoot; exe=$exe; port=$port; attempts=@($attempts) + @($now.ToString('o'))}
    $logId = $name + '-' + $now.UtcDateTime.ToString('yyyyMMddTHHmmssfff') + '-' + [guid]::NewGuid().ToString('N')
    $child = Start-Process -FilePath $exe -ArgumentList $arguments -WorkingDirectory $integrationRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir ($logId + '.log')) -RedirectStandardError (Join-Path $logDir ($logId + '-error.log')) -PassThru
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($child.Id)"
    if (-not $process -or $process.ExecutablePath -ne $exe -or -not $process.CommandLine -or -not $process.CommandLine.Contains($identity)) { throw "数据服务 $name 启动后身份无法确认，未记录为运行成功。" }
    $previousOwner = if ($record) { $record.owner } else { $null }
    Write-OwnedJson $recordFile @{ owner=$OwnerId; previousOwner=$previousOwner; pid=$child.Id; root=$integrationRoot; exe=$exe; identity=$identity; created=$process.CreationDate.ToUniversalTime().ToString('o'); port=$port; stdout=($logId + '.log'); stderr=($logId + '-error.log') }
    @{at=$now.ToString('o'); event='service_started'; name=$name; owner=$OwnerId; previousOwner=$previousOwner; previousPid=$(if ($record) { $record.pid } else { $null }); pid=$child.Id; stdout=($logId + '.log'); stderr=($logId + '-error.log')} | ConvertTo-Json -Compress | Add-Content -LiteralPath (Join-Path $integrationData 'service-lifecycle.jsonl') -Encoding UTF8
    Write-Output ($name + ': 已启动；首次整理记录可能需要一些时间')
}
$failures = @()
if ($integrationSettings.integrations.tokenMonitor.managed) {
    try {
        $integrationNode = if ($env:WORKBENCH_NODE) { $env:WORKBENCH_NODE } else { (Get-Command node.exe -ErrorAction Stop).Source }
        $entry = Join-Path $integrationRoot 'scripts\token-monitor-hub.cjs'
        Start-OwnedService 'token-monitor' $integrationNode @(('"' + $entry + '"')) $entry ([uri]$integrationSettings.integrations.tokenMonitor.baseUrl).Port
    } catch { $failures += 'token-monitor: ' + $_.Exception.Message }
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
    } catch { $failures += 'agentsview: ' + $_.Exception.Message }
    finally { $env:AGENTSVIEW_DATA_DIR=$previousData; $env:AGENTSVIEW_AUTH_TOKEN=$previousAuth; $env:AGENTSVIEW_TELEMETRY_ENABLED=$previousTelemetry }
}
if ($failures.Count) { [Console]::Error.WriteLine(($failures -join [Environment]::NewLine)); exit 1 }
