<#
.SYNOPSIS
    SwitchBot Home Tray を開発用に起動する（Ctrl+C で終了）
.DESCRIPTION
    ビルド結果は build.ps1 と同じくリポジトリの外に出す。
    -Local を付けると、本番ではなく手元の開発用サーバー（start_debug.ps1 で起動した http://127.0.0.1:5175/）を開く。
#>
param([switch]$Local)
# npm や cargo は情報メッセージも標準エラーに出すので、Stop にすると途中で止まる。成否は終了コードで見る
$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location $PSScriptRoot
$env:Path = "$env:USERPROFILE\.cargo\bin;C:\Program Files\nodejs;$env:Path"
$env:CARGO_TARGET_DIR = Join-Path $env:USERPROFILE ".cargo-target\switchbot_home_tray"
if ($Local) { $env:SWITCHBOT_HOME_URL = "http://127.0.0.1:5175/" }
if (-not (Test-Path "node_modules")) { npm.cmd install }
npm.cmd run tauri dev
