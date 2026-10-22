import React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { Device, DevicesResponse, Header, Modal, Scene, UnauthorizedError, api, deviceActions, errorMessage, useToast } from './common'

type DayMode = 'everyday' | 'weekday' | 'holiday' | 'days'

type ExcludeMode = 'none' | 'weekday' | 'holiday' | 'days'

type ScheduleAction = { kind: 'scene' | 'device'; targetId: string; command?: string | null }

type Schedule = {
	id: string
	name: string
	enabled: boolean
	dayMode: DayMode
	weekdays: number[]
	// 以前に保存したスケジュールには無いので省略可（無ければ除外なし）
	excludeMode?: ExcludeMode
	excludeWeekdays?: number[]
	start: string
	end: string | null
	startAction: ScheduleAction | null
	endAction: ScheduleAction | null
}

type Outing = {
	id: string
	name: string
	enabled: boolean
	start: string
	end: string
	allTargets: boolean
	targetIds: string[]
}

type ScheduleData = { schedules: Schedule[]; outings: Outing[] }

type RunInfo = { at: string; edge: 'start' | 'end' }

type LastRun = RunInfo & { result: 'ok' | 'skipped' | 'error'; message: string }

type SchedulesResponse = ScheduleData & {
	nextRuns: Record<string, RunInfo | null>
	lastRuns: Record<string, LastRun>
	status: {
		schedulerEnabled: boolean
		now: string
		today: { date: string; weekday: string; holiday: boolean; holidayName: string | null }
	}
}

const WEEKDAYS = ['月', '火', '水', '木', '金', '土', '日']
const DAY_MODES: [DayMode, string][] = [['everyday', '毎日'], ['weekday', '平日'], ['holiday', '休日（土日祝）'], ['days', '曜日指定']]
const EXCLUDE_MODES: [ExcludeMode, string][] = [['none', 'なし'], ['weekday', '平日'], ['holiday', '休日（土日祝）'], ['days', '曜日指定']]
const RESULT_LABELS: Record<LastRun['result'], string> = { ok: '成功', skipped: 'スキップ', error: 'エラー' }

const pad = (n: number) => String(n).padStart(2, '0')

// 日時欄はどこをクリックしてもカレンダーを開く（showPicker に未対応のブラウザでは通常の入力のまま）
function openPicker(e: React.MouseEvent<HTMLInputElement>) {
	try {
		e.currentTarget.showPicker?.()
	} catch {
		// 開けない状況（ユーザー操作外など）では何もしない
	}
}

function toLocalInput(d: Date) {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const formatHm = (hm: string) => hm.replace(/^0(\d)/, '$1')

const endsNextDay = (s: Pick<Schedule, 'start' | 'end'>) => !!s.end && s.end <= s.start

function formatDateTime(value: string) {
	const d = new Date(value)
	return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[(d.getDay() + 6) % 7]}) ${d.getHours()}:${pad(d.getMinutes())}`
}

function modeLabel(mode: DayMode | ExcludeMode, weekdays: number[]) {
	if (mode !== 'days') return [...DAY_MODES, ...EXCLUDE_MODES].find(([key]) => key === mode)?.[1] ?? ''
	return [...weekdays].sort().map(i => WEEKDAYS[i]).join('・') || '（曜日未選択）'
}

function dayLabel(s: Schedule) {
	const base = modeLabel(s.dayMode, s.weekdays)
	const exclude = s.excludeMode ?? 'none'
	if (exclude === 'none') return base
	return `${base}（${modeLabel(exclude, s.excludeWeekdays ?? [])}を除く）`
}

// サーバーの scheduler.mode_matches と同じ判定（weekday: 0=月, holiday: 土日祝）
function modeMatches(mode: DayMode | ExcludeMode, weekdays: number[], weekday: number, holiday: boolean) {
	if (mode === 'weekday') return !holiday
	if (mode === 'holiday') return holiday
	if (mode === 'days') return weekdays.includes(weekday)
	return mode === 'everyday'
}

// 日付条件と除外条件の組み合わせで、実行される日があるか（月〜金は祝日の場合も考える）
function hasRunDay(s: Schedule) {
	return WEEKDAYS.some((_, weekday) => [false, true].some(holiday => {
		if (weekday >= 5 && !holiday) return false
		return modeMatches(s.dayMode, s.weekdays, weekday, holiday) && !modeMatches(s.excludeMode ?? 'none', s.excludeWeekdays ?? [], weekday, holiday)
	}))
}

function timeLabel(s: Schedule) {
	if (!s.end) return formatHm(s.start)
	return `${formatHm(s.start)} – ${endsNextDay(s) ? '翌' : ''}${formatHm(s.end)}`
}

// 操作の選択肢（シーン実行と、機器ごとの各操作）を1つのプルダウンにまとめる
const encodeAction = (a: ScheduleAction | null) => (a ? `${a.kind}:${a.targetId}:${a.command ?? ''}` : '')

function decodeAction(value: string): ScheduleAction | null {
	if (!value) return null
	const [kind, targetId, command] = value.split(':')
	return { kind: kind as ScheduleAction['kind'], targetId, command: command || null }
}

function ActionSelect({ value, onChange, devices, scenes, noneLabel }: {
	value: ScheduleAction | null
	onChange: (a: ScheduleAction | null) => void
	devices: Device[]
	scenes: Scene[]
	noneLabel: string
}) {
	const groups = [
		{ label: '物理機器', items: devices.filter(d => d.kind === 'device') },
		{ label: '赤外線リモコン', items: devices.filter(d => d.kind === 'ir') },
	]
	return (
		<select value={encodeAction(value)} onChange={e => onChange(decodeAction(e.target.value))}>
			<option value="">{noneLabel}</option>
			<optgroup label="シーン">
				{scenes.map(s => <option key={s.id} value={`scene:${s.id}:`}>{s.name}</option>)}
			</optgroup>
			{groups.map(group => (
				<optgroup key={group.label} label={group.label}>
					{group.items.flatMap(d => deviceActions(d).map(a => (
						<option key={`${d.id}:${a.command}`} value={`device:${d.id}:${a.command}`}>{d.name} – {a.label}</option>
					)))}
				</optgroup>
			))}
		</select>
	)
}

function ScheduleForm({ initial, isNew, devices, scenes, onSave, onClose }: {
	initial: Schedule
	isNew: boolean
	devices: Device[]
	scenes: Scene[]
	onSave: (s: Schedule) => void
	onClose: () => void
}) {
	const [draft, setDraft] = React.useState<Schedule>({ excludeMode: 'none', excludeWeekdays: [], ...initial })
	const [error, setError] = React.useState('')
	const set = (patch: Partial<Schedule>) => setDraft(d => ({ ...d, ...patch }))
	const excludeWeekdays = draft.excludeWeekdays ?? []

	const toggle = (list: number[], i: number) => (list.includes(i) ? list.filter(w => w !== i) : [...list, i].sort())

	const submit = (e: React.FormEvent) => {
		e.preventDefault()
		if (!draft.start) return setError('開始時刻を入力してください')
		if (!draft.startAction) return setError('開始時の操作を選んでください')
		if (draft.dayMode === 'days' && draft.weekdays.length === 0) return setError('曜日を1つ以上選んでください')
		if (draft.excludeMode === 'days' && excludeWeekdays.length === 0) return setError('除外する曜日を1つ以上選んでください')
		if (!hasRunDay(draft)) return setError('この日付条件と除外の組み合わせでは、実行される日がありません')
		if (draft.end && !draft.endAction) return setError('終了時刻を入れた場合は、終了時の操作も選んでください')
		if (draft.end === draft.start) return setError('開始時刻と終了時刻が同じです')
		onSave({ ...draft, name: draft.name.trim(), end: draft.end || null, endAction: draft.end ? draft.endAction : null })
	}

	return (
		<Modal title={isNew ? 'スケジュールを追加' : 'スケジュールを編集'} onClose={onClose}>
			<form className="form" onSubmit={submit}>
				<label>名前<input value={draft.name} onChange={e => set({ name: e.target.value })} placeholder="例: 平日の冷房" /></label>
				<fieldset>
					<legend>日付条件</legend>
					<div className="radios">
						{DAY_MODES.map(([key, label]) => (
							<label key={key}><input type="radio" checked={draft.dayMode === key} onChange={() => set({ dayMode: key })} />{label}</label>
						))}
					</div>
					{draft.dayMode === 'days' && (
						<div className="radios">
							{WEEKDAYS.map((w, i) => (
								<label key={w}><input type="checkbox" checked={draft.weekdays.includes(i)} onChange={() => set({ weekdays: toggle(draft.weekdays, i) })} />{w}</label>
							))}
						</div>
					)}
				</fieldset>
				<fieldset>
					<legend>除外する日</legend>
					<div className="radios">
						{EXCLUDE_MODES.map(([key, label]) => (
							<label key={key}><input type="radio" checked={draft.excludeMode === key} onChange={() => set({ excludeMode: key })} />{label}</label>
						))}
					</div>
					{draft.excludeMode === 'days' && (
						<div className="radios">
							{WEEKDAYS.map((w, i) => (
								<label key={w}><input type="checkbox" checked={excludeWeekdays.includes(i)} onChange={() => set({ excludeWeekdays: toggle(excludeWeekdays, i) })} />{w}</label>
							))}
						</div>
					)}
					<small>平日は月〜金のうち祝日（振替休日を含む）でない日、休日は土日と祝日です。翌日にまたがる終了は、開始した日で判定します。</small>
				</fieldset>
				<fieldset>
					<legend>時間条件</legend>
					<div className="time-row">
						<label>開始<input type="time" value={draft.start} onChange={e => set({ start: e.target.value })} required /></label>
						<span>–</span>
						<label>終了（任意）<input type="time" value={draft.end ?? ''} onChange={e => set({ end: e.target.value || null })} /></label>
						{endsNextDay(draft) && <span className="next-day">翌日</span>}
						{draft.end && <button type="button" className="ghost" onClick={() => set({ end: null })}>終了なし</button>}
					</div>
				</fieldset>
				<label>開始時の操作
					<ActionSelect value={draft.startAction} onChange={a => set({ startAction: a })} devices={devices} scenes={scenes} noneLabel="選択してください" />
				</label>
				{draft.end && (
					<label>終了時の操作
						<ActionSelect value={draft.endAction} onChange={a => set({ endAction: a })} devices={devices} scenes={scenes} noneLabel="選択してください" />
					</label>
				)}
				{error && <p className="error">{error}</p>}
				<div className="form-actions">
					<button type="button" className="ghost" onClick={onClose}>キャンセル</button>
					<button type="submit">保存</button>
				</div>
			</form>
		</Modal>
	)
}

function OutingForm({ initial, isNew, schedules, onSave, onClose }: {
	initial: Outing
	isNew: boolean
	schedules: Schedule[]
	onSave: (o: Outing) => void
	onClose: () => void
}) {
	const [draft, setDraft] = React.useState(initial)
	const [error, setError] = React.useState('')
	const set = (patch: Partial<Outing>) => setDraft(d => ({ ...d, ...patch }))

	const toggleTarget = (id: string) =>
		set({ targetIds: draft.targetIds.includes(id) ? draft.targetIds.filter(t => t !== id) : [...draft.targetIds, id] })

	const submit = (e: React.FormEvent) => {
		e.preventDefault()
		if (!draft.start || !draft.end) return setError('期間を入力してください')
		if (draft.end <= draft.start) return setError('終了日時は開始日時より後にしてください')
		if (!draft.allTargets && draft.targetIds.length === 0) return setError('対象のスケジュールを1つ以上選んでください')
		onSave({ ...draft, name: draft.name.trim() })
	}

	return (
		<Modal title={isNew ? '外出予定を追加' : '外出予定を編集'} onClose={onClose}>
			<form className="form" onSubmit={submit}>
				<label>名前<input value={draft.name} onChange={e => set({ name: e.target.value })} placeholder="例: 旅行" /></label>
				<fieldset>
					<legend>期間</legend>
					<div className="time-row">
						<label>開始<input type="datetime-local" value={draft.start} onClick={openPicker} onChange={e => set({ start: e.target.value })} required /></label>
						<span>–</span>
						<label>終了<input type="datetime-local" value={draft.end} onClick={openPicker} onChange={e => set({ end: e.target.value })} required /></label>
					</div>
				</fieldset>
				<fieldset>
					<legend>この期間だけオフにするスケジュール</legend>
					<div className="radios">
						<label><input type="radio" checked={draft.allTargets} onChange={() => set({ allTargets: true })} />すべて</label>
						<label><input type="radio" checked={!draft.allTargets} onChange={() => set({ allTargets: false })} />選択したもの</label>
					</div>
					{!draft.allTargets && (
						<div className="target-list">
							{schedules.length === 0 && <small>スケジュールがありません</small>}
							{schedules.map(s => (
								<label key={s.id}>
									<input type="checkbox" checked={draft.targetIds.includes(s.id)} onChange={() => toggleTarget(s.id)} />
									{s.name || '（名前なし）'}<small>{dayLabel(s)} {timeLabel(s)}</small>
								</label>
							))}
						</div>
					)}
				</fieldset>
				{error && <p className="error">{error}</p>}
				<div className="form-actions">
					<button type="button" className="ghost" onClick={onClose}>キャンセル</button>
					<button type="submit">保存</button>
				</div>
			</form>
		</Modal>
	)
}

export function SchedulePage({ onLogout }: { onLogout: () => void }) {
	const queryClient = useQueryClient()
	const { showToast, toastElement } = useToast()
	const [editingSchedule, setEditingSchedule] = React.useState<Schedule | null>(null)
	const [editingOuting, setEditingOuting] = React.useState<Outing | null>(null)
	const [saving, setSaving] = React.useState(false)

	const handleError = (err: unknown) => {
		if (err instanceof UnauthorizedError) onLogout()
		else showToast(errorMessage(err), true)
	}

	const devicesQuery = useQuery({ queryKey: ['devices'], queryFn: () => api<DevicesResponse>('/devices'), retry: false })
	const scenesQuery = useQuery({ queryKey: ['scenes'], queryFn: () => api<{ scenes: Scene[] }>('/scenes'), retry: false })
	// 次回の予定・最終実行の結果を追うため、1分ごとに取り直す（SwitchBot API は呼ばない）
	const schedulesQuery = useQuery({
		queryKey: ['schedules'],
		queryFn: () => api<SchedulesResponse>('/schedules'),
		retry: false,
		refetchInterval: 60_000,
	})

	React.useEffect(() => {
		for (const q of [devicesQuery, scenesQuery, schedulesQuery]) if (q.error) handleError(q.error)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [devicesQuery.error, scenesQuery.error, schedulesQuery.error])

	const devices = devicesQuery.data?.devices ?? []
	const scenes = scenesQuery.data?.scenes ?? []
	const data = schedulesQuery.data
	const schedules = data?.schedules ?? []
	const outings = data?.outings ?? []
	const now = data?.status.now ?? ''

	const save = async (next: ScheduleData, message: string) => {
		setSaving(true)
		try {
			const result = await api<SchedulesResponse>('/schedules', { method: 'PUT', body: JSON.stringify(next) })
			queryClient.setQueryData(['schedules'], result)
			showToast(message)
			return true
		} catch (err) {
			handleError(err)
			return false
		} finally {
			setSaving(false)
		}
	}

	const saveSchedule = async (s: Schedule) => {
		const exists = schedules.some(x => x.id === s.id)
		const next = exists ? schedules.map(x => (x.id === s.id ? s : x)) : [...schedules, s]
		if (await save({ schedules: next, outings }, exists ? 'スケジュールを更新しました' : 'スケジュールを追加しました')) setEditingSchedule(null)
	}

	const saveOuting = async (o: Outing) => {
		const exists = outings.some(x => x.id === o.id)
		const next = exists ? outings.map(x => (x.id === o.id ? o : x)) : [...outings, o]
		if (await save({ schedules, outings: next }, exists ? '外出予定を更新しました' : '外出予定を追加しました')) setEditingOuting(null)
	}

	const toggleSchedule = (s: Schedule) =>
		save({ schedules: schedules.map(x => (x.id === s.id ? { ...x, enabled: !x.enabled } : x)), outings }, `「${s.name || '名前なし'}」を${s.enabled ? 'オフ' : 'オン'}にしました`)

	const toggleOuting = (o: Outing) =>
		save({ schedules, outings: outings.map(x => (x.id === o.id ? { ...x, enabled: !x.enabled } : x)) }, `「${o.name || '名前なし'}」を${o.enabled ? 'オフ' : 'オン'}にしました`)

	const deleteSchedule = (s: Schedule) => {
		if (!window.confirm(`スケジュール「${s.name || '名前なし'}」を削除しますか？`)) return
		save({ schedules: schedules.filter(x => x.id !== s.id), outings }, 'スケジュールを削除しました')
	}

	const deleteOuting = (o: Outing) => {
		if (!window.confirm(`外出予定「${o.name || '名前なし'}」を削除しますか？`)) return
		save({ schedules, outings: outings.filter(x => x.id !== o.id) }, '外出予定を削除しました')
	}

	const newSchedule = (): Schedule => ({
		id: crypto.randomUUID(), name: '', enabled: true, dayMode: 'everyday', weekdays: [], excludeMode: 'none', excludeWeekdays: [], start: '07:00', end: null, startAction: null, endAction: null,
	})

	const newOuting = (): Outing => {
		const start = new Date()
		start.setMinutes(0, 0, 0)
		start.setHours(start.getHours() + 1)
		const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)
		return { id: crypto.randomUUID(), name: '', enabled: true, start: toLocalInput(start), end: toLocalInput(end), allTargets: true, targetIds: [] }
	}

	const actionLabel = (a: ScheduleAction | null) => {
		if (!a) return <span className="muted">—</span>
		if (a.kind === 'scene') return <>シーン「{scenes.find(s => s.id === a.targetId)?.name ?? '（不明）'}」</>
		const device = devices.find(d => d.id === a.targetId)
		if (!device) return <span className="error">（不明な機器）</span>
		const label = deviceActions(device).find(x => x.command === a.command)?.label ?? a.command
		return <>{device.name} – {label}</>
	}

	const runLabel = (run: RunInfo | null | undefined) =>
		run ? `${formatDateTime(run.at)} ${run.edge === 'start' ? '開始' : '終了'}` : '—'

	const outingState = (o: Outing) => {
		if (!o.enabled) return { label: 'オフ', className: 'muted' }
		if (now < o.start) return { label: '予定', className: '' }
		if (now < o.end) return { label: '外出中', className: 'power-on' }
		return { label: '終了', className: 'muted' }
	}

	const sortedSchedules = [...schedules].sort((a, b) => a.start.localeCompare(b.start))
	const sortedOutings = [...outings].sort((a, b) => a.start.localeCompare(b.start))
	const today = data?.status.today

	return (
		<main>
			<Header page="schedule" onLogout={onLogout}>
				{today && (
					<small>
						今日 {today.date.slice(5).replace('-', '/')}({today.weekday}) {today.holidayName ?? (today.holiday ? '休日' : '平日')}
					</small>
				)}
			</Header>

			{data && !data.status.schedulerEnabled && (
				<p className="notice">このサーバーではスケジュールを実行しません（本番サーバーだけで実行します）。登録・確認はできます。</p>
			)}

			<section>
				<div className="section-head">
					<h2>スケジュール</h2>
					<button onClick={() => setEditingSchedule(newSchedule())} disabled={!data}><Plus size={16} /> 追加</button>
				</div>
				<div className="table-wrap">
					<table>
						<thead>
							<tr><th>有効</th><th>名前</th><th>日付</th><th>時間</th><th>開始時の操作</th><th>終了時の操作</th><th>次回</th><th>最終実行</th><th></th></tr>
						</thead>
						<tbody>
							{sortedSchedules.map(s => {
								const last = data?.lastRuns[s.id]
								return (
									<tr key={s.id} className={s.enabled ? '' : 'disabled'}>
										<td><input type="checkbox" className="switch" checked={s.enabled} onChange={() => toggleSchedule(s)} disabled={saving} aria-label="有効" /></td>
										<td>{s.name || <span className="muted">（名前なし）</span>}</td>
										<td>{dayLabel(s)}</td>
										<td className="nowrap">{timeLabel(s)}</td>
										<td>{actionLabel(s.startAction)}</td>
										<td>{s.end ? actionLabel(s.endAction) : <span className="muted">—</span>}</td>
										<td className="nowrap">{runLabel(data?.nextRuns[s.id])}</td>
										<td className="nowrap">
											{last ? (
												<span title={last.message}>
													{runLabel(last)} <span className={last.result === 'ok' ? 'power-on' : last.result === 'error' ? 'error' : 'muted'}>{RESULT_LABELS[last.result]}</span>
												</span>
											) : '—'}
										</td>
										<td className="row-actions">
											<button className="icon" onClick={() => setEditingSchedule(s)} title="編集"><Pencil size={14} /></button>
											<button className="icon" onClick={() => deleteSchedule(s)} title="削除" disabled={saving}><Trash2 size={14} /></button>
										</td>
									</tr>
								)
							})}
							{data && schedules.length === 0 && <tr><td colSpan={9} className="muted">スケジュールはまだありません</td></tr>}
						</tbody>
					</table>
				</div>
			</section>

			<section>
				<div className="section-head">
					<h2>外出予定</h2>
					<button onClick={() => setEditingOuting(newOuting())} disabled={!data}><Plus size={16} /> 追加</button>
				</div>
				<div className="table-wrap">
					<table>
						<thead>
							<tr><th>有効</th><th>名前</th><th>期間</th><th>オフにするスケジュール</th><th>状態</th><th></th></tr>
						</thead>
						<tbody>
							{sortedOutings.map(o => {
								const state = outingState(o)
								const targets = o.allTargets ? 'すべて' : o.targetIds.map(id => schedules.find(s => s.id === id)?.name || '（名前なし）').join('、') || '—'
								return (
									<tr key={o.id} className={o.enabled ? '' : 'disabled'}>
										<td><input type="checkbox" className="switch" checked={o.enabled} onChange={() => toggleOuting(o)} disabled={saving} aria-label="有効" /></td>
										<td>{o.name || <span className="muted">（名前なし）</span>}</td>
										<td className="nowrap">{formatDateTime(o.start)} – {formatDateTime(o.end)}</td>
										<td>{targets}</td>
										<td className={state.className}>{state.label}</td>
										<td className="row-actions">
											<button className="icon" onClick={() => setEditingOuting(o)} title="編集"><Pencil size={14} /></button>
											<button className="icon" onClick={() => deleteOuting(o)} title="削除" disabled={saving}><Trash2 size={14} /></button>
										</td>
									</tr>
								)
							})}
							{data && outings.length === 0 && <tr><td colSpan={6} className="muted">外出予定はまだありません</td></tr>}
						</tbody>
					</table>
				</div>
			</section>

			{editingSchedule && (
				<ScheduleForm initial={editingSchedule} isNew={!schedules.some(s => s.id === editingSchedule.id)} devices={devices} scenes={scenes} onSave={saveSchedule} onClose={() => setEditingSchedule(null)} />
			)}
			{editingOuting && (
				<OutingForm initial={editingOuting} isNew={!outings.some(o => o.id === editingOuting.id)} schedules={sortedSchedules} onSave={saveOuting} onClose={() => setEditingOuting(null)} />
			)}
			{toastElement}
		</main>
	)
}
