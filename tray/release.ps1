<#
.SYNOPSIS
    SwitchBot Home Tray のリリースを GitHub で作る（バージョン更新・コミット・タグ付け・push）
.DESCRIPTION
    tauri.conf.json / Cargo.toml / Cargo.lock のバージョンを書き換えてコミットし、タグ tray-v<バージョン> を push する。
    ビルドとリリースの作成は GitHub Actions（.github/workflows/tray-release.yml）が行う。
    バージョンが既に同じなら、コミットせずにタグだけ付ける。
.EXAMPLE
    .\release.ps1 0.2.0
#>
param([Parameter(Mandatory)][string]$Version)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location $PSScriptRoot

# git は情報メッセージも標準エラーに出すので、成否は終了コードで見る
function Invoke-Git {
    $ErrorActionPreference = "Continue"
    & git @args
    if ($LASTEXITCODE -ne 0) { throw "git $args に失敗した" }
}

if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "バージョンは 1.2.3 の形で指定する: $Version" }
$tag = "tray-v$Version"

if (Invoke-Git status --porcelain) { throw "未コミットの変更がある。先にコミットするか退避する" }
$branch = Invoke-Git rev-parse --abbrev-ref HEAD
if ($branch -ne "main") { throw "main ブランチで実行する（現在: $branch）" }
Invoke-Git fetch --tags origin
if (Invoke-Git rev-list HEAD..origin/main) { throw "origin/main より古い。先に pull する" }
if (Invoke-Git tag --list $tag) { throw "タグ $tag は既にある" }

# 書式を崩さないよう、該当箇所だけを置き換える（BOM なし UTF-8 で保存）
function Set-Version([string]$path, [string]$pattern) {
    $text = [IO.File]::ReadAllText((Resolve-Path $path))
    $regex = [regex]::new($pattern, [Text.RegularExpressions.RegexOptions]::Multiline)
    if (-not $regex.IsMatch($text)) { throw "$path にバージョンが見つからない" }
    $text = $regex.Replace($text, "`${1}$Version`${2}", 1)
    [IO.File]::WriteAllText((Resolve-Path $path), $text, (New-Object Text.UTF8Encoding $false))
}
Set-Version "src-tauri/tauri.conf.json" '^(\s*"version": ")[^"]+(")'
Set-Version "src-tauri/Cargo.toml" '^(version = ")[^"]+(")'
Set-Version "src-tauri/Cargo.lock" '(name = "switchbot-home-tray"\r?\nversion = ")[^"]+(")'

if (Invoke-Git status --porcelain) {
    Invoke-Git add src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
    Invoke-Git commit -m "Change: トレイアプリのバージョンを $Version にする"
}
Invoke-Git tag $tag
Invoke-Git push origin main
Invoke-Git push origin $tag

Write-Host ""
Write-Host "タグ $tag を push した。ビルドの進み具合: https://github.com/swirhen/switchbot_home/actions" -ForegroundColor Green
