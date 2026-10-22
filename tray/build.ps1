<#
.SYNOPSIS
    SwitchBot Home Tray をビルドしてインストーラー（NSIS）を作る
.DESCRIPTION
    ビルド結果は OneDrive の同期対象から外すため、リポジトリの外（~\.cargo-target\switchbot_home_tray）に出す。
    インストーラーは <ビルド先>\release\bundle\nsis\ にできる。
#>
# npm や cargo は情報メッセージも標準エラーに出すので、Stop にすると途中で止まる。成否は終了コードで見る
$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location $PSScriptRoot
$env:Path = "$env:USERPROFILE\.cargo\bin;C:\Program Files\nodejs;$env:Path"
$env:CARGO_TARGET_DIR = Join-Path $env:USERPROFILE ".cargo-target\switchbot_home_tray"
if (-not (Test-Path "node_modules")) { npm.cmd install }
npm.cmd run tauri build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host ""
Write-Host "インストーラー: $env:CARGO_TARGET_DIR\release\bundle\nsis\" -ForegroundColor Green
