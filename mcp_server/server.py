"""SwitchBot Home の MCP サーバー（Streamable HTTP）。AI が家の機器・シーン・スケジュールを扱えるようにする。

できること:
  - 機器: 一覧、状態の取得、コマンドの送信
  - シーン: 一覧、実行
  - スケジュール: 一覧（次回・最終実行つき）、追加・変更・削除
  - 外出予定（その期間はスケジュールを止める）: 追加・変更・削除
SwitchBot API は直接呼ばず、同じサーバーの Web API（web/api.py）を経由する。1 日の呼び出し回数・
キャッシュ・赤外線リモコンの最後の操作の記録を画面と共有するため。Web API へは、画面のログインと
同じ形のトークンを config.json の web_secret で作って付ける。

ロックの解錠は、config.json の mcp_allow_unlock（環境変数 SWITCHBOT_HOME_MCP_ALLOW_UNLOCK）が
true のときだけできる（既定は不可。URL が漏れたときに玄関を開けられないように）。

claude.ai のカスタムコネクタなどは認証ヘッダーを付けられないので、URL に推測できない
トークンを含めて守る。コネクタの URL は /mcp/<トークン> で、違う URL は 404 になる。
トークンは mcp_token.py のファイルにあり、画面から作り直せる（再起動しなくてもすぐ切り替わる）。

起動（リポジトリ直下で）:
  python mcp_server/server.py

環境変数
  SWITCHBOT_HOME_MCP_PORT        待ち受けポート（省略時は 8008）
  SWITCHBOT_HOME_MCP_TOKEN_FILE  トークンのファイル（省略時はリポジトリ直下の mcp_token）
  SWITCHBOT_HOME_API             Web API の URL（省略時は http://127.0.0.1:8002/api）
"""
from pathlib import Path
from typing import Annotated, Any, Literal
import asyncio
import hashlib
import hmac
import logging
import os
import re
import sys
import time
import uuid

import requests
import uvicorn
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations
from pydantic import BaseModel, Field

REPO_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_DIR))

from mcp_token import TOKEN_FILE, read_token  # noqa: E402
from switchbot_client import load_config  # noqa: E402

PORT = int(os.environ.get('SWITCHBOT_HOME_MCP_PORT', '8008'))
API_BASE = os.environ.get('SWITCHBOT_HOME_API', 'http://127.0.0.1:8002/api').rstrip('/')
CONNECTOR_PATH = re.compile(r'^/mcp/([0-9a-f]{64})/?$')
UNLOCK_COMMANDS = {'unlock', 'unlatch'}
WEEKDAY_NAMES = '月火水木金土日'
DAY_MODE_NAMES = {'everyday': '毎日', 'weekday': '平日', 'holiday': '休日（土日祝）', 'days': '曜日指定', 'none': 'なし'}

log = logging.getLogger('switchbot-home-mcp')

server = MCPServer(
    name='switchbot-home',
    instructions=(
        '持ち主の家の SwitchBot 機器を扱う。機器の一覧と状態（温度・湿度・電源・施錠など）の取得、'
        '機器へのコマンド送信、シーンの実行、スケジュール（決まった時刻にシーンや機器を操作する）と'
        '外出予定（その期間はスケジュールを止める）の確認・編集ができる。\n'
        '機器の操作・シーンの実行は実際に家の中の物が動く。持ち主に頼まれたときだけ行い、'
        '対象が曖昧なら操作する前に確かめる。スケジュールの変更は保存するとすぐ効く。'
        '変える前と後の内容を持ち主に伝える。\n'
        'SwitchBot API は 1 日 10,000 回までなので、状態は必要な機器だけ取り、refresh は必要なときだけ使う。'
        '赤外線リモコン（kind が ir）は状態を取得できない（最後に送ったコマンドだけ分かる）。'
    ),
)


# ------------------------------------------------------------
# Web API の呼び出し
# ------------------------------------------------------------
def session_token() -> str:
    """Web API のログインと同じ形のトークン（"発行時刻:署名"）。web/api.py の verify_session_token が受け付ける"""
    config = load_config()
    username = os.getenv('SWITCHBOT_HOME_USERNAME', config.get('web_username', ''))
    secret = os.getenv('SWITCHBOT_HOME_SECRET', config.get('web_secret', ''))
    if not secret:
        raise ToolError('サーバーの設定（web_secret）が無いので Web API を呼べない。持ち主に config.json を確かめてもらう')
    issued_at = int(time.time())
    token = hmac.new(secret.encode(), f'{issued_at}:{username}'.encode(), hashlib.sha256).hexdigest()
    return f'{issued_at}:{token}'


async def call_api(method: str, path: str, **kwargs) -> Any:
    headers = {'Authorization': f'Bearer {session_token()}'}
    try:
        res = await asyncio.to_thread(requests.request, method, f'{API_BASE}{path}', headers=headers, timeout=60, **kwargs)
    except requests.RequestException as e:
        raise ToolError(f'SwitchBot Home の Web API に接続できない ({type(e).__name__}: {e})') from e
    if res.status_code != 200:
        try:
            detail = res.json().get('detail')
        except ValueError:
            detail = None
        if res.status_code == 401:
            raise ToolError('Web API の認証に失敗した。持ち主に config.json（web_username / web_password / web_secret）を確かめてもらう')
        if res.status_code == 502:
            raise ToolError(f'SwitchBot API のエラー: {detail}')
        raise ToolError(f'Web API が HTTP {res.status_code} を返した: {detail}')
    return res.json()


def unlock_allowed() -> bool:
    value = os.getenv('SWITCHBOT_HOME_MCP_ALLOW_UNLOCK')
    if value is None:
        return bool(load_config().get('mcp_allow_unlock'))
    return value.lower() in ('1', 'true', 'yes')


# ------------------------------------------------------------
# 機器・シーン
# ------------------------------------------------------------
def suggested_commands(device: dict) -> list[dict]:
    """機器タイプごとの主なコマンド（web/src/common.tsx の deviceActions() と同じ）"""
    def actions(*pairs):
        return [{'command': c, 'label': label} for c, label in pairs]
    t = device['type']
    if device['kind'] == 'ir':
        # Others はカスタムボタン名が必要なので対象外。DIY（学習リモコン）は電源ボタンを学習していれば動く
        return [] if t == 'Others' else actions(('turnOn', 'ON'), ('turnOff', 'OFF'))
    if re.search(r'Lock', t, re.I):
        return actions(('lock', '施錠'), ('unlock', '解錠'))
    if t == 'Bot':
        return actions(('turnOn', 'ON'), ('turnOff', 'OFF'), ('press', '押す'))
    if re.search(r'Curtain|Roller Shade|Blind Tilt', t, re.I):
        return actions(('turnOn', '開く'), ('turnOff', '閉じる'))
    if re.search(r'Plug|Relay|Light|Bulb|Strip|Lamp|Fan|Humidifier|Purifier|Ceiling', t, re.I):
        return actions(('turnOn', 'ON'), ('turnOff', 'OFF'))
    return []


def has_status(device: dict) -> bool:
    # Remote（ボタン型の機器）と赤外線リモコンは状態を取得できない
    return device['kind'] == 'device' and device['type'] != 'Remote'


def device_view(device: dict) -> dict:
    out = {
        'id': device['id'], 'name': device['name'], 'type': device['type'], 'kind': device['kind'],
        'hasStatus': has_status(device), 'commands': suggested_commands(device),
    }
    if device['kind'] == 'device' and not device.get('cloudEnabled', True):
        out['cloudEnabled'] = False
    if device.get('lastCommand'):
        last = device['lastCommand']
        out['lastCommand'] = {'command': last['command'], 'parameter': last.get('parameter'),
                              'at': time.strftime('%Y-%m-%dT%H:%M', time.localtime(last['at']))}
    return out


async def fetch_devices(refresh: bool = False) -> dict:
    return await call_api('GET', '/devices', params={'refresh': str(refresh).lower()})


async def fetch_scenes(refresh: bool = False) -> list[dict]:
    return (await call_api('GET', '/scenes', params={'refresh': str(refresh).lower()}))['scenes']


def resolve(items: list[dict], key: str, what: str, hint: str) -> dict:
    """id か名前（完全一致）で 1 つ選ぶ"""
    for item in items:
        if item['id'] == key:
            return item
    matches = [item for item in items if item['name'] == key]
    if len(matches) == 1:
        return matches[0]
    if matches:
        raise ToolError(f'{what}「{key}」という名前が複数ある。id で指定する ({[m["id"] for m in matches]})')
    raise ToolError(f'{what}「{key}」が見つからない。{hint} で id か正確な名前を確かめる')


async def resolve_device(key: str) -> dict:
    return resolve((await fetch_devices())['devices'], key, '機器', 'list_devices')


async def resolve_scene(key: str) -> dict:
    return resolve(await fetch_scenes(), key, 'シーン', 'list_scenes')


def check_unlock(device: dict, command: str):
    if command in UNLOCK_COMMANDS and not unlock_allowed():
        raise ToolError(f'「{device["name"]}」の解錠は MCP からはできない設定になっている。'
                        '持ち主に SwitchBot アプリか SwitchBot Home の画面で操作してもらう')


# ------------------------------------------------------------
# スケジュール・外出予定
# ------------------------------------------------------------
HM = r'^([01]\d|2[0-3]):[0-5]\d$'
DATETIME = r'^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$'
DayMode = Literal['everyday', 'weekday', 'holiday', 'days']
ExcludeMode = Literal['none', 'weekday', 'holiday', 'days']
Weekdays = Annotated[list[Annotated[int, Field(ge=0, le=6)]], Field(description='曜日の番号（0=月 1=火 … 5=土 6=日）')]


class Action(BaseModel):
    kind: Annotated[Literal['scene', 'device'], Field(description='scene = シーンを実行 / device = 機器にコマンドを送る')]
    target: Annotated[str, Field(description='シーンか機器の id か正確な名前（list_scenes / list_devices で確かめる）')]
    command: Annotated[str | None, Field(description=(
        'device のときのコマンド（list_devices の commands にあるもの。省略で turnOn）。パラメーターは付けられない'))] = None


class ScheduleInput(BaseModel):
    name: str = ''
    enabled: bool = True
    dayMode: Annotated[DayMode, Field(description='実行する日: everyday = 毎日 / weekday = 平日 / holiday = 土日祝 / days = 曜日指定')] = 'everyday'
    weekdays: Annotated[Weekdays, Field(description='dayMode が days のときの曜日（0=月 … 6=日）')] = []
    excludeMode: Annotated[ExcludeMode, Field(description='除外する日（dayMode に当てはまってもこの日は実行しない）。none = 除外なし')] = 'none'
    excludeWeekdays: Annotated[Weekdays, Field(description='excludeMode が days のときの曜日')] = []
    start: Annotated[str, Field(pattern=HM, description='開始時刻 HH:MM（24 時間制）')]
    end: Annotated[str | None, Field(pattern=HM, description=(
        '終了時刻 HH:MM（省略で終了なし）。開始時刻以前なら翌日の時刻（例: 22:00 開始・02:00 終了は翌 2:00）'))] = None
    startAction: Annotated[Action | None, Field(description='開始時刻に行う操作')] = None
    endAction: Annotated[Action | None, Field(description='終了時刻に行う操作（end が必要）')] = None


class SchedulePatch(BaseModel):
    """変える項目だけ指定する。null を指定すると、end・startAction・endAction は消す"""
    name: str | None = None
    enabled: bool | None = None
    dayMode: DayMode | None = None
    weekdays: Weekdays | None = None
    excludeMode: ExcludeMode | None = None
    excludeWeekdays: Weekdays | None = None
    start: Annotated[str | None, Field(pattern=HM)] = None
    end: Annotated[str | None, Field(pattern=HM, description='null で終了なしにする（endAction も消す）')] = None
    startAction: Annotated[Action | None, Field(description='null で開始時の操作を消す')] = None
    endAction: Annotated[Action | None, Field(description='null で終了時の操作を消す')] = None


class OutingInput(BaseModel):
    name: str = ''
    enabled: bool = True
    start: Annotated[str, Field(pattern=DATETIME, description='開始日時 YYYY-MM-DDTHH:MM（日本時間）')]
    end: Annotated[str, Field(pattern=DATETIME, description='終了日時 YYYY-MM-DDTHH:MM（日本時間）')]
    schedules: Annotated[list[str] | None, Field(description=(
        '止めるスケジュールの id か名前のリスト。省略（null）ですべてのスケジュールを止める'))] = None


class OutingPatch(BaseModel):
    """変える項目だけ指定する。schedules に null を指定すると、すべてのスケジュールを止める"""
    name: str | None = None
    enabled: bool | None = None
    start: Annotated[str | None, Field(pattern=DATETIME)] = None
    end: Annotated[str | None, Field(pattern=DATETIME)] = None
    schedules: list[str] | None = None


# 読んで書くまでの間に MCP の呼び出し同士で上書きし合わないようにする（画面からの保存とは排他しない）
edit_lock = asyncio.Lock()


async def to_action(action: Action, devices: list[dict], scenes: list[dict]) -> dict:
    if action.kind == 'scene':
        if action.command:
            raise ToolError('シーンの操作には command を付けない')
        scene = resolve(scenes, action.target, 'シーン', 'list_scenes')
        return {'kind': 'scene', 'targetId': scene['id'], 'command': None}
    device = resolve(devices, action.target, '機器', 'list_devices')
    command = action.command or 'turnOn'
    allowed = [c['command'] for c in suggested_commands(device)]
    if command not in allowed:
        raise ToolError(f'「{device["name"]}」のスケジュールで使えるコマンドは {allowed or "ない"}（{command} は使えない）')
    check_unlock(device, command)
    return {'kind': 'device', 'targetId': device['id'], 'command': command}


def check_schedule(s: dict):
    if s['dayMode'] == 'days' and not s['weekdays']:
        raise ToolError('dayMode が days のときは weekdays を 1 つ以上指定する')
    if s['excludeMode'] == 'days' and not s['excludeWeekdays']:
        raise ToolError('excludeMode が days のときは excludeWeekdays を 1 つ以上指定する')
    if s['endAction'] and not s['end']:
        raise ToolError('endAction を付けるときは end（終了時刻）も指定する')
    if not s['startAction'] and not s['endAction']:
        raise ToolError('startAction か endAction の少なくとも一方を指定する')


def check_outing(o: dict):
    if o['end'] <= o['start']:
        raise ToolError('外出予定の終了日時は開始日時より後にする')


def find(items: list[dict], key: str, what: str) -> dict:
    return resolve(items, key, what, 'get_schedules')


def resolve_schedule_ids(schedules: list[dict], keys: list[str]) -> list[str]:
    return list(dict.fromkeys(find(schedules, k, 'スケジュール')['id'] for k in keys))


async def edit_schedules(change, needs_targets=False):
    """スケジュールと外出予定を change(data, devices, scenes) で書き換えて保存し、結果を返す"""
    async with edit_lock:
        current = await call_api('GET', '/schedules')
        data = {'schedules': current['schedules'], 'outings': current['outings']}
        devices, scenes = [], []
        if needs_targets:
            devices = (await fetch_devices())['devices']
            scenes = await fetch_scenes()
        detail = await change(data, devices, scenes)
        saved = await call_api('PUT', '/schedules', json=data)
    return {'ok': True, **detail, **(await schedules_view(saved))}


async def schedules_view(payload: dict) -> dict:
    """get_schedules の結果。操作の対象と外出予定の対象に名前を付ける"""
    try:
        names = {d['id']: d['name'] for d in (await fetch_devices())['devices']}
        names.update({s['id']: s['name'] for s in await fetch_scenes()})
    except ToolError:
        names = {}
    schedule_names = {s['id']: s.get('name', '') for s in payload['schedules']}

    def action_view(action):
        if not action:
            return None
        return {**action, 'targetName': names.get(action['targetId'], '（見つからない機器・シーン）')}

    def days(mode, weekdays):
        if mode == 'days':
            return '・'.join(WEEKDAY_NAMES[i] for i in sorted(weekdays))
        return DAY_MODE_NAMES[mode]

    schedules = []
    for s in payload['schedules']:
        exclude = s.get('excludeMode', 'none')
        schedules.append({
            'id': s['id'], 'name': s.get('name', ''), 'enabled': s.get('enabled', True),
            'days': days(s.get('dayMode', 'everyday'), s.get('weekdays', [])),
            'excludeDays': days(exclude, s.get('excludeWeekdays', [])) if exclude != 'none' else None,
            'dayMode': s.get('dayMode', 'everyday'), 'weekdays': s.get('weekdays', []),
            'excludeMode': exclude, 'excludeWeekdays': s.get('excludeWeekdays', []),
            'start': s['start'], 'end': s.get('end'),
            'endsNextDay': bool(s.get('end')) and s['end'] <= s['start'],
            'startAction': action_view(s.get('startAction')), 'endAction': action_view(s.get('endAction')),
            'nextRun': payload['nextRuns'].get(s['id']), 'lastRun': payload['lastRuns'].get(s['id']),
        })
    outings = [{
        **o, 'targetNames': None if o.get('allTargets', True) else [schedule_names.get(i, i) for i in o.get('targetIds', [])],
    } for o in payload['outings']]
    status = payload['status']
    result = {'now': status['now'], 'today': status['today'], 'schedules': schedules, 'outings': outings}
    if not status['schedulerEnabled']:
        result['warning'] = 'このサーバーではスケジューラーが動いていない（スケジュールは実行されない）'
    return result


# ------------------------------------------------------------
# ツール
# ------------------------------------------------------------
READ = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)
OPERATE = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=True)
WRITE = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False)
DESTRUCTIVE = ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False, openWorldHint=False)

RefreshArg = Annotated[bool, Field(description='true でキャッシュを使わず取り直す（API の呼び出し回数を使う）')]


@server.tool(title='機器一覧', annotations=READ)
async def list_devices(refresh: RefreshArg = False) -> dict:
    """SwitchBot アカウントの機器（物理機器と赤外線リモコン）の一覧を返す。
    kind が ir は赤外線リモコンで、状態は取れない（lastCommand は最後に送ったコマンド）。
    commands はその機器の主なコマンド。一覧は 10 分キャッシュしている。"""
    body = await fetch_devices(refresh)
    return {'devices': [device_view(d) for d in body['devices']], 'usage': body['usage']}


@server.tool(title='機器の状態', annotations=READ)
async def get_device_status(
    devices: Annotated[list[str] | None, Field(description=(
        '機器の id か正確な名前のリスト。省略で、状態を取れる機器すべて（台数分 API を呼ぶ）'))] = None,
    refresh: RefreshArg = False,
) -> dict:
    """機器の状態（電源・温度・湿度・施錠・電池など SwitchBot API の値そのまま）を返す。30 秒キャッシュしている。
    カーテンの slidePosition は 0 が全開・100 が全閉。"""
    body = await fetch_devices()
    all_devices = body['devices']
    targets = [resolve(all_devices, k, '機器', 'list_devices') for k in devices] if devices else \
        [d for d in all_devices if has_status(d)]
    result = {}
    ids = []
    for d in targets:
        if has_status(d):
            ids.append(d['id'])
        else:
            last = device_view(d).get('lastCommand')
            result[d['id']] = {'name': d['name'], 'type': d['type'],
                               'error': '状態を取得できない機器', **({'lastCommand': last} if last else {})}
    usage = body['usage']
    if ids:
        response = await call_api('POST', '/devices/status', json={'ids': ids, 'refresh': refresh})
        usage = response['usage']
        by_id = {d['id']: d for d in targets}
        for device_id, entry in response['statuses'].items():
            d = by_id[device_id]
            if 'error' in entry:
                result[device_id] = {'name': d['name'], 'type': d['type'], 'error': entry['error']}
            else:
                result[device_id] = {'name': d['name'], 'type': d['type'], 'status': entry['status'],
                                     'fetchedAt': time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(entry['fetchedAt']))}
    return {'statuses': result, 'usage': usage}


@server.tool(title='機器を操作する', annotations=OPERATE)
async def send_device_command(
    device: Annotated[str, Field(description='機器の id か正確な名前')],
    command: Annotated[str, Field(description=(
        'コマンド（turnOn / turnOff / press / lock / setPosition / setAll など。'
        '機器ごとの一覧は https://github.com/OpenWonderLabs/SwitchBotAPI の devices/ を参照）'))],
    parameter: Annotated[Any, Field(description=(
        'コマンドのパラメーター（不要なら "default"）。例: カーテンの setPosition は "0,ff,30"、'
        'エアコンの赤外線リモコンの setAll は "26,2,1,on"（温度,モード,風量,電源）'))] = 'default',
    command_type: Annotated[Literal['command', 'customize'], Field(description=(
        'customize は赤外線リモコンの学習ボタン（command にボタン名を入れる）'))] = 'command',
) -> dict:
    """機器にコマンドを送る（実際に家の中の物が動く）。持ち主に頼まれたときだけ使う。
    ロックの解錠は、持ち主が許可した設定のときだけできる。"""
    target = await resolve_device(device)
    check_unlock(target, command)
    await call_api('POST', f'/devices/{target["id"]}/commands',
                   json={'command': command, 'parameter': parameter, 'commandType': command_type})
    note = '送信した。物理機器は少し待ってから get_device_status（refresh=true）で結果を確かめられる' \
        if has_status(target) else '送信した（この機器は状態を取得できないので、結果は確かめられない）'
    return {'ok': True, 'device': target['name'], 'command': command, 'parameter': parameter, 'note': note}


@server.tool(title='シーン一覧', annotations=READ)
async def list_scenes(refresh: RefreshArg = False) -> dict:
    """SwitchBot アプリで作った手動シーンの一覧を返す（10 分キャッシュしている）。"""
    return {'scenes': await fetch_scenes(refresh)}


@server.tool(title='シーンを実行する', annotations=OPERATE)
async def execute_scene(scene: Annotated[str, Field(description='シーンの id か正確な名前')]) -> dict:
    """シーンを実行する（実際に家の中の物が動く）。持ち主に頼まれたときだけ使う。"""
    target = await resolve_scene(scene)
    await call_api('POST', f'/scenes/{target["id"]}/execute')
    return {'ok': True, 'scene': target['name']}


@server.tool(title='API の呼び出し回数', annotations=READ)
async def get_usage() -> dict:
    """今日の SwitchBot API の呼び出し回数（このサーバーから呼んだ分）と上限（1 日 10,000 回）を返す。"""
    return await call_api('GET', '/usage')


@server.tool(title='スケジュール一覧', annotations=READ)
async def get_schedules() -> dict:
    """スケジュールと外出予定を返す。

    スケジュールは、日付条件（days）に当てはまり除外条件（excludeDays）に当てはまらない日の start に
    startAction、end に endAction を実行する（日本時間）。endsNextDay が true なら終了は翌日の時刻で、
    日付条件は開始した日で判定する。休日は土日と祝日。nextRun は次に実行する日時、lastRun は最後の実行結果。
    外出予定（outings）の期間中は、対象のスケジュール（allTargets が true ならすべて、false なら targetIds）を実行しない。"""
    return await schedules_view(await call_api('GET', '/schedules'))


@server.tool(title='スケジュールを追加する', annotations=WRITE)
async def add_schedule(schedule: ScheduleInput) -> dict:
    """スケジュールを追加して保存する（すぐ効く）。"""
    async def change(data, devices, scenes):
        new = schedule.model_dump()
        new['id'] = str(uuid.uuid4())
        for key in ('startAction', 'endAction'):
            action = getattr(schedule, key)
            if action:
                new[key] = await to_action(action, devices, scenes)
        check_schedule(new)
        data['schedules'].append(new)
        return {'added': new['id']}
    return await edit_schedules(change, needs_targets=True)


@server.tool(title='スケジュールを変更する', annotations=WRITE)
async def update_schedule(
    schedule: Annotated[str, Field(description='変更するスケジュールの id か正確な名前')],
    changes: SchedulePatch,
) -> dict:
    """スケジュールの指定した項目だけを変えて保存する（すぐ効く）。止めるだけなら changes に {"enabled": false}。"""
    given = changes.model_fields_set

    async def change(data, devices, scenes):
        current = find(data['schedules'], schedule, 'スケジュール')
        new = {**current}
        for key in given - {'startAction', 'endAction'}:
            value = getattr(changes, key)
            if value is not None or key == 'end':
                new[key] = value
        if 'end' in given and changes.end is None:
            # 終了なしにしたら、終了時の操作も消す
            new['endAction'] = None
        for key in given & {'startAction', 'endAction'}:
            action = getattr(changes, key)
            new[key] = await to_action(action, devices, scenes) if action else None
        new.setdefault('excludeMode', 'none')
        new.setdefault('excludeWeekdays', [])
        check_schedule(new)
        data['schedules'][data['schedules'].index(current)] = new
        return {'updated': new['id']}
    return await edit_schedules(change, needs_targets=bool(given & {'startAction', 'endAction'}))


@server.tool(title='スケジュールを削除する', annotations=DESTRUCTIVE)
async def delete_schedule(schedule: Annotated[str, Field(description='削除するスケジュールの id か正確な名前')]) -> dict:
    """スケジュールを削除して保存する。一時的に止めるだけなら update_schedule で enabled を false にする。"""
    async def change(data, _devices, _scenes):
        target = find(data['schedules'], schedule, 'スケジュール')
        data['schedules'].remove(target)
        # 外出予定の対象からも外す（Web API も保存時に外す）
        for outing in data['outings']:
            outing['targetIds'] = [i for i in outing.get('targetIds', []) if i != target['id']]
        return {'deleted': target['id']}
    return await edit_schedules(change)


@server.tool(title='外出予定を追加する', annotations=WRITE)
async def add_outing(outing: OutingInput) -> dict:
    """外出予定を追加して保存する。期間中は対象のスケジュールを実行しない。"""
    async def change(data, _devices, _scenes):
        new = {'id': str(uuid.uuid4()), 'name': outing.name, 'enabled': outing.enabled,
               'start': outing.start, 'end': outing.end, 'allTargets': outing.schedules is None,
               'targetIds': resolve_schedule_ids(data['schedules'], outing.schedules or [])}
        check_outing(new)
        data['outings'].append(new)
        return {'added': new['id']}
    return await edit_schedules(change)


@server.tool(title='外出予定を変更する', annotations=WRITE)
async def update_outing(
    outing: Annotated[str, Field(description='変更する外出予定の id か正確な名前')],
    changes: OutingPatch,
) -> dict:
    """外出予定の指定した項目だけを変えて保存する。"""
    given = changes.model_fields_set

    async def change(data, _devices, _scenes):
        current = find(data['outings'], outing, '外出予定')
        new = {**current}
        for key in given - {'schedules'}:
            value = getattr(changes, key)
            if value is not None:
                new[key] = value
        if 'schedules' in given:
            new['allTargets'] = changes.schedules is None
            new['targetIds'] = resolve_schedule_ids(data['schedules'], changes.schedules or [])
        check_outing(new)
        data['outings'][data['outings'].index(current)] = new
        return {'updated': new['id']}
    return await edit_schedules(change)


@server.tool(title='外出予定を削除する', annotations=DESTRUCTIVE)
async def delete_outing(outing: Annotated[str, Field(description='削除する外出予定の id か正確な名前')]) -> dict:
    """外出予定を削除して保存する。"""
    async def change(data, _devices, _scenes):
        target = find(data['outings'], outing, '外出予定')
        data['outings'].remove(target)
        return {'deleted': target['id']}
    return await edit_schedules(change)


# ------------------------------------------------------------
# 入口
# ------------------------------------------------------------
async def plain(send, status, text):
    body = text.encode()
    await send({'type': 'http.response.start', 'status': status,
                'headers': [(b'content-type', b'text/plain; charset=utf-8'), (b'content-length', str(len(body)).encode())]})
    await send({'type': 'http.response.body', 'body': body})


def connector_app(inner):
    """/mcp/<トークン> を確かめてから、/mcp として MCP 本体に渡す ASGI アプリ"""

    async def app(scope, receive, send):
        if scope['type'] != 'http':
            await inner(scope, receive, send)  # lifespan など
            return
        m = CONNECTOR_PATH.match(scope['path'])
        # 画面で作り直したらすぐ切り替わるよう、毎回ファイルの今のトークンと比べる
        token = read_token()
        ok = bool(m and token and hmac.compare_digest(m.group(1), token))
        forwarded_for = next((v.decode() for k, v in scope['headers'] if k == b'x-forwarded-for'), '-')
        # URL にトークンが入っているので、uvicorn のアクセスログは止めて、ここで結果だけ記録する
        print(f'{forwarded_for} {scope["method"]} {200 if ok else 404}', flush=True)
        if not ok:
            await plain(send, 404, 'not found')
            return
        await inner(dict(scope, path='/mcp', raw_path=b'/mcp'), receive, send)

    return app


if __name__ == '__main__':
    logging.basicConfig(level=logging.WARNING, format='%(levelname)s %(message)s')
    if not read_token():
        log.warning('トークンが未発行です (%s)。画面の一覧ページから発行するまで、すべての接続を拒否します', TOKEN_FILE)
    inner = server.streamable_http_app(streamable_http_path='/mcp', stateless_http=True, json_response=True,
                                       host='127.0.0.1')
    uvicorn.run(connector_app(inner), host='127.0.0.1', port=PORT, access_log=False)
