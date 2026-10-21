from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
import hashlib
import hmac
import json
import os
import sys
import threading
import time
from typing import Any, Literal
from fastapi import Cookie, Depends, FastAPI, Header, HTTPException, Query, Response
from pydantic import BaseModel, Field
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from switchbot_client import SwitchBotClient, SwitchBotError, load_config
import scheduler as sched


@asynccontextmanager
async def lifespan(_app):
    # 手元の開発用サーバーと本番の両方で動くと二重に実行されるため、明示的に有効にしたサーバーでだけ動かす
    runner = sched.Scheduler(execute_action) if SCHEDULER_ENABLED else None
    if runner:
        runner.start()
    yield
    if runner:
        runner.stop()


app = FastAPI(title='SwitchBot Home API', lifespan=lifespan)
IR_STATE_FILE = Path(__file__).resolve().parent / 'ir_state.json'
LAYOUT_FILE = Path(__file__).resolve().parent / 'layout.json'
AUTH_COOKIE = 'switchbot_home_session'
SESSION_TTL = 60 * 60 * 24 * 180
# 1日 10,000 回の上限があるため、一覧と状態は少しの間キャッシュする
DEVICES_TTL = 60 * 10
STATUS_TTL = 30

CONFIG = load_config()
USERNAME = os.getenv('SWITCHBOT_HOME_USERNAME', CONFIG.get('web_username', ''))
PASSWORD = os.getenv('SWITCHBOT_HOME_PASSWORD', CONFIG.get('web_password', ''))
SECRET = os.getenv('SWITCHBOT_HOME_SECRET', CONFIG.get('web_secret', ''))
SCHEDULER_ENABLED = os.getenv('SWITCHBOT_HOME_SCHEDULER', '1' if CONFIG.get('scheduler_enabled') else '').lower() in ('1', 'true', 'yes')

client = SwitchBotClient.from_env()
cache_lock = threading.Lock()
cache: dict[str, tuple[float, Any]] = {}
ir_state_lock = threading.Lock()


class CommandRequest(BaseModel):
    command: str
    parameter: Any = 'default'
    commandType: str = 'command'


class BatchCommandItem(CommandRequest):
    deviceId: str


class BatchCommandRequest(BaseModel):
    items: list[BatchCommandItem]


class StatusRequest(BaseModel):
    ids: list[str]
    refresh: bool = False


class Widget(BaseModel):
    id: str
    kind: Literal['status', 'action', 'scene', 'group']
    targetId: str = ''
    command: str | None = None
    label: str = ''
    x: int
    y: int
    w: int
    h: int


class Layout(BaseModel):
    widgets: list[Widget] = []


HM = r'^([01]\d|2[0-3]):[0-5]\d$'
DATETIME = r'^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$'


class ScheduleAction(BaseModel):
    kind: Literal['scene', 'device']
    targetId: str
    command: str | None = None


class Schedule(BaseModel):
    id: str
    name: str = ''
    enabled: bool = True
    dayMode: Literal['everyday', 'weekday', 'holiday', 'days'] = 'everyday'
    weekdays: list[int] = []
    start: str = Field(pattern=HM)
    end: str | None = Field(default=None, pattern=HM)
    startAction: ScheduleAction | None = None
    endAction: ScheduleAction | None = None


class Outing(BaseModel):
    id: str
    name: str = ''
    enabled: bool = True
    start: str = Field(pattern=DATETIME)
    end: str = Field(pattern=DATETIME)
    allTargets: bool = True
    targetIds: list[str] = []


class ScheduleData(BaseModel):
    schedules: list[Schedule] = []
    outings: list[Outing] = []


class LoginRequest(BaseModel):
    username: str
    password: str


def verify_session_token(token_str: str | None) -> bool:
    if not PASSWORD or not SECRET or not token_str:
        return False
    try:
        issued, token = token_str.split(':', 1)
        issued_at = int(issued)
    except ValueError:
        return False
    expected = hmac.new(SECRET.encode(), f'{issued_at}:{USERNAME}'.encode(), hashlib.sha256).hexdigest()
    if time.time() - issued_at > SESSION_TTL or not hmac.compare_digest(token, expected):
        return False
    return True


def require_auth(
    authorization: str | None = Header(default=None),
    session: str | None = Cookie(default=None, alias=AUTH_COOKIE),
):
    if authorization and authorization.startswith('Bearer '):
        if verify_session_token(authorization[7:].strip()):
            return
    if verify_session_token(session):
        return
    raise HTTPException(status_code=401, detail='認証が必要です')


def cached(key: str, ttl: int, refresh: bool, loader):
    now = time.time()
    with cache_lock:
        hit = cache.get(key)
        if hit and not refresh and now - hit[0] < ttl:
            return hit[1], hit[0]
    value = loader()
    with cache_lock:
        cache[key] = (now, value)
    return value, now


def invalidate(key: str):
    with cache_lock:
        cache.pop(key, None)


def call_switchbot(func, *args):
    try:
        return func(*args)
    except SwitchBotError as e:
        # SwitchBot 側の 401 を画面のログイン切れと区別するため 502 で返す
        raise HTTPException(status_code=502, detail=str(e))


def load_ir_state() -> dict:
    try:
        return json.loads(IR_STATE_FILE.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return {}


def save_ir_state(device_id: str, payload: CommandRequest):
    # 赤外線リモコンは状態を取得できないので、最後に送ったコマンドを記録しておく
    with ir_state_lock:
        state = load_ir_state()
        state[device_id] = {'command': payload.command, 'parameter': payload.parameter, 'at': int(time.time())}
        temporary = IR_STATE_FILE.with_suffix('.json.tmp')
        temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        temporary.replace(IR_STATE_FILE)


def get_device_map(refresh: bool = False) -> tuple[dict[str, dict], float]:
    body, fetched_at = cached('devices', DEVICES_TTL, refresh, lambda: call_switchbot(client.get_devices))
    devices = {}
    for d in body.get('deviceList', []):
        devices[d['deviceId']] = {
            'id': d['deviceId'],
            'name': d.get('deviceName', ''),
            'type': d.get('deviceType', ''),
            'kind': 'device',
            'hubDeviceId': d.get('hubDeviceId', ''),
            'cloudEnabled': d.get('enableCloudService', True),
        }
    for d in body.get('infraredRemoteList', []):
        devices[d['deviceId']] = {
            'id': d['deviceId'],
            'name': d.get('deviceName', ''),
            'type': d.get('remoteType', ''),
            'kind': 'ir',
            'hubDeviceId': d.get('hubDeviceId', ''),
            'cloudEnabled': True,
        }
    return devices, fetched_at


def run_command(device_id: str, payload: CommandRequest):
    call_switchbot(client.send_command, device_id, payload.command, payload.parameter, payload.commandType)
    invalidate(f'status:{device_id}')
    devices, _ = get_device_map()
    if devices.get(device_id, {}).get('kind') == 'ir':
        save_ir_state(device_id, payload)


@app.middleware('http')
async def add_usage_header(request, call_next):
    # 画面がどの API を呼んでも最新の呼び出し回数を表示できるよう、全応答に付ける
    response = await call_next(request)
    usage = client.usage()
    response.headers['X-SwitchBot-Usage'] = f"{usage['count']}/{usage['limit']}"
    return response


@app.get('/api/health')
def health():
    return {'status': 'ok', 'switchbotConfigured': client.configured}


@app.get('/api/session')
def session(_auth=Depends(require_auth)):
    return {'authenticated': True}


@app.post('/api/login')
def login(payload: LoginRequest, response: Response):
    if not PASSWORD or not SECRET or not hmac.compare_digest(payload.username, USERNAME) or not hmac.compare_digest(payload.password, PASSWORD):
        raise HTTPException(status_code=401, detail='ユーザー名またはパスワードが違います')
    issued_at = int(time.time())
    token = hmac.new(SECRET.encode(), f'{issued_at}:{USERNAME}'.encode(), hashlib.sha256).hexdigest()
    session_value = f'{issued_at}:{token}'
    response.set_cookie(AUTH_COOKIE, session_value, httponly=True, samesite='lax', max_age=SESSION_TTL)
    return {'authenticated': True, 'token': session_value}


@app.post('/api/logout')
def logout(response: Response):
    response.delete_cookie(AUTH_COOKIE)
    return {'authenticated': False}


@app.get('/api/usage')
def usage(_auth=Depends(require_auth)):
    return client.usage()


@app.get('/api/devices')
def list_devices(refresh: bool = Query(default=False), _auth=Depends(require_auth)):
    devices, fetched_at = get_device_map(refresh)
    ir_state = load_ir_state()
    items = [{**d, 'lastCommand': ir_state.get(d['id'])} if d['kind'] == 'ir' else d for d in devices.values()]
    return {'devices': items, 'fetchedAt': int(fetched_at), 'usage': client.usage()}


@app.get('/api/devices/{device_id}/status')
def device_status(device_id: str, refresh: bool = Query(default=False), _auth=Depends(require_auth)):
    status, fetched_at = cached(f'status:{device_id}', STATUS_TTL, refresh, lambda: call_switchbot(client.get_status, device_id))
    return {'status': status, 'fetchedAt': int(fetched_at)}


@app.post('/api/devices/status')
def devices_status(payload: StatusRequest, _auth=Depends(require_auth)):
    def fetch(device_id: str):
        try:
            status, fetched_at = cached(f'status:{device_id}', STATUS_TTL, payload.refresh, lambda: call_switchbot(client.get_status, device_id))
            return device_id, {'status': status, 'fetchedAt': int(fetched_at)}
        except HTTPException as e:
            return device_id, {'error': e.detail}

    with ThreadPoolExecutor(max_workers=4) as executor:
        results = dict(executor.map(fetch, payload.ids))
    return {'statuses': results, 'usage': client.usage()}


@app.post('/api/devices/{device_id}/commands')
def device_command(device_id: str, payload: CommandRequest, _auth=Depends(require_auth)):
    run_command(device_id, payload)
    return {'ok': True}


@app.post('/api/commands/batch')
def batch_command(payload: BatchCommandRequest, _auth=Depends(require_auth)):
    # 一括操作の API は無いので、機器ごとに順番に送る
    results = []
    for item in payload.items:
        try:
            run_command(item.deviceId, item)
            results.append({'deviceId': item.deviceId, 'ok': True})
        except HTTPException as e:
            results.append({'deviceId': item.deviceId, 'ok': False, 'error': e.detail})
    return {'results': results, 'usage': client.usage()}


@app.get('/api/scenes')
def list_scenes(refresh: bool = Query(default=False), _auth=Depends(require_auth)):
    scenes, fetched_at = cached('scenes', DEVICES_TTL, refresh, lambda: call_switchbot(client.get_scenes))
    return {'scenes': [{'id': s['sceneId'], 'name': s['sceneName']} for s in scenes], 'fetchedAt': int(fetched_at)}


@app.post('/api/scenes/{scene_id}/execute')
def execute_scene(scene_id: str, _auth=Depends(require_auth)):
    call_switchbot(client.execute_scene, scene_id)
    return {'ok': True}


@app.get('/api/layout')
def get_layout(_auth=Depends(require_auth)):
    try:
        layout = json.loads(LAYOUT_FILE.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        layout = {}
    return Layout(**layout).model_dump()


@app.put('/api/layout')
def update_layout(payload: Layout, _auth=Depends(require_auth)):
    layout = payload.model_dump()
    temporary = LAYOUT_FILE.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(layout, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.replace(LAYOUT_FILE)
    return layout


def execute_action(action: dict):
    if action['kind'] == 'scene':
        call_switchbot(client.execute_scene, action['targetId'])
    else:
        run_command(action['targetId'], CommandRequest(command=action['command'] or 'turnOn'))


def schedule_payload():
    data = sched.load_data()
    state = sched.load_state()
    now = sched.now_minute()
    return {
        **data,
        'nextRuns': {s['id']: sched.next_run(s, now, data['outings']) for s in data['schedules']},
        'lastRuns': state['lastRuns'],
        'status': {'schedulerEnabled': SCHEDULER_ENABLED, 'now': now.isoformat(timespec='minutes'), 'today': sched.today_info(now)},
    }


@app.get('/api/schedules')
def get_schedules(_auth=Depends(require_auth)):
    return schedule_payload()


@app.put('/api/schedules')
def update_schedules(payload: ScheduleData, _auth=Depends(require_auth)):
    for outing in payload.outings:
        if outing.end <= outing.start:
            raise HTTPException(status_code=422, detail=f'外出予定「{outing.name}」の終了日時が開始日時より前です')
    data = payload.model_dump()
    # 削除されたスケジュールは外出予定の対象からも外す
    ids = {s['id'] for s in data['schedules']}
    for outing in data['outings']:
        outing['targetIds'] = [i for i in outing['targetIds'] if i in ids]
    sched.save_data(data)
    return schedule_payload()
