"""スケジュールと外出予定の判定・実行。

スケジュールは「日付条件（毎日・平日・休日・曜日指定）」と「開始時刻（と終了時刻）」で決まり、
開始時刻・終了時刻にそれぞれの操作を実行する。終了時刻が開始時刻以前なら翌日の時刻として扱う
（例: 10:00-翌2:00 の終了は、開始した日の翌日 2:00。日付条件は開始した日で判定する）。
外出予定の期間中は、対象のスケジュールを実行しない。
"""
from pathlib import Path
from datetime import date, datetime, time as dtime, timedelta
from typing import Callable
from zoneinfo import ZoneInfo
import json
import threading

import jpholiday

TZ = ZoneInfo('Asia/Tokyo')
DATA_FILE = Path(__file__).resolve().parent / 'schedules.json'
STATE_FILE = Path(__file__).resolve().parent / 'schedule_state.json'
# サーバーの再起動などで止まっていた間の分は、この時間までさかのぼって実行する
CATCH_UP = timedelta(minutes=10)
NEXT_RUN_DAYS = 14
WEEKDAY_NAMES = '月火水木金土日'


def now_minute() -> datetime:
    return datetime.now(TZ).replace(tzinfo=None, second=0, microsecond=0)


def read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return default


def write_json(path: Path, value):
    temporary = path.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.replace(path)


def load_data() -> dict:
    data = read_json(DATA_FILE, {})
    return {'schedules': data.get('schedules', []), 'outings': data.get('outings', [])}


def save_data(data: dict):
    write_json(DATA_FILE, data)


def load_state() -> dict:
    state = read_json(STATE_FILE, {})
    return {'lastProcessed': state.get('lastProcessed'), 'lastRuns': state.get('lastRuns', {})}


def is_holiday(day: date) -> bool:
    return day.weekday() >= 5 or jpholiday.is_holiday(day)


def holiday_name(day: date) -> str | None:
    return jpholiday.is_holiday_name(day)


def mode_matches(mode: str, weekdays: list[int], day: date) -> bool:
    if mode == 'weekday':
        return not is_holiday(day)
    if mode == 'holiday':
        return is_holiday(day)
    if mode == 'days':
        return day.weekday() in weekdays
    return mode == 'everyday'


def day_matches(schedule: dict, day: date) -> bool:
    # 日付条件に当てはまり、除外条件（平日・休日・曜日指定）に当てはまらない日に実行する
    if not mode_matches(schedule.get('dayMode', 'everyday'), schedule.get('weekdays', []), day):
        return False
    return not mode_matches(schedule.get('excludeMode', 'none'), schedule.get('excludeWeekdays', []), day)


def parse_hm(value: str) -> dtime:
    hour, minute = value.split(':')
    return dtime(int(hour), int(minute))


def ends_next_day(schedule: dict) -> bool:
    return bool(schedule.get('end')) and parse_hm(schedule['end']) <= parse_hm(schedule['start'])


def occurrences(schedule: dict, day: date):
    """day に始まる回の (edge, 実行日時) を返す。"""
    yield 'start', datetime.combine(day, parse_hm(schedule['start']))
    if schedule.get('end'):
        end_day = day + timedelta(days=1) if ends_next_day(schedule) else day
        yield 'end', datetime.combine(end_day, parse_hm(schedule['end']))


def suppressing_outing(schedule: dict, at: datetime, outings: list[dict]) -> dict | None:
    for outing in outings:
        if not outing.get('enabled', True):
            continue
        if not (outing.get('allTargets') or schedule['id'] in outing.get('targetIds', [])):
            continue
        if datetime.fromisoformat(outing['start']) <= at < datetime.fromisoformat(outing['end']):
            return outing
    return None


def events_at(schedule: dict, at: datetime) -> list[str]:
    """at（分単位）に実行する edge（start / end）を返す。"""
    edges = []
    # 翌日にまたがる終了は前日に始まった回なので、前日と当日の回を調べる
    for day in (at.date() - timedelta(days=1), at.date()):
        if not day_matches(schedule, day):
            continue
        edges.extend(edge for edge, when in occurrences(schedule, day) if when == at)
    return edges


def next_run(schedule: dict, now: datetime, outings: list[dict]) -> dict | None:
    if not schedule.get('enabled', True):
        return None
    candidates = []
    for offset in range(-1, NEXT_RUN_DAYS + 1):
        day = now.date() + timedelta(days=offset)
        if not day_matches(schedule, day):
            continue
        for edge, when in occurrences(schedule, day):
            if when > now and not suppressing_outing(schedule, when, outings):
                candidates.append((when, edge))
    if not candidates:
        return None
    when, edge = min(candidates)
    return {'at': when.isoformat(timespec='minutes'), 'edge': edge}


def today_info(now: datetime) -> dict:
    day = now.date()
    return {
        'date': day.isoformat(),
        'weekday': WEEKDAY_NAMES[day.weekday()],
        'holiday': is_holiday(day),
        'holidayName': holiday_name(day),
    }


class Scheduler:
    def __init__(self, execute: Callable[[dict], None]):
        # execute(action) は失敗時に例外を投げる
        self.execute = execute
        self.stop_event = threading.Event()
        self.thread: threading.Thread | None = None
        self.state_lock = threading.Lock()

    def start(self):
        self.thread = threading.Thread(target=self.loop, name='switchbot-scheduler', daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=5)

    def loop(self):
        current = now_minute()
        saved = load_state()['lastProcessed']
        last = datetime.fromisoformat(saved) if saved else current - timedelta(minutes=1)
        last = max(last, current - CATCH_UP)
        while True:
            current = now_minute()
            minute = last + timedelta(minutes=1)
            while minute <= current:
                self.process(minute)
                last = minute
                minute += timedelta(minutes=1)
            if self.stop_event.wait(15):
                return

    def process(self, at: datetime):
        data = load_data()
        for schedule in data['schedules']:
            if not schedule.get('enabled', True):
                continue
            for edge in events_at(schedule, at):
                action = schedule.get('startAction' if edge == 'start' else 'endAction')
                if not action:
                    continue
                outing = suppressing_outing(schedule, at, data['outings'])
                if outing:
                    self.record(schedule['id'], at, edge, 'skipped', f"外出予定「{outing.get('name', '')}」のため実行しませんでした")
                    continue
                try:
                    self.execute(action)
                    self.record(schedule['id'], at, edge, 'ok')
                except Exception as e:  # noqa: BLE001 - 1件の失敗で他のスケジュールを止めない
                    self.record(schedule['id'], at, edge, 'error', str(getattr(e, 'detail', e)))
        with self.state_lock:
            state = load_state()
            state['lastProcessed'] = at.isoformat(timespec='minutes')
            write_json(STATE_FILE, state)

    def record(self, schedule_id: str, at: datetime, edge: str, result: str, message: str = ''):
        with self.state_lock:
            state = load_state()
            state['lastRuns'][schedule_id] = {'at': at.isoformat(timespec='minutes'), 'edge': edge, 'result': result, 'message': message}
            write_json(STATE_FILE, state)
