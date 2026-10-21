<#
.SYNOPSIS
    SwitchBot Home ローカルデバッグ環境一括起動スクリプト
.DESCRIPTION
    FastAPI (Uvicorn) と Vite 開発サーバーを起動し、ブラウザで管理画面を開きます。
    Enter キーまたは Ctrl+C で両方のサーバーを安全に終了します。
#>

[CmdletBinding()]
param (
    [Alias("nb")]
    [switch]$NoBrowser,     # ブラウザを自動で開かない
    [Alias("m")]
    [switch]$Minimized      # API / Vite のウィンドウを最小化で起動する
)

$ErrorActionPreference = "Stop"

# 出力文字コード設定
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$rootDir = $PSScriptRoot
$webDir = Join-Path $rootDir "web"

if (-not (Test-Path $webDir)) {
    Write-Error "web ディレクトリが見つかりません: $webDir"
    exit 1
}

# Node.js PATHの補完
if ($env:Path -notlike "*C:\Program Files\nodejs*") {
    $env:Path = "C:\Program Files\nodejs;$env:Path"
}

# Python実行パスの検出 (~\.venv\switchbot_home があれば優先)
# OneDrive でソースを PC 間共有するため、venv はリポジトリ外に PC ごとに作る
$venvDir = Join-Path $env:USERPROFILE ".venv\switchbot_home"
$pythonCmd = "python"
if (Test-Path (Join-Path $venvDir "Scripts\python.exe")) {
    $pythonCmd = (Join-Path $venvDir "Scripts\python.exe")
} else {
    Write-Host "[警告] $venvDir が見つかりません。システムの python を使用します。" -ForegroundColor Yellow
    Write-Host "       作成手順: python -m venv `"$venvDir`"; & `"$venvDir\Scripts\python.exe`" -m pip install -r requirements.txt" -ForegroundColor Yellow
}

# PowerShell実行ファイルの検出
$psExe = if (Get-Command pwsh.exe -ErrorAction SilentlyContinue) { "pwsh.exe" } else { "powershell.exe" }

# ポート占有プロセスの停止関数
function Stop-PortProcess {
    param([int]$Port)
    $conns = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
    if ($conns) {
        $pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
        foreach ($p in $pids) {
            if ($p -gt 0 -and (Get-Process -Id $p -ErrorAction SilentlyContinue)) {
                Write-Host "ポート $Port を使用中のプロセス (PID: $p) を停止しています..." -ForegroundColor Yellow
                try {
                    taskkill.exe /pid $p /T /F *>$null
                } catch {}
            }
        }
    }
}

# ポートLISTEN待機関数
function Wait-Port {
    param([int]$Port, [int]$TimeoutSeconds = 20)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
        $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        if ($conn) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "   SwitchBot Home ローカルデバッグ環境の起動準備" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

# 1. 既存プロセスの解放チェック
Stop-PortProcess 8001
Stop-PortProcess 5174

$windowStyle = if ($Minimized) { "Minimized" } else { "Normal" }

# 2. API サーバー (FastAPI / Uvicorn) 起動
Write-Host "[1/2] API サーバー (FastAPI/Uvicorn) を起動中..." -ForegroundColor Green
$apiScript = "`$Host.UI.RawUI.WindowTitle = 'SwitchBot Home - Backend API (Port 8001)'; Set-Location '$webDir'; & '$pythonCmd' -m uvicorn api:app --reload --host 127.0.0.1 --port 8001"
$apiProcess = Start-Process $psExe -ArgumentList "-NoExit", "-Command", $apiScript -WindowStyle $windowStyle -PassThru

# 3. フロントエンド開発サーバー (Vite) 起動
Write-Host "[2/2] フロントエンド (Vite) を起動中..." -ForegroundColor Green
$viteScript = "`$Host.UI.RawUI.WindowTitle = 'SwitchBot Home - Frontend Vite (Port 5174)'; Set-Location '$webDir'; npm.cmd run dev"
$viteProcess = Start-Process $psExe -ArgumentList "-NoExit", "-Command", $viteScript -WindowStyle $windowStyle -PassThru

# 4. サーバーの起動待機
Write-Host "サーバーの起動を待機しています..." -ForegroundColor Gray
$apiReady = Wait-Port 8001
$viteReady = Wait-Port 5174

if (-not $apiReady) {
    Write-Host "[警告] API サーバー (ポート 8001) の応答待機がタイムアウトしました。ログウィンドウを確認してください。" -ForegroundColor Yellow
}
if (-not $viteReady) {
    Write-Host "[警告] Vite サーバー (ポート 5174) の応答待機がタイムアウトしました。ログウィンドウを確認してください。" -ForegroundColor Yellow
}

# 5. ブラウザ起動
$appUrl = "http://127.0.0.1:5174/"
if (-not $NoBrowser -and $viteReady) {
    Write-Host "ブラウザを起動しています: $appUrl" -ForegroundColor Cyan
    Start-Process $appUrl
}

# 6. 稼働状態表示
Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "   SwitchBot Home ローカルデバッグ環境が稼働中です" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  [API Server]  http://127.0.0.1:8001/api/health" -ForegroundColor White
Write-Host "  [Web UI]      $appUrl" -ForegroundColor White
Write-Host "  [API PID]     $($apiProcess.Id)" -ForegroundColor DarkGray
Write-Host "  [Vite PID]    $($viteProcess.Id)" -ForegroundColor DarkGray
Write-Host "------------------------------------------------------------" -ForegroundColor Green
Write-Host "  [Enter] キーを押すと、すべてのデバッグサーバーを終了します。" -ForegroundColor Yellow
Write-Host "============================================================" -ForegroundColor Green

# 7. 終了待機とクリーンアップ
try {
    [void][System.Console]::ReadLine()
}
finally {
    Write-Host ""
    Write-Host "デバッグ環境を停止しています..." -ForegroundColor Yellow

    if ($apiProcess -and -not $apiProcess.HasExited) {
        try {
            taskkill.exe /pid $apiProcess.Id /T /F *>$null
        }
        catch {
            # 停止済み等の例外は無視
        }
    }

    if ($viteProcess -and -not $viteProcess.HasExited) {
        try {
            taskkill.exe /pid $viteProcess.Id /T /F *>$null
        }
        catch {
            # 停止済み等の例外は無視
        }
    }

    Stop-PortProcess 8001
    Stop-PortProcess 5174
    Write-Host "デバッグ環境を正常に終了しました。" -ForegroundColor Green
}
