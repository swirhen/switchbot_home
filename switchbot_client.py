"""SwitchBot API v1.1 クライアント。

認証情報は環境変数 SWITCHBOT_TOKEN / SWITCHBOT_SECRET を優先し、
無ければリポジトリ直下の config.json（Git 管理外）から読む。
"""
from pathlib import Path
import base64
import hashlib
import hmac
import json
import os
import threading
import time
import uuid
from datetime import date

import requests

API_BASE = 'https://api.switch-bot.com/v1.1'
CONFIG_FILE = Path(__file__).resolve().parent / 'config.json'
DAILY_LIMIT = 10000


def load_config() -> dict:
    try:
        return json.loads(CONFIG_FILE.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return {}


class SwitchBotError(Exception):
    def __init__(self, message: str, status_code: int | None = None, http_status: int | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.http_status = http_status


# statusCode の意味（README の Standard response より）
STATUS_MESSAGES = {
    151: '機器タイプの誤り',
    152: '機器が見つかりません',
    160: 'このコマンドには対応していません',
    161: '機器がオフラインです',
    171: 'ハブがオフラインです',
    190: '内部エラー、またはコマンド形式の誤り',
}


class SwitchBotClient:
    def __init__(self, token: str, secret: str, timeout: float = 10.0):
        self.token = token
        self.secret = secret
        self.timeout = timeout
        self.session = requests.Session()
        # 1日あたりの呼び出し回数（上限 10,000 回）をプロセス内で数える
        self._count_lock = threading.Lock()
        self._count_date = date.today()
        self._count = 0

    @classmethod
    def from_env(cls) -> 'SwitchBotClient':
        config = load_config()
        token = os.getenv('SWITCHBOT_TOKEN', config.get('switchbot_token', ''))
        secret = os.getenv('SWITCHBOT_SECRET', config.get('switchbot_secret', ''))
        return cls(token, secret)

    @property
    def configured(self) -> bool:
        return bool(self.token and self.secret)

    def generate_header(self) -> dict:
        nonce = str(uuid.uuid4())
        t = str(int(round(time.time() * 1000)))
        sign = base64.b64encode(
            hmac.new(self.secret.encode('utf-8'), f'{self.token}{t}{nonce}'.encode('utf-8'), hashlib.sha256).digest()
        ).decode('utf-8')
        return {
            'Authorization': self.token,
            'Content-Type': 'application/json; charset=utf8',
            't': t,
            'sign': sign,
            'nonce': nonce,
        }

    def _count_call(self):
        with self._count_lock:
            today = date.today()
            if today != self._count_date:
                self._count_date = today
                self._count = 0
            self._count += 1

    def usage(self) -> dict:
        with self._count_lock:
            if date.today() != self._count_date:
                return {'date': date.today().isoformat(), 'count': 0, 'limit': DAILY_LIMIT}
            return {'date': self._count_date.isoformat(), 'count': self._count, 'limit': DAILY_LIMIT}

    def _request(self, method: str, path: str, payload: dict | None = None):
        if not self.configured:
            raise SwitchBotError('SwitchBot のトークン/シークレットが設定されていません')
        self._count_call()
        try:
            res = self.session.request(
                method, f'{API_BASE}{path}', headers=self.generate_header(), json=payload, timeout=self.timeout
            )
        except requests.RequestException as e:
            raise SwitchBotError(f'SwitchBot API への接続に失敗しました: {e}') from e
        if res.status_code != 200:
            raise SwitchBotError(f'SwitchBot API が HTTP {res.status_code} を返しました', http_status=res.status_code)
        try:
            data = res.json()
        except ValueError as e:
            raise SwitchBotError('SwitchBot API の応答を解釈できません') from e
        status_code = data.get('statusCode')
        if status_code != 100:
            message = STATUS_MESSAGES.get(status_code, data.get('message') or '不明なエラー')
            raise SwitchBotError(f'{message} (statusCode={status_code})', status_code=status_code)
        return data.get('body')

    def get_devices(self) -> dict:
        return self._request('GET', '/devices')

    def get_status(self, device_id: str) -> dict:
        return self._request('GET', f'/devices/{device_id}/status')

    def send_command(self, device_id: str, command: str, parameter='default', command_type: str = 'command'):
        payload = {'command': command, 'parameter': parameter, 'commandType': command_type}
        return self._request('POST', f'/devices/{device_id}/commands', payload)

    def get_scenes(self) -> list:
        return self._request('GET', '/scenes')

    def execute_scene(self, scene_id: str):
        return self._request('POST', f'/scenes/{scene_id}/execute')
