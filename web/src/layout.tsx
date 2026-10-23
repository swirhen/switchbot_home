import React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, Pencil, Plus, RefreshCw, Search, Trash2, Type } from 'lucide-react'
import {
	COMPACT, Device, DevicesResponse, Header, Modal, PopupMenu, layoutLabel, layoutPath, Scene, StatusesResponse, StatusView, UnauthorizedError,
	api, deviceActions, errorMessage, executeScene, getLastLayoutId, hasStatus, sendCommand, setLastLayoutId, useHash, useToast,
} from './common'
import { ICON_GROUPS, findIcon, suggestIcon, suggestStatusIcon } from './icons'

type WidgetKind = 'status' | 'action' | 'scene' | 'group'

// ボタンの表示（アイコンと文字・アイコンのみ・文字のみ）
type ButtonDisplay = 'both' | 'icon' | 'text'

type Widget = {
	id: string
	kind: WidgetKind
	targetId: string
	command?: string | null
	label: string
	// 未設定（null）は種類ごとの既定。シーンは再生アイコン、機器の操作はアイコンなし
	icon?: string | null
	// 未設定（null）はアイコンがあれば both
	display?: ButtonDisplay | null
	x: number
	y: number
	w: number
	h: number
}

const DISPLAY_LABELS: Record<ButtonDisplay, string> = { both: 'アイコンと文字', icon: 'アイコンのみ', text: '文字のみ' }

const isButton = (widget: Widget) => widget.kind === 'action' || widget.kind === 'scene'

// アイコンを付けられるもの（ボタンと状態表示のタイトル）
const hasIcon = (widget: Widget) => widget.kind !== 'group'

const widgetIconKey = (widget: Pick<Widget, 'kind' | 'icon'>) => widget.icon ?? (widget.kind === 'scene' ? 'play' : null)

// アイコンが無いときは、表示の指定にかかわらず文字を出す
function widgetDisplay(widget: Pick<Widget, 'kind' | 'icon' | 'display'>): ButtonDisplay {
	if (!findIcon(widgetIconKey(widget))) return 'text'
	return widget.display ?? 'both'
}

// ボタンの中身。アイコンの大きさはボタンの大きさに合わせ、縦長のボタンではアイコンを文字の上に置く
function ButtonContent({ widget }: { widget: Pick<Widget, 'kind' | 'icon' | 'display' | 'label' | 'w' | 'h'> }) {
	const display = widgetDisplay(widget)
	const Icon = display === 'text' ? undefined : findIcon(widgetIconKey(widget))?.Icon
	const size = display === 'icon'
		? Math.round(Math.max(18, Math.min(64, Math.min(widget.w, widget.h) * 0.5)))
		: Math.round(Math.max(14, Math.min(28, widget.h * 0.3)))
	const stacked = display === 'both' && widget.h >= 90
	return (
		<span className={stacked ? 'button-content stacked' : 'button-content'}>
			{Icon && <Icon size={size} aria-hidden="true" />}
			{display !== 'icon' && <span className="button-label">{widget.label}</span>}
		</span>
	)
}

// 状態表示のタイトル。アイコンは文字と同じくらいの大きさで左に置く
function TitleContent({ widget }: { widget: Pick<Widget, 'kind' | 'icon' | 'display' | 'label'> }) {
	const display = widgetDisplay(widget)
	const Icon = display === 'text' ? undefined : findIcon(widgetIconKey(widget))?.Icon
	return (
		<span className="title-content">
			{Icon && <Icon size={display === 'icon' ? 20 : 16} aria-hidden="true" />}
			{display !== 'icon' && <span>{widget.label}</span>}
		</span>
	)
}

// コンパクト表示のスクロールバー。標準のバーは幅を取るので隠し、スクロールしている間だけ細いバーを中身の上に重ねる。
// 枠の中に置くと中身と一緒に流れるので、画面に固定（position: fixed）して枠の右端に合わせる
function OverlayScrollbar({ target }: { target: React.RefObject<HTMLDivElement | null> }) {
	const [thumb, setThumb] = React.useState<{ top: number; left: number; height: number } | null>(null)
	const [visible, setVisible] = React.useState(false)
	React.useEffect(() => {
		const el = target.current
		if (!el) return
		let timer: number | undefined
		const measure = () => {
			const { scrollTop, scrollHeight, clientHeight } = el
			if (scrollHeight <= clientHeight + 1) {
				setThumb(null)
				return
			}
			const rect = el.getBoundingClientRect()
			const height = Math.max(24, clientHeight * clientHeight / scrollHeight)
			const top = rect.top + scrollTop / (scrollHeight - clientHeight) * (clientHeight - height)
			setThumb({ top, left: rect.right - 6, height })
		}
		const onScroll = () => {
			measure()
			setVisible(true)
			window.clearTimeout(timer)
			timer = window.setTimeout(() => setVisible(false), 800)
		}
		measure()
		el.addEventListener('scroll', onScroll, { passive: true })
		window.addEventListener('resize', measure)
		// 中身の高さが変わったとき（状態の取得やレイアウトの切り替え）も測り直す
		const observer = new ResizeObserver(measure)
		observer.observe(el)
		if (el.firstElementChild) observer.observe(el.firstElementChild)
		return () => {
			window.clearTimeout(timer)
			el.removeEventListener('scroll', onScroll)
			window.removeEventListener('resize', measure)
			observer.disconnect()
		}
	}, [target])
	if (!thumb) return null
	return <div className={visible ? 'overlay-scrollbar visible' : 'overlay-scrollbar'} style={thumb} aria-hidden="true" />
}

// 表示名・アイコン・表示の仕方を編集する。グループは表示名だけ
function WidgetEditor({ widget, onSave, onClose }: { widget: Widget; onSave: (patch: Partial<Widget>) => void; onClose: () => void }) {
	const button = isButton(widget)
	const iconEditable = hasIcon(widget)
	const [label, setLabel] = React.useState(widget.label)
	const [icon, setIcon] = React.useState<string | null>(widgetIconKey(widget))
	const [display, setDisplay] = React.useState<ButtonDisplay>(widgetDisplay(widget))
	const [query, setQuery] = React.useState('')
	const q = query.trim().toLowerCase()
	const groups = ICON_GROUPS
		.map(g => ({ ...g, icons: q ? g.icons.filter(i => i.label.toLowerCase().includes(q) || i.key.includes(q)) : g.icons }))
		.filter(g => g.icons.length > 0)
	const needsIcon = display !== 'text' && !findIcon(icon)

	const chooseIcon = (key: string | null) => {
		setIcon(key)
		// アイコンを外したら文字のみ、文字のみのときにアイコンを選んだらアイコンと文字にする
		if (!key) setDisplay('text')
		else if (display === 'text') setDisplay('both')
	}

	const submit = (e: React.FormEvent) => {
		e.preventDefault()
		if (!label.trim() || needsIcon) return
		onSave(iconEditable ? { label: label.trim(), icon, display } : { label: label.trim() })
	}

	const preview = { kind: widget.kind, icon, display, label: label.trim() || '（表示名）', w: widget.w, h: widget.h }
	const title = button ? 'ボタンを編集' : iconEditable ? '状態表示を編集' : '表示名を変更'
	const labelNote = button
		? 'アイコンのみの表示でも、操作したときの通知とマウスを載せたときの説明に使います'
		: 'アイコンのみの表示でも、マウスを載せたときの説明に使います'
	return (
		<Modal title={title} onClose={onClose} className={iconEditable ? 'widget-editor' : ''}>
			<form className="form" onSubmit={submit}>
				<label>表示名{iconEditable && <small>{labelNote}</small>}
					<input value={label} onChange={e => setLabel(e.target.value)} autoFocus maxLength={60} />
				</label>
				{iconEditable && (
					<>
						<fieldset>
							<legend>表示</legend>
							<div className="radios">
								{(Object.keys(DISPLAY_LABELS) as ButtonDisplay[]).map(d => (
									<label key={d}>
										<input type="radio" name="display" checked={display === d} onChange={() => setDisplay(d)} />
										{DISPLAY_LABELS[d]}
									</label>
								))}
							</div>
						</fieldset>
						<fieldset className="icon-field">
							<legend>アイコン{findIcon(icon) && <small>　{findIcon(icon)!.label}</small>}</legend>
							<label className="icon-search">
								<Search size={14} aria-hidden="true" />
								<input placeholder="名前で絞り込む（例: 冷房、施錠、電球）" value={query} onChange={e => setQuery(e.target.value)} aria-label="アイコンを名前で絞り込む" />
							</label>
							<div className="icon-picker">
								{!q && (
									<div className="icon-grid">
										<button type="button" className={icon === null ? 'icon-option active' : 'icon-option'} onClick={() => chooseIcon(null)} title="アイコンなし">
											<span className="icon-none">なし</span>
										</button>
									</div>
								)}
								{groups.map(g => (
									<section key={g.label}>
										<h3>{g.label}</h3>
										<div className="icon-grid">
											{g.icons.map(({ key, label: name, Icon }) => (
												<button
													type="button"
													key={key}
													className={icon === key ? 'icon-option active' : 'icon-option'}
													onClick={() => chooseIcon(key)}
													title={name}
													aria-label={name}
													aria-pressed={icon === key}
												>
													<Icon size={20} aria-hidden="true" />
												</button>
											))}
										</div>
									</section>
								))}
								{groups.length === 0 && <p className="muted">見つかりません</p>}
							</div>
						</fieldset>
						<div className="widget-preview">
							<small>プレビュー</small>
							{button ? (
								<div className="widget-preview-button" style={{ width: Math.min(widget.w, 300), height: Math.min(widget.h, 160) }}>
									<button type="button" className="widget-button" tabIndex={-1} aria-hidden="true">
										<ButtonContent widget={{ ...preview, w: Math.min(widget.w, 300), h: Math.min(widget.h, 160) }} />
									</button>
								</div>
							) : (
								<div className="widget-preview-title" style={{ width: Math.min(widget.w, 300) }}>
									<div className="widget-title"><TitleContent widget={preview} /></div>
								</div>
							)}
						</div>
					</>
				)}
				{needsIcon && <p className="error">アイコンを選ぶか、表示を「文字のみ」にしてください</p>}
				<div className="form-actions">
					<button type="button" className="ghost" onClick={onClose}>キャンセル</button>
					<button type="submit" disabled={!label.trim() || needsIcon}>保存</button>
				</div>
			</form>
		</Modal>
	)
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




// 他のレイアウトから写すときは、ウィジェットの id を振り直す
const cloneWidgets = (items: Widget[]) => items.map(w => ({ ...w, id: crypto.randomUUID() }))

function LayoutEditor({ layout, layouts, onLogout, onCreate, onDelete, onRename }: {
	layout: LayoutDoc
	layouts: LayoutDoc[]
	onLogout: () => void
	onCreate: () => void
	onDelete: (id: string) => void
	onRename: (id: string, name: string) => Promise<string | null>
}) {
	const queryClient = useQueryClient()
	const { showToast, toastElement } = useToast()
	const [widgets, setWidgets] = React.useState<Widget[]>(layout.widgets)
	// 何も置いていなければ最初から編集モードにする
	// コンパクト表示は使うだけ（縮小表示ではドラッグの位置がずれるので編集は通常の画面で行う）
	const [editing, setEditing] = React.useState(!COMPACT && layout.widgets.length === 0)
	const [activeId, setActiveId] = React.useState<string | null>(null)
	const [editingWidgetId, setEditingWidgetId] = React.useState<string | null>(null)
	const [busy, setBusy] = React.useState<string | null>(null)
	const [refreshing, setRefreshing] = React.useState(false)
	// 個別に状態を取り直している機器
	const [refreshingIds, setRefreshingIds] = React.useState<Set<string>>(() => new Set())
	const [saveState, setSaveState] = React.useState<SaveState>('saved')
	const [targetKey, setTargetKey] = React.useState('')
	const [contentKey, setContentKey] = React.useState('')
	const [canvasWidth, setCanvasWidth] = React.useState(0)
	const canvasRef = React.useRef<HTMLDivElement>(null)
	const wrapRef = React.useRef<HTMLDivElement>(null)
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
			icon: !target.device ? null : kind === 'action' ? suggestIcon(target.device, command) : kind === 'status' ? suggestStatusIcon(target.device) : null,
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

	const editingWidget = widgets.find(w => w.id === editingWidgetId)

	const saveWidget = (id: string, patch: Partial<Widget>) => {
		updateWidgets(items => items.map(w => (w.id === id ? { ...w, ...patch } : w)))
		setEditingWidgetId(null)
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

	// 状態表示の取得時刻をクリックしたときに、その機器だけ取り直す
	const refreshOne = async (device: Device) => {
		setRefreshingIds(ids => new Set(ids).add(device.id))
		try {
			const failed = await fetchStatuses([device.id])
			if (failed) showToast(`${device.name} の状態を取得できませんでした`, true)
		} catch (err) {
			handleError(err)
		} finally {
			setRefreshingIds(ids => {
				const next = new Set(ids)
				next.delete(device.id)
				return next
			})
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

	// コンパクト表示では、左端のウィジェットまでの余白を右端（GRID）と揃えるよう、配置全体を横にずらす
	const minX = widgets.length ? Math.min(...widgets.map(w => w.x)) : 0
	const offsetX = COMPACT ? GRID - minX : 0
	// コンパクト表示では、配置が窓より広ければ窓の幅に合わせて全体を縮小する
	const contentWidth = widgets.reduce((max, w) => Math.max(max, w.x + w.w), 0) + GRID + offsetX
	const scale = COMPACT && canvasWidth && contentWidth > canvasWidth ? canvasWidth / contentWidth : 1
	const contentHeight = COMPACT ? widgets.reduce((max, w) => Math.max(max, w.y + w.h), 0) + GRID : canvasHeight

	return (
		<main className="layout-page">
			<Header
				page="layout"
				onLogout={onLogout}
				currentLayoutId={layout.id}
				layoutMenuLabel={layoutLabel(layout, currentIndex)}
				onCreateLayout={onCreate}
			>
				<button onClick={refreshAll} disabled={statusWidgetCount === 0 || refreshing} title="状態表示を再取得">
					<RefreshCw size={16} className={refreshing ? 'spin' : ''} /><span className="btn-text">状態を更新</span>
				</button>
				{!COMPACT && <button
					className={editing ? 'active has-dot' : 'has-dot'}
					onClick={() => { setEditing(!editing); setActiveId(null) }}
					title={`${editing ? '編集を終える' : 'レイアウトを編集'}（${SAVE_LABELS[saveState]}）`}
					aria-label={`${editing ? '完了' : '編集'}（${SAVE_LABELS[saveState]}）`}
				>
					{editing ? <><Check size={16} /><span className="btn-text">完了</span></> : <><Pencil size={16} /><span className="btn-text">編集</span></>}
					{/* 保存状態は右上の点で示す（保存済み: 緑、保存中: 黄、失敗: 赤） */}
					<span className={`save-dot ${saveState}`} aria-hidden="true" />
				</button>}
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

			{COMPACT && <OverlayScrollbar target={wrapRef} />}
			<div className="canvas-wrap" ref={wrapRef}>
				<div
					ref={canvasRef}
					className={editing ? 'canvas editing' : 'canvas'}
					style={{ height: contentHeight * scale }}
					onPointerDown={() => setActiveId(null)}
				>
					{widgets.length === 0 && (
						<p className="canvas-empty muted">
							{COMPACT ? 'このレイアウトは空です。ブラウザで開いて編集してください。' : '上のプルダウンから機器やシーンを選んで「追加」してください。'}
						</p>
					)}
					<div
						className="canvas-scale"
						style={scale === 1 && offsetX === 0 ? undefined : { transform: `scale(${scale}) translateX(${offsetX}px)`, width: contentWidth, height: contentHeight }}
					>
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
								{widget.kind === 'status' && device && hasStatus(device) && (
									<button
										type="button"
										className="widget-time"
										onClick={() => refreshOne(device)}
										disabled={editing || refreshing || refreshingIds.has(device.id)}
										title="クリックでこの機器の状態を再取得"
									>
										{(refreshing || refreshingIds.has(device.id)) && <RefreshCw size={9} className="spin" aria-hidden="true" />}
										{statuses[device.id]?.fetchedAt ? formatClock(statuses[device.id].fetchedAt!) : '未取得'}
									</button>
								)}
								<div className="widget-body">
									{isGroup ? (
										<div className="widget-title">{widget.label}</div>
									) : widget.kind === 'status' ? (
										<>
											<div className="widget-title" title={widget.label}><TitleContent widget={widget} /></div>
											{device ? <StatusView device={device} entry={statuses[device.id]} /> : <p className="status muted">{missing ? '機器が見つかりません' : '読み込み中...'}</p>}
										</>
									) : (
										<button
											className="widget-button"
											onClick={() => runWidget(widget)}
											disabled={editing || busy !== null || missing}
											title={widget.label}
											aria-label={widget.label}
										>
											<ButtonContent widget={widget} />
											{missing && <small>（見つかりません）</small>}
										</button>
									)}
								</div>
								{editing && (
									<>
										<div className="widget-tools" onPointerDown={e => e.stopPropagation()}>
											<button
												className="icon"
												onClick={() => setEditingWidgetId(widget.id)}
												title={hasIcon(widget) ? '表示名・アイコンを変更' : '表示名を変更'}
											>
												{hasIcon(widget) ? <Pencil size={12} /> : <Type size={12} />}
											</button>
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
			</div>

			{editingWidget && (
				<WidgetEditor
					key={editingWidget.id}
					widget={editingWidget}
					onSave={patch => saveWidget(editingWidget.id, patch)}
					onClose={() => setEditingWidgetId(null)}
				/>
			)}

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
	const lastId = getLastLayoutId()
	// URL の指定（名前 → id） → 最後に開いたレイアウト → 先頭の順に開く
	const current = (requestedKey && (layouts.find(l => l.name === requestedKey) ?? layouts.find(l => l.id === requestedKey)))
		|| layouts.find(l => l.id === lastId) || layouts[0]

	React.useEffect(() => {
		if (current) setLastLayoutId(current.id)
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
	return <LayoutEditor key={current.id} layout={current} layouts={layouts} onLogout={onLogout} onCreate={create} onDelete={remove} onRename={rename} />
}
