<#
  给 OpenChat 配开机自启（Windows 计划任务）。

  装：  powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
  删：  powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Remove

  前提：先跑过 npm run build，node 在 PATH 里。
  任务名默认 OpenChat；登录这个账户就拉起，进程挂了 1 分钟后自动重试。
#>

param(
  [switch]$Remove,
  [string]$Repo = "D:\DSH\OpenChat",
  [string]$TaskName = "OpenChat"
)

$ErrorActionPreference = 'Stop'

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "已删除计划任务 '$TaskName'"
  exit 0
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "PATH 里找不到 node，先装 Node 或把它加进 PATH" }

$entry = Join-Path $Repo 'apps\server\dist\index.js'
if (-not (Test-Path $entry)) {
  throw "还没构建：cd $Repo; npm run build"
}

$dataDir = Join-Path $Repo 'data'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$log = Join-Path $dataDir 'server.log'

$inner = "Set-Location -LiteralPath '$Repo'; & '$node' '$entry' *>> '$log'"
$argument = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "' + $inner + '"'

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal `
  -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive `
  -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Force | Out-Null

Write-Host "装好了：计划任务 '$TaskName'"
Write-Host "  登录后启动：$node $entry"
Write-Host "  日志：$log"
Write-Host "  手动跑一次：Start-ScheduledTask -TaskName '$TaskName'"
