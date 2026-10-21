# AI開発エージェント向け運用ルール

## プロジェクト概要

- SwitchBot API v1.1 を使い、アカウントに登録された機器の状態確認・一括操作・シーン実行を行う Web アプリ。
- 構成は FastAPI（`web/api.py`）+ React/Vite（`web/src/`）。本番配置先は未定。
- API 仕様の一次情報: https://github.com/OpenWonderLabs/SwitchBotAPI （機器別の詳細は `devices/<カテゴリ>/*.md`）

## 主なファイル

- `switchbot_client.py`: SwitchBot API の署名生成と呼び出し、1日の呼び出し回数カウント。
- `web/api.py`: ログイン認証、機器一覧・状態（キャッシュ付き）、コマンド送信、一括操作、シーン実行。
- `web/src/main.tsx`: ログイン画面、一覧ページ（`#/`）、ハッシュによるページ切り替え。
- `web/src/layout.tsx`: レイアウトページ（`#/layout`）。機器・シーンのボタンや状態表示をキャンバスに置き、ドラッグで移動・リサイズする。
- `web/src/common.tsx`: API 呼び出し、型、ヘッダー、状態表示など共通部品。機器タイプごとの操作ボタンは `deviceActions()` で決める。
- `web/layout.json`: レイアウトページの配置（Git 管理外。画面の編集内容が自動保存される）。
- `config.json`: SwitchBot のトークン/シークレットと画面のログイン情報（Git 管理外。雛形は `config.example.json`）。環境変数 `SWITCHBOT_TOKEN` / `SWITCHBOT_SECRET` / `SWITCHBOT_HOME_USERNAME` / `SWITCHBOT_HOME_PASSWORD` / `SWITCHBOT_HOME_SECRET` があればそちらを優先する。
- `web/ir_state.json`: 赤外線リモコンに最後に送ったコマンドの記録（Git 管理外）。

## API 利用上の注意

- SwitchBot API は 1日 10,000 回まで。機器一覧・シーンは 10 分、状態は 30 秒キャッシュしている。ポーリングを増やすときは回数に注意する。
- 赤外線リモコンは状態を取得できない。オートメーション（スケジュール等）は API から取得・登録できない。
- `config.json` の値は表示・コミットしない。

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
