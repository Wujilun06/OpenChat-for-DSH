<#
  装语音转写环境：venv + sherpa-onnx + SenseVoice 模型（约 900MB 的包，装完 230MB int8 在用）。

  装：  powershell -ExecutionPolicy Bypass -File scripts\install-asr.ps1
  重下：powershell -ExecutionPolicy Bypass -File scripts\install-asr.ps1 -Force

  装完的东西都在 runtime\asr\ 里（不进 git）。
  模型优先从 GitHub release 下（hf-mirror 会跳到解析不了的 cas-bridge，所以放备用）。
#>

param(
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$asr = Join-Path $root 'runtime\asr'
$venv = Join-Path $asr '.venv'
$py = Join-Path $venv 'Scripts\python.exe'
$modelName = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17'
$modelsDir = Join-Path $asr 'models'
$modelDir = Join-Path $modelsDir $modelName
$modelFile = Join-Path $modelDir 'model.int8.onnx'
$tokensFile = Join-Path $modelDir 'tokens.txt'
$script = Join-Path $root 'asr\asr_cli.py'
$tarFile = Join-Path $asr 'sense-voice.tar.bz2'
$github = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2'

New-Item -ItemType Directory -Force -Path $asr, $modelsDir | Out-Null

if (-not (Test-Path $py)) {
  Write-Host '创建 venv…'
  python -m venv $venv
}

Write-Host '装 Python 依赖…'
& $py -m pip install --disable-pip-version-check --quiet `
  --index-url https://pypi.tuna.tsinghua.edu.cn/simple `
  sherpa-onnx numpy
if ($LASTEXITCODE -ne 0) { throw 'pip 装依赖失败' }

if ($Force -or -not (Test-Path $modelFile) -or -not (Test-Path $tokensFile)) {
  if (-not (Test-Path $tarFile) -or $Force) {
    Write-Host '从 GitHub 下模型包（约 900MB，慢慢等）…'
    curl.exe -L --fail --retry 3 --retry-delay 5 -o $tarFile $github
    if ($LASTEXITCODE -ne 0) { throw '模型包下载失败' }
  }

  Write-Host '解压…'
  tar.exe -xjf $tarFile -C $modelsDir
  if ($LASTEXITCODE -ne 0) { throw '解压失败' }
  Remove-Item $tarFile -Force

  if (-not (Test-Path $modelFile)) {
    Write-Host 'GitHub 这条路不行，试 hf-mirror 单个文件…'
    $base = "https://hf-mirror.com/csukuangfj/$modelName/resolve/main"
    curl.exe -L --fail --retry 2 -o $modelFile "$base/model.int8.onnx"
    if ($LASTEXITCODE -ne 0) { throw '模型文件下载失败' }
    curl.exe -L --fail --retry 2 -o $tokensFile "$base/tokens.txt"
    if ($LASTEXITCODE -ne 0) { throw 'tokens 下载失败' }
  }
}

Write-Host '自检（加载模型）…'
& $py $script --self-check --model-dir $modelDir
if ($LASTEXITCODE -ne 0) { throw '自检失败' }

Write-Host "装好了：$modelDir"
