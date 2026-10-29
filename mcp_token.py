"""MCP サーバーのコネクタ URL（/mcp/<トークン>）に含めるトークンの読み書き。

画面の API（発行・作り直し）と MCP サーバー（照合）の両方から使う。
トークンはファイル（環境変数 SWITCHBOT_HOME_MCP_TOKEN_FILE、既定はリポジトリ直下の mcp_token）に
64 桁の 16 進数で 1 行だけ書く。MCP サーバーはファイルの更新を毎回確かめるので、作り直すと
再起動しなくてもすぐ新しいトークンだけが通るようになる。
"""
from pathlib import Path
import datetime
import os
import re
import secrets

TOKEN_FILE = Path(os.environ.get('SWITCHBOT_HOME_MCP_TOKEN_FILE', Path(__file__).resolve().parent / 'mcp_token'))
TOKEN_RE = re.compile(r'[0-9a-f]{64}')

_cache = {'key': None, 'token': ''}


def read_token() -> str:
    """今のトークンを返す（未発行・壊れているときは空文字）。ファイルが変わったときだけ読み直す"""
    try:
        st = TOKEN_FILE.stat()
    except FileNotFoundError:
        return ''
    key = (st.st_mtime_ns, st.st_size, st.st_ino)
    if _cache['key'] != key:
        try:
            text = TOKEN_FILE.read_text(encoding='ascii').strip()
        except (OSError, UnicodeDecodeError):
            text = ''
        _cache.update(key=key, token=text if TOKEN_RE.fullmatch(text) else '')
    return _cache['token']


def token_info() -> dict:
    """{'token': 今のトークン or None, 'issuedAt': 発行日時（ISO 8601）or None}"""
    token = read_token()
    if not token:
        return {'token': None, 'issuedAt': None}
    issued = datetime.datetime.fromtimestamp(TOKEN_FILE.stat().st_mtime).astimezone()
    return {'token': token, 'issuedAt': issued.isoformat(timespec='seconds')}


def generate_token() -> dict:
    """新しいトークンを作って保存し、token_info() を返す。前のトークンはすぐ使えなくなる"""
    token = secrets.token_hex(32)
    temporary = TOKEN_FILE.with_name(TOKEN_FILE.name + '.tmp')
    with open(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w', encoding='ascii') as f:
        f.write(token + '\n')
    os.replace(temporary, TOKEN_FILE)
    return token_info()


if __name__ == '__main__':
    import sys
    if sys.argv[1:] == ['--generate']:
        generate_token()
        print(f'{TOKEN_FILE} に新しいトークンを保存しました')
    else:
        sys.exit('使い方: python mcp_token.py --generate   （トークンを作り直す。前のトークンはすぐ使えなくなる）')
