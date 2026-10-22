# SwitchBot Home

SwitchBot アカウントに登録された機器の状態確認・一括操作・シーン実行をブラウザから行う Web アプリです。

```
ブラウザ ──▶ React (web/src) ──/api──▶ FastAPI (web/api.py) ──署名付き──▶ api.switch-bot.com/v1.1
```

SwitchBot のシークレットで署名する必要があるため、ブラウザからは直接呼ばず、必ず FastAPI を経由します。

## 機能

- 機器一覧（物理機器 / 赤外線リモコン）と状態の表示
- 機器ごとの操作（ON/OFF、Bot の押す、カーテンの開閉、ロックの施錠・解錠）
- 手動シーンの実行
- レイアウトページ: ボタン・状態表示・グループを自由に配置
- スケジュールページ: 日付条件（毎日・平日・休日・曜日）と時間（例: 10:00 – 翌2:00）でシーンや機器を操作。外出予定の期間は対象のスケジュールを止める（実行は本番サーバーのみ）
- その日の SwitchBot API 呼び出し回数の表示（このサーバーから呼んだ分のみ）

## タスクトレイアプリ

`tray/` に、Windows のタスクトレイから本番の Web アプリ（コンパクト表示）を開く Tauri v2 のアプリがあります。

- 左クリックでトレイの上に小窓を出し、他の場所をクリックすると隠れます。起動中に実行ファイルを実行する（タスクバーにピン留めしたアイコンを押すなど）と、同じように開閉します。右クリックでメニュー（レイアウト・スケジュール・一覧・ブラウザで開く・Windows 起動時に開始・終了）。
- ビルド: `tray\build.ps1`（インストーラーは `~\.cargo-target\switchbot_home_tray\release\bundle\nsis\` にできる）
- 開発起動: `tray\dev.ps1`（`-Local` で手元の開発用サーバーを開く）
- リリース: `tray\release.ps1 0.2.0` のようにバージョンを指定すると、タグ `tray-v0.2.0` を push し、GitHub Actions がビルドしてインストーラーと実行ファイルを [Releases](https://github.com/swirhen/switchbot_home/releases) に置く
- 必要なもの: Rust（rustup）、Visual Studio Build Tools の「C++ によるデスクトップ開発」

## 設定

`config.example.json` をリポジトリ直下に `config.json` としてコピーし、値を入れます（Git 管理外）。

| キー | 内容 |
| --- | --- |
| `switchbot_token` / `switchbot_secret` | SwitchBot アプリの「開発者向けオプション」で取得するトークンとシークレット |
| `web_username` / `web_password` | 画面のログイン情報 |
| `web_secret` | ログイントークンの署名鍵（`openssl rand -hex 32` など）。変えると発行済みのログインは無効になる |

## ローカル開発（Windows）

```powershell
python -m venv $env:USERPROFILE\.venv\switchbot_home
& $env:USERPROFILE\.venv\switchbot_home\Scripts\python.exe -m pip install -r requirements.txt
cd web
npm install
```

リポジトリ直下で `.\start_debug.ps1`（または `start_debug.bat`）を実行すると、API（8002）と Vite（5175）を起動して `http://127.0.0.1:5175/` を開きます。Enter で両方停止します。

## 本番

- 配置先: `/home/swirhen/switchbot_home`（`prod-checker`）
- 公開 URL: `https://swirhen.tv/switchbot_home/`（Apache が `web/dist/` を配信し、`/switchbot_home/api/` を `127.0.0.1:8002` の API へ中継）
- API: systemd `switchbot-home-api.service`（`web/switchbot-home-api.service`）。venv は `web/.venv`
- Apache 設定: dotfile リポジトリの `apache2/sites-available/000-default.conf`（`/torrent-admin/` と同じ書き方で `/switchbot_home/` を追記）を `/etc/apache2/sites-available/` に反映する
- Git 管理外のファイル（`config.json`、`web/layout.json`、`web/ir_state.json`）は手元から `scp` で送る

### 初期導入

```bash
cd /home/swirhen
git clone git@github.com:swirhen/switchbot_home.git
cd switchbot_home
python3 -m venv web/.venv
web/.venv/bin/pip install -r requirements.txt
cd web
npm ci
sudo install -m 0644 switchbot-home-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now switchbot-home-api.service
# Apache は dotfile の 000-default.conf を反映してから
sudo apachectl configtest && sudo systemctl reload apache2
./release.sh
```

### 更新のリリース

```bash
cd /home/swirhen/switchbot_home && git pull --ff-only && cd web && ./release.sh
```
