import React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, Pencil, Play, Plus, RefreshCw, Trash2, Type } from 'lucide-react'
import {
	Device, DevicesResponse, Header, PopupMenu, Scene, StatusesResponse, StatusView, UnauthorizedError,
	api, deviceActions, errorMessage, executeScene, hasStatus, sendCommand, useHash, useToast,
} from './common'

type WidgetKind = 'status' | 'action' | 'scene' | 'group'

type Widget = {
	id: string
	kind: WidgetKind
	targetId: string
	command?: string | null
	label: string
	x: number
	y: number
	w: number
	h: number
}

// members はグループを動かすときに一緒に動かすウィジェット（ドラッグ開始時の位置）
type Drag = { id: string; mode: 'move' | 'resize'; startX: number; startY: number; orig: Widget; members: Widget[] }

type SaveState = 'saved' | 'saving' | 'error'

const SAVE_LABELS: Record<SaveState, string> = { saved: '保存済み', saving: '保存中', error: '保存に失敗しました' }

type Target = { group?: boolean; device?: Device; scene?: Scene }

const GRID = 10
const MIN_W = 60
const MIN_H = 40
const GROUP_KEY = 'group:'
const DEFAULT_SIZE: Record<WidgetKind, { w: number; h: number }> = {
	status: { w: 220, h: 150 },
	action: { w: 140, h: 60 },
	scene: { w: 180, h: 60 },
	group: { w: 340, h: 240 },
}

const snap = (v: number) => Math.round(v / GRID) * GRID

const formatClock = (sec: number) => new Date(sec * 1000).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })

const contains = (group: Widget, x: number, y: number) =>
	x >= group.x && x <= group.x + group.w && y >= group.y && y <= group.y + group.h

// ウィジェットの中心が枠内にあるグループのうち、いちばん小さいものに属する
function ownerGroupId(widget: Widget, items: Widget[]): string | null {
	if (widget.kind === 'group') return null
	const cx = widget.x + widget.w / 2
	const cy = widget.y + widget.h / 2
	const owners = items.filter(g => g.kind === 'group' && contains(g, cx, cy)).sort((a, b) => a.w * a.h - b.w * b.h)
	return owners[0]?.id ?? null
}

// 追加プルダウンで選べる中身（グループ枠・状態表示・各操作ボタン・シーン実行）
function contentOptions(target: Target): { key: string; label: string }[] {
	if (target.group) return [{ key: 'group', label: 'グループ枠' }]
	if (target.scene) return [{ key: 'scene', label: 'シーン実行ボタン' }]
	const device = target.device
	if (!device) return []
	const options = deviceActions(device).map(a => ({ key: `action:${a.command}`, label: `ボタン: ${a.label}` }))
	if (hasStatus(device) || device.kind === 'ir') options.unshift({ key: 'status', label: '状態表示' })
	return options
}

type LayoutDoc = { id: string; name: string; widgets: Widget[] }

type LayoutsResponse = { layouts: LayoutDoc[] }

const LAST_LAYOUT_KEY = 'switchbot_home_last_layout'

const layoutLabel = (layout: LayoutDoc, index: number) => layout.name || `レイアウト ${index + 1}`

// URL では名前があれば名前、無ければ id で指す
const layoutPath = (layout: LayoutDoc) => `#/layout/${encodeURIComponent(layout.name || layout.id)}`

// 他のレイアウトから写すときは、ウィジェットの id を振り直す
const cloneWidgets = (items: Widget[]) => items.map(w => ({ ...w, id: crypto.randomUUID() }))

function LayoutEditor({ layout, layouts, onLogout, onSelect, onCreate, onDelete, onRename }: {
	layout: LayoutDoc
	layouts: LayoutDoc[]
	onLogout: () => void
	onSelect: (id: string) => void
	onCreate: () => void
	onDelete: (id: string) => void
	onRename: (id: string, name: string) => Promise<string | null>
}) {
	const queryClient = useQueryClient()
	const { showToast, toastElement } = useToast()
	const [widgets, setWidgets] = React.useState<Widget[]>(layout.widgets)
	// 何も置いていなければ最初から編集モードにする
	const [editing, setEditing] = React.useState(layout.widgets.length === 0)
	const [activeId, setActiveId] = React.useState<string | null>(null)
	const [busy, setBusy] = React.useState<string | null>(null)
	const [refreshing, setRefreshing] = React.useState(false)
	const [saveState, setSaveState] = React.useState<SaveState>('saved')
	const [targetKey, setTargetKey] = React.useState('')
	const [contentKey, setContentKey] = React.useState('')
	const [canvasWidth, setCanvasWidth] = React.useState(0)
	const canvasRef = React.useRef<HTMLDivElement>(null)
	const drag = React.useRef<Drag | null>(null)
	const pendingSave = React.useRef(false)
	const latestWidgets = React.useRef<Widget[]>(layout.widgets)

	const handleError = (err: unknown) => {
		if (err instanceof UnauthorizedError) onLogout()
		else showToast(errorMessage(err), true)
	}

	const devicesQuery = useQuery({ queryKey: ['devices'], queryFn: () => api<DevicesResponse>('/devices'), retry: false })
	const scenesQuery = useQuery({ queryKey: ['scenes'], queryFn: () => api<{ scenes: Scene[] }>('/scenes'), retry: false })

	const devices = React.useMemo(() => new Map((devicesQuery.data?.devices ?? []).map(d => [d.id, d])), [devicesQuery.data])
	const scenes = React.useMemo(() => new Map((scenesQuery.data?.scenes ?? []).map(s => [s.id, s])), [scenesQuery.data])

	// 状態はレイアウトに置いた「状態表示」の機器だけ取得する（API 呼び出し回数を抑えるため）
	const statusIds = React.useMemo(() => {
		const ids = widgets.filter(w => w.kind === 'status' && devices.get(w.targetId) && hasStatus(devices.get(w.targetId)!)).map(w => w.targetId)
		return [...new Set(ids)].sort()
	}, [widgets, devices])
	const statusesKey = ['layout-statuses', statusIds.join(',')]
	const statusesQuery = useQuery({
		queryKey: statusesKey,
		queryFn: () => api<StatusesResponse>('/devices/status', { method: 'POST', body: JSON.stringify({ ids: statusIds }) }),
		enabled: statusIds.length > 0,
		retry: false,
		staleTime: 30_000,
	})
	const statuses = statusesQuery.data?.statuses ?? {}

	React.useEffect(() => {
		for (const q of [devicesQuery, scenesQuery, statusesQuery]) if (q.error) handleError(q.error)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [devicesQuery.error, scenesQuery.error, statusesQuery.error])

	const save = React.useCallback(async (items: Widget[]) => {
		pendingSave.current = false
		setSaveState('saving')
		try {
			await api(`/layouts/${layout.id}`, { method: 'PUT', body: JSON.stringify({ widgets: items }) })
			queryClient.setQueryData<LayoutsResponse>(['layouts'], old => old && {
				layouts: old.layouts.map(l => (l.id === layout.id ? { ...l, widgets: items } : l)),
			})
			setSaveState('saved')
		} catch (err) {
			setSaveState('error')
			handleError(err)
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [queryClient, layout.id])

	// 変更は少し待ってまとめて保存する（ドラッグ中に毎回保存しないため）
	React.useEffect(() => {
		latestWidgets.current = widgets
		if (!pendingSave.current) return
		const timer = window.setTimeout(() => save(widgets), 600)
		return () => window.clearTimeout(timer)
	}, [widgets, save])

	// ページを離れるときに未保存の変更があれば保存する
	React.useEffect(() => () => {
		if (pendingSave.current) void save(latestWidgets.current)
	}, [save])

	// 横スクロールはさせないので、キャンバスの幅（縦スクロールバーの分を除く）を配置できる範囲にする
	React.useEffect(() => {
		const el = canvasRef.current
		if (!el) return
		const observer = new ResizeObserver(([entry]) => setCanvasWidth(entry.contentRect.width))
		observer.observe(el)
		return () => observer.disconnect()
	}, [])

	// 幅がまだ測れていないときは制限しない
	const maxRight = canvasWidth ? Math.floor(canvasWidth / GRID) * GRID : Infinity

	const updateWidgets = (fn: (items: Widget[]) => Widget[]) => {
		pendingSave.current = true
		setWidgets(fn)
	}

	const targetOptions = {
		device: (devicesQuery.data?.devices ?? []).filter(d => d.kind === 'device'),
		ir: (devicesQuery.data?.devices ?? []).filter(d => d.kind === 'ir'),
		scene: scenesQuery.data?.scenes ?? [],
	}
	const resolveTarget = (key: string): Target => {
		if (key === GROUP_KEY) return { group: true }
		const [type, id] = key.split(':')
		return type === 'scene' ? { scene: scenes.get(id) } : { device: devices.get(id) }
	}
	const targetId = targetKey.split(':')[1] ?? ''
	const target = resolveTarget(targetKey)
	const contents = contentOptions(target)

	const selectTarget = (key: string) => {
		setTargetKey(key)
		setContentKey(contentOptions(resolveTarget(key))[0]?.key ?? '')
	}

	const addWidget = () => {
		if (!targetKey || !contentKey) return
		const [kindPart, command] = contentKey.split(':')
		const kind = kindPart as WidgetKind
		const name = target.group ? 'グループ' : target.scene?.name ?? target.device?.name ?? ''
		const actionLabel = target.device ? deviceActions(target.device).find(a => a.command === command)?.label : undefined
		const bottom = widgets.reduce((max, w) => Math.max(max, w.y + w.h), 0)
		const size = DEFAULT_SIZE[kind]
		const widget: Widget = {
			id: crypto.randomUUID(),
			kind,
			targetId,
			command: kind === 'action' ? command : null,
			label: kind === 'action' ? `${name} ${actionLabel ?? command}` : name,
			x: GRID * 2,
			y: widgets.length ? bottom + GRID * 2 : GRID * 2,
			w: Math.max(MIN_W, Math.min(size.w, maxRight - GRID * 2)),
			h: size.h,
		}
		updateWidgets(items => [...items, widget])
		setActiveId(widget.id)
	}

	const copyFrom = (source: LayoutDoc, index: number) => {
		if (widgets.length && !window.confirm(`今の配置を消して、${layoutLabel(source, index)} の内容に置き換えますか？`)) return
		updateWidgets(() => cloneWidgets(source.widgets))
		setActiveId(null)
		showToast(`${layoutLabel(source, index)} からコピーしました`)
	}

	const deleteLayout = () => {
		if (!window.confirm(`${layoutLabel(layout, currentIndex)} を削除しますか？（元に戻せません）`)) return
		pendingSave.current = false
		onDelete(layout.id)
	}

	const renameLayout = async () => {
		const name = window.prompt('レイアウトの名前（URL の #/layout/名前 で開けます。空にすると番号表示に戻ります）', layout.name)
		if (name === null) return
		const error = await onRename(layout.id, name.trim())
		if (error) showToast(error, true)
		else showToast(name.trim() ? `名前を「${name.trim()}」にしました` : '名前を消しました')
	}

	const removeWidget = (id: string) => updateWidgets(items => items.filter(w => w.id !== id))

	const renameWidget = (widget: Widget) => {
		const label = window.prompt('表示名', widget.label)
		if (label === null) return
		updateWidgets(items => items.map(w => (w.id === widget.id ? { ...w, label: label.trim() || w.label } : w)))
	}

	const startDrag = (e: React.PointerEvent, widget: Widget, mode: Drag['mode']) => {
		if (!editing || e.button !== 0) return
		e.preventDefault()
		e.stopPropagation()
		e.currentTarget.setPointerCapture(e.pointerId)
		const members = widget.kind === 'group' && mode === 'move' ? widgets.filter(w => ownerGroupId(w, widgets) === widget.id) : []
		drag.current = { id: widget.id, mode, startX: e.clientX, startY: e.clientY, orig: widget, members }
		setActiveId(widget.id)
	}

	const moveDrag = (e: React.PointerEvent) => {
		const d = drag.current
		if (!d) return
		const dx = e.clientX - d.startX
		const dy = e.clientY - d.startY
		const next = d.mode === 'move'
			? { x: Math.max(0, Math.min(maxRight - d.orig.w, snap(d.orig.x + dx))), y: Math.max(0, snap(d.orig.y + dy)) }
			: { w: Math.max(MIN_W, Math.min(maxRight - d.orig.x, snap(d.orig.w + dx))), h: Math.max(MIN_H, snap(d.orig.h + dy)) }
		const current = widgets.find(w => w.id === d.id)
		if (current && Object.entries(next).every(([k, v]) => current[k as keyof Widget] === v)) return
		// グループを動かしたときは、枠と同じだけメンバーも動かす
		const moved = new Map(d.members.map(m => [m.id, {
			x: Math.max(0, Math.min(maxRight - m.w, m.x + (next.x ?? d.orig.x) - d.orig.x)),
			y: Math.max(0, m.y + (next.y ?? d.orig.y) - d.orig.y),
		}]))
		updateWidgets(items => items.map(w => (w.id === d.id ? { ...w, ...next } : moved.has(w.id) ? { ...w, ...moved.get(w.id) } : w)))
	}

	const endDrag = () => {
		drag.current = null
	}

	// 状態を取り直し、取得に失敗した機器の数を返す
	const fetchStatuses = async (ids: string[]) => {
		if (ids.length === 0) return 0
		const data = await api<StatusesResponse>('/devices/status', { method: 'POST', body: JSON.stringify({ ids, refresh: true }) })
		queryClient.setQueryData<StatusesResponse>(statusesKey, old => ({
			statuses: { ...(old?.statuses ?? {}), ...data.statuses },
			usage: data.usage,
		}))
		return Object.values(data.statuses).filter(entry => entry.error).length
	}

	const refreshStatuses = async (ids: string[]) => {
		try {
			await fetchStatuses(ids)
		} catch (err) {
			handleError(err)
		}
	}

	const currentIndex = Math.max(0, layouts.findIndex(l => l.id === layout.id))

	const statusWidgetCount = new Set(widgets.filter(w => w.kind === 'status').map(w => w.targetId)).size

	const refreshAll = async () => {
		setRefreshing(true)
		try {
			const failed = await fetchStatuses(statusIds)
			// 赤外線の「最後の操作」は機器一覧に含まれる（サーバー側のキャッシュ内なので SwitchBot は呼ばない）
			await queryClient.invalidateQueries({ queryKey: ['devices'] })
			if (failed) showToast(`${failed}台の状態を取得できませんでした`, true)
			else showToast(`${statusWidgetCount}件の状態表示を更新しました`)
		} catch (err) {
			handleError(err)
		} finally {
			setRefreshing(false)
		}
	}

	const runWidget = async (widget: Widget) => {
		setBusy(widget.id)
		try {
			if (widget.kind === 'scene') {
				await executeScene(widget.targetId)
				showToast(`シーン「${widget.label}」を実行しました`)
				return
			}
			const device = devices.get(widget.targetId)
			const action = device && deviceActions(device).find(a => a.command === widget.command)
			if (!device || !widget.command) return
			if (action?.confirm && !window.confirm(action.confirm)) return
			await sendCommand(device.id, widget.command)
			showToast(widget.label)
			if (device.kind === 'ir') await queryClient.invalidateQueries({ queryKey: ['devices'] })
			else if (statusIds.includes(device.id)) window.setTimeout(() => refreshStatuses([device.id]), 1500)
		} catch (err) {
			handleError(err)
		} finally {
			setBusy(null)
		}
	}

	// 選択中のウィジェットが入るグループ（編集中に枠を強調して、どこに属するか分かるようにする）
	const activeWidget = widgets.find(w => w.id === activeId)
	const activeOwnerId = activeWidget ? ownerGroupId(activeWidget, widgets) : null

	// 高さは中身に合わせて伸ばす（枠より小さいときは CSS の min-height で枠いっぱいにする）
	const canvasHeight = widgets.reduce((max, w) => Math.max(max, w.y + w.h), 0) + 200

	return (
		<main className="layout-page">
			<Header
				page="layout"
				onLogout={onLogout}
				layoutMenu={[
					{ key: 'new', label: <><Plus size={14} /> 新規レイアウト</>, onSelect: onCreate },
					...layouts.map((l, i) => ({ key: l.id, label: layoutLabel(l, i), active: l.id === layout.id, onSelect: () => onSelect(l.id) })),
				]}
				layoutMenuLabel={layoutLabel(layout, currentIndex)}
			>
				<button onClick={refreshAll} disabled={statusWidgetCount === 0 || refreshing} title="状態表示を再取得">
					<RefreshCw size={16} className={refreshing ? 'spin' : ''} /><span className="btn-text">状態を更新</span>
				</button>
				<button
					className={editing ? 'active has-dot' : 'has-dot'}
					onClick={() => { setEditing(!editing); setActiveId(null) }}
					title={`${editing ? '編集を終える' : 'レイアウトを編集'}（${SAVE_LABELS[saveState]}）`}
					aria-label={`${editing ? '完了' : '編集'}（${SAVE_LABELS[saveState]}）`}
				>
					{editing ? <><Check size={16} /><span className="btn-text">完了</span></> : <><Pencil size={16} /><span className="btn-text">編集</span></>}
					{/* 保存状態は右上の点で示す（保存済み: 緑、保存中: 黄、失敗: 赤） */}
					<span className={`save-dot ${saveState}`} aria-hidden="true" />
				</button>
			</Header>

			{editing && (
				<div className="layout-toolbar">
					<select value={targetKey} onChange={e => selectTarget(e.target.value)}>
						<option value="">追加する機器・シーンを選択</option>
						<option value={GROUP_KEY}>空のグループ</option>
						<optgroup label="物理機器">
							{targetOptions.device.map(d => <option key={d.id} value={`device:${d.id}`}>{d.name}（{d.type}）</option>)}
						</optgroup>
						<optgroup label="赤外線リモコン">
							{targetOptions.ir.map(d => <option key={d.id} value={`device:${d.id}`}>{d.name}（{d.type}）</option>)}
						</optgroup>
						<optgroup label="シーン">
							{targetOptions.scene.map(s => <option key={s.id} value={`scene:${s.id}`}>{s.name}</option>)}
						</optgroup>
					</select>
					<select value={contentKey} onChange={e => setContentKey(e.target.value)} disabled={contents.length === 0}>
						{contents.length === 0 && <option value="">{targetKey ? '追加できるものがありません' : '—'}</option>}
						{contents.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
					</select>
					<button onClick={addWidget} disabled={!contentKey}><Plus size={16} /> 追加</button>
					<PopupMenu
						label={<><Copy size={16} /> 別のレイアウトからコピー</>}
						disabled={layouts.length < 2}
						items={layouts.map((l, i) => ({ key: l.id, label: `${layoutLabel(l, i)}（${l.widgets.length}個）`, disabled: l.id === layout.id, onSelect: () => copyFrom(l, i) }))}
					/>
					<button className="ghost" onClick={renameLayout}><Type size={16} /> 名前を変更</button>
					{layouts.length > 1 && (
						<button className="ghost danger" onClick={deleteLayout}><Trash2 size={16} /> このレイアウトを削除</button>
					)}
				</div>
			)}

			<div className="canvas-wrap">
				<div
					ref={canvasRef}
					className={editing ? 'canvas editing' : 'canvas'}
					style={{ height: canvasHeight }}
					onPointerDown={() => setActiveId(null)}
				>
					{widgets.length === 0 && (
						<p className="canvas-empty muted">上のプルダウンから機器やシーンを選んで「追加」してください。</p>
					)}
					{/* グループは常に他のウィジェットより奥に描く */}
					{[...widgets.filter(w => w.kind === 'group'), ...widgets.filter(w => w.kind !== 'group')].map(widget => {
						const isGroup = widget.kind === 'group'
						const device = widget.kind === 'scene' || isGroup ? undefined : devices.get(widget.targetId)
						const missing = isGroup ? false : widget.kind === 'scene' ? !scenes.has(widget.targetId) && scenesQuery.isSuccess : !device && devicesQuery.isSuccess
						const classes = ['widget', `widget-${widget.kind}`]
						if (activeId === widget.id) classes.push('active')
						if (isGroup && editing && widget.id === activeOwnerId) classes.push('drop-target')
						return (
							<div
								key={widget.id}
								className={classes.join(' ')}
								style={{ left: widget.x, top: widget.y, width: widget.w, height: widget.h }}
								onPointerDown={e => startDrag(e, widget, 'move')}
								onPointerMove={moveDrag}
								onPointerUp={endDrag}
								onPointerCancel={endDrag}
							>
								{widget.kind === 'status' && device && statuses[device.id]?.fetchedAt && (
									<small className="widget-time">{formatClock(statuses[device.id].fetchedAt!)}</small>
								)}
								<div className="widget-body">
									{isGroup ? (
										<div className="widget-title">{widget.label}</div>
									) : widget.kind === 'status' ? (
										<>
											<div className="widget-title">{widget.label}</div>
											{device ? <StatusView device={device} entry={statuses[device.id]} /> : <p className="status muted">{missing ? '機器が見つかりません' : '読み込み中...'}</p>}
										</>
									) : (
										<button className="widget-button" onClick={() => runWidget(widget)} disabled={editing || busy !== null || missing}>
											{widget.kind === 'scene' && <Play size={14} />}
											<span>{widget.label}</span>
											{missing && <small>（見つかりません）</small>}
										</button>
									)}
								</div>
								{editing && (
									<>
										<div className="widget-tools" onPointerDown={e => e.stopPropagation()}>
											<button className="icon" onClick={() => renameWidget(widget)} title="表示名を変更"><Type size={12} /></button>
											<button className="icon" onClick={() => removeWidget(widget.id)} title="削除"><Trash2 size={12} /></button>
										</div>
										<div className="widget-resize" onPointerDown={e => startDrag(e, widget, 'resize')} title="ドラッグでサイズ変更" />
									</>
								)}
							</div>
						)
					})}
				</div>
			</div>

			{toastElement}
		</main>
	)
}

export function LayoutPage({ onLogout }: { onLogout: () => void }) {
	const queryClient = useQueryClient()
	const hash = useHash()
	const layoutsQuery = useQuery({ queryKey: ['layouts'], queryFn: () => api<LayoutsResponse>('/layouts'), retry: false })

	React.useEffect(() => {
		if (layoutsQuery.error instanceof UnauthorizedError) onLogout()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [layoutsQuery.error])

	const layouts = layoutsQuery.data?.layouts ?? []
	const requested = hash.match(/^#\/layout\/(.+)$/)?.[1]
	let requestedKey: string | undefined
	try {
		requestedKey = requested && decodeURIComponent(requested)
	} catch {
		requestedKey = requested
	}
	let lastId: string | null = null
	try {
		lastId = localStorage.getItem(LAST_LAYOUT_KEY)
	} catch {
		// localStorage error
	}
	// URL の指定（名前 → id） → 最後に開いたレイアウト → 先頭の順に開く
	const current = (requestedKey && (layouts.find(l => l.name === requestedKey) ?? layouts.find(l => l.id === requestedKey)))
		|| layouts.find(l => l.id === lastId) || layouts[0]

	React.useEffect(() => {
		if (!current) return
		try {
			localStorage.setItem(LAST_LAYOUT_KEY, current.id)
		} catch {
			// localStorage error
		}
	}, [current?.id])

	const handleError = (err: unknown) => {
		if (err instanceof UnauthorizedError) onLogout()
		else window.alert(errorMessage(err))
	}

	const select = (id: string, list = layouts) => {
		const target = list.find(l => l.id === id)
		window.location.hash = target ? layoutPath(target) : `#/layout/${id}`
	}

	// 失敗したときはエラーメッセージを返す
	const rename = async (id: string, name: string) => {
		try {
			await api(`/layouts/${id}`, { method: 'PUT', body: JSON.stringify({ name }) })
		} catch (err) {
			if (err instanceof UnauthorizedError) onLogout()
			return errorMessage(err)
		}
		const next = layouts.map(l => (l.id === id ? { ...l, name } : l))
		queryClient.setQueryData<LayoutsResponse>(['layouts'], { layouts: next })
		select(id, next)
		return null
	}

	const create = async () => {
		const id = crypto.randomUUID()
		try {
			await api(`/layouts/${id}`, { method: 'PUT', body: JSON.stringify({ widgets: [] }) })
			const next = [...layouts, { id, name: '', widgets: [] }]
			queryClient.setQueryData<LayoutsResponse>(['layouts'], { layouts: next })
			select(id, next)
		} catch (err) {
			handleError(err)
		}
	}

	const remove = async (id: string) => {
		try {
			await api(`/layouts/${id}`, { method: 'DELETE' })
			const rest = layouts.filter(l => l.id !== id)
			queryClient.setQueryData<LayoutsResponse>(['layouts'], { layouts: rest })
			if (rest[0]) select(rest[0].id, rest)
		} catch (err) {
			handleError(err)
		}
	}

	if (layoutsQuery.error && !(layoutsQuery.error instanceof UnauthorizedError)) {
		return <main><p className="error">{errorMessage(layoutsQuery.error)}</p></main>
	}
	if (!current) return <main><p className="muted">読み込み中...</p></main>
	// レイアウトを切り替えたら編集中の状態を作り直す
	return <LayoutEditor key={current.id} layout={current} layouts={layouts} onLogout={onLogout} onSelect={select} onCreate={create} onDelete={remove} onRename={rename} />
}
