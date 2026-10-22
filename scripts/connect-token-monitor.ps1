Add-Type -AssemblyName System.Windows.Forms
$ErrorActionPreference = 'Stop'
$connectionRoot = Split-Path -Parent $PSScriptRoot
try {
    $answer = [System.Windows.Forms.MessageBox]::Show("本工具为工作台准备仅在本机使用的 Token Monitor 连接。`n`n请先退出工作台。接下来选择 Token Monitor.exe，然后按提示在 Token Monitor 里填写连接信息。已有连接会保留。", '连接 Token Monitor', 'OKCancel', 'Information')
    if ($answer -ne 'OK') { exit }
    $picker = New-Object System.Windows.Forms.OpenFileDialog
    $picker.Title = '选择已安装的 Token Monitor.exe'
    $picker.Filter = 'Token Monitor|Token Monitor.exe'
    $defaultFolder = Join-Path $env:LOCALAPPDATA 'Programs\Token Monitor'
    if (Test-Path -LiteralPath $defaultFolder) { $picker.InitialDirectory = $defaultFolder }
    if ($picker.ShowDialog() -ne 'OK') { exit }
    $runtime = Join-Path $connectionRoot '桌面版\工作台\resources\runtime\node.exe'
    if (-not (Test-Path -LiteralPath $runtime)) { $runtime = (Get-Command node.exe -ErrorAction Stop).Source }
    $configurationScript = Join-Path $PSScriptRoot 'configure-live-integrations.mjs'
    $lines = & $runtime $configurationScript --desktop $picker.FileName 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($lines -join "`n") }
    $result = ($lines -join "`n") | ConvertFrom-Json
    $form = New-Object System.Windows.Forms.Form
    $form.Text = '连接已准备好'; $form.Size = New-Object System.Drawing.Size(580, 320)
    $form.StartPosition = 'CenterScreen'; $form.FormBorderStyle = 'FixedDialog'; $form.MaximizeBox = $false
    $label = New-Object System.Windows.Forms.Label
    $label.Location = New-Object System.Drawing.Point(20, 20); $label.Size = New-Object System.Drawing.Size(530, 105)
    $label.Text = "1. 打开工作台，让本机连接服务开始运行。`n2. 打开 Token Monitor → 设置 → 多设备同步。`n3. 选择『连接已有 Hub』，填写下面的地址和连接密钥。`n4. 保存；如提示重启，请重启 Token Monitor。"
    $form.Controls.Add($label)
    $address = New-Object System.Windows.Forms.TextBox
    $address.Location = New-Object System.Drawing.Point(20, 135); $address.Width = 520
    $address.ReadOnly = $true; $address.Text = $result.baseUrl; $form.Controls.Add($address)
    $copyUrl = New-Object System.Windows.Forms.Button
    $copyUrl.Text = '复制地址'; $copyUrl.Location = New-Object System.Drawing.Point(20, 178); $copyUrl.Width = 120
    $copyUrl.Add_Click({ [System.Windows.Forms.Clipboard]::SetText($result.baseUrl) }); $form.Controls.Add($copyUrl)
    $copyKey = New-Object System.Windows.Forms.Button
    $copyKey.Text = '复制连接密钥'; $copyKey.Location = New-Object System.Drawing.Point(155, 178); $copyKey.Width = 140
    $copyKey.Add_Click({ [System.Windows.Forms.Clipboard]::SetText([IO.File]::ReadAllText($result.secretFile).Trim()) }); $form.Controls.Add($copyKey)
    $openApp = New-Object System.Windows.Forms.Button
    $openApp.Text = '打开 Token Monitor'; $openApp.Location = New-Object System.Drawing.Point(310, 178); $openApp.Width = 200
    $openApp.Add_Click({ Start-Process -FilePath $picker.FileName -WorkingDirectory (Split-Path -Parent $picker.FileName) | Out-Null }); $form.Controls.Add($openApp)
    $note = New-Object System.Windows.Forms.Label
    $note.Location = New-Object System.Drawing.Point(20, 225); $note.Size = New-Object System.Drawing.Size(520, 45)
    $note.Text = '密钥只保存在本机。粘贴后复制一段普通文字，替换剪贴板中的密钥。'
    $form.Controls.Add($note)
    [void]$form.ShowDialog()
} catch {
    [void][System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '连接尚未完成', 'OK', 'Warning')
    exit 1
}
