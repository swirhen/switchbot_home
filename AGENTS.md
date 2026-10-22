# AI開発エージェント向け運用ルール

## プロジェクト概要

- SwitchBot API v1.1 を使い、アカウントに登録された機器の状態確認・一括操作・シーン実行を行う Web アプリ。
- 構成は FastAPI（`web/api.py`）+ React/Vite（`web/src/`）。
- API 仕様の一次情報: https://github.com/OpenWonderLabs/SwitchBotAPI （機器別の詳細は `devices/<カテゴリ>/*.md`）

## 主なファイル

- `switchbot_client.py`: SwitchBot API の署名生成と呼び出し、1日の呼び出し回数カウント。
- `web/api.py`: ログイン認証、機器一覧・状態（キャッシュ付き）、コマンド送信、一括操作、シーン実行。
- `web/src/main.tsx`: ログイン画面、一覧ページ（`#/`）、ハッシュによるページ切り替え。
- `web/src/layout.tsx`: レイアウトページ（`#/layout/<名前 または id>`、複数持てる。名前は重複不可）。機器・シーンのボタンや状態表示をキャンバスに置き、ドラッグで移動・リサイズする。
- `web/src/common.tsx`: API 呼び出し、型、ヘッダー、状態表示など共通部品。機器タイプごとの操作ボタンは `deviceActions()` で決める。
- `web/src/schedule.tsx`: スケジュールページ（`#/schedule`）。スケジュールと外出予定の表、追加・編集フォーム。
- `web/scheduler.py`: スケジュールの判定（日付条件・翌日にまたがる時間・外出予定・祝日は `jpholiday`）と、毎分の実行ループ。
- `web/schedules.json` / `web/schedule_state.json`: スケジュールと外出予定、最終実行の記録（Git 管理外）。
- `web/layout.json`: レイアウトページの配置（`{"layouts": [{"id", "name", "widgets"}]}`、Git 管理外。画面の編集内容が自動保存される。旧形式の `{"widgets"}` は 1 つ目のレイアウトとして読む）。
- `config.json`: SwitchBot のトークン/シークレットと画面のログイン情報（Git 管理外。雛形は `config.example.json`）。環境変数 `SWITCHBOT_TOKEN` / `SWITCHBOT_SECRET` / `SWITCHBOT_HOME_USERNAME` / `SWITCHBOT_HOME_PASSWORD` / `SWITCHBOT_HOME_SECRET` があればそちらを優先する。
- `web/ir_state.json`: 赤外線リモコンに最後に送ったコマンドの記録（Git 管理外）。

## API 利用上の注意

- SwitchBot API は 1日 10,000 回まで。機器一覧・シーンは 10 分、状態は 30 秒キャッシュしている。ポーリングを増やすときは回数に注意する。
- 赤外線リモコンは状態を取得できない。オートメーション（スケジュール等）は API から取得・登録できない。
- `config.json` の値は表示・コミットしない。
- ログインは失敗回数で制限している（同じ接続元で 15 分に 5 回、全体で 15 分に 30 回を超えると 429）。記録はメモリ上だけで、API を再起動すると消える。接続元 IP は、uvicorn が Apache（127.0.0.1）から受け取った `X-Forwarded-For` で判断する。
- スケジューラーは環境変数 `SWITCHBOT_HOME_SCHEDULER=1`（または `config.json` の `scheduler_enabled: true`）のサーバーでだけ動く。本番は systemd 定義で有効にしている。手元で有効にすると本番と二重に実行されるので、確認するときは本番の予定と重ならないようにする。

## 開発と検証

- Python の venv はリポジトリ外の `~\.venv\switchbot_home` に PC ごとに作る（ソースは OneDrive で PC 間共有するため）。
  作成: `python -m venv $env:USERPROFILE\.venv\switchbot_home; & $env:USERPROFILE\.venv\switchbot_home\Scripts\python.exe -m pip install -r requirements.txt`
- Python 変更後は `python -m py_compile switchbot_client.py web/api.py` を実行する。
- フロントエンド変更後は `cd web; npm.cmd run build` を実行する。
- ローカル一括起動は `.\start_debug.ps1`（または `start_debug.bat`）。画面は `http://127.0.0.1:5175/`、API は `http://127.0.0.1:8002`（torrentsearch（8000/5173）・radio_record（8001/5174）と衝突しないようにずらしている）。

## 本番リリース

- 配置先は `prod-checker` の `/home/swirhen/switchbot_home`、公開 URL は `https://swirhen.tv/switchbot_home/`。
- SSH は `projects\config` を使う（`ssh -F ..\config -o BatchMode=yes prod-checker ...`）。
- GitHub へプッシュした後、`ssh -F ..\config prod-checker "cd /home/swirhen/switchbot_home && git pull --ff-only && cd web && ./release.sh"` で更新・ビルド・API 再起動を行う。
- 実行後、`ssh -F ..\config prod-checker "systemctl is-active switchbot-home-api.service"` で `active` を確認する。
- `release.sh` は `VITE_BASE_PATH=/switchbot_home/` でビルドする。

## タスクトレイアプリ（`tray/`）

- Tauri v2 製。窓は本番の Web アプリのコンパクト表示（`https://swirhen.tv/switchbot_home/?compact#/layout`）を直接開くだけで、画面や処理は Web 側にある。トレイアプリだけの変更は本番サーバーへのリリース不要。
- `tray/src-tauri/src/main.rs`: トレイアイコン（左クリックで窓の開閉、右クリックでメニュー）、窓の外をクリックで隠す、多重起動防止、自動起動。
- 起動中に実行ファイルがもう一度実行される（タスクバーにピン留めしたアイコンなど）と、窓を開閉する。アイコンを押した時点で窓は前面でなくなり隠れるため、1 秒以内に隠れたばかりなら開いていたものとして開き直さない。起動した側は `AllowSetForegroundWindow` で前面に出す権利を動いている側に渡してから終わる。
- 実行ファイルから開いたときは、マウスカーソルのある画面に出す（複数画面で、クリックしたタスクバーの画面に出すため）。カーソルがタスクバーの上ならその真上、画面の中なら作業領域の右下。トレイアイコンやメニューから開いたときはトレイの上。
- 窓は枠なしで、縁のリサイズは Tauri が置く子ウインドウが受ける。縁をつかむと WebView のフォーカスが外れて `Focused(false)` が来るため、すぐには隠さず、他のウインドウが前面に来た（`GetForegroundWindow`）ときに隠す。
- ビルドは `tray\build.ps1`（インストーラーを作る）、開発起動は `tray\dev.ps1`（`-Local` で手元の `http://127.0.0.1:5175/` を開く）。
- Rust のビルド結果は OneDrive の同期と日本語パスを避けるため、`CARGO_TARGET_DIR` で `~\.cargo-target\switchbot_home_tray` に出す（スクリプトが設定する）。直接 `cargo` を使うときも同じ環境変数を付ける。
- 必要なもの: Rust（rustup）、Visual Studio Build Tools の「C++ によるデスクトップ開発」、WebView2（Windows 11 は標準）。
- GitHub でのリリース: `tray\release.ps1 <バージョン>`（例: `0.2.0`）で `tauri.conf.json` / `Cargo.toml` / `Cargo.lock` のバージョンを書き換えてコミットし、タグ `tray-v<バージョン>` を push する。タグの push で `.github/workflows/tray-release.yml` が Windows 上でビルドし、インストーラー（`SwitchBotHomeTray_<バージョン>_x64-setup.exe`）と実行ファイル単体（`SwitchBotHomeTray_<バージョン>_x64.exe`）を Releases に置く。Actions の手動実行はビルドだけで、成果物は Artifacts に置く。
- バージョンは 3 ファイルで揃える必要があり、ワークフローはタグ・`tauri.conf.json`・`Cargo.toml` が食い違うと止まる。手で書き換えず `release.ps1` を使う。
- `.ps1` は PowerShell 5.1 で日本語が化けないよう BOM 付き UTF-8 で保存する。
