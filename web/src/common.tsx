import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, LogOut, Plus } from 'lucide-react'

export type Device = {
	id: string
	name: string
	type: string
	kind: 'device' | 'ir'
	hubDeviceId: string
	cloudEnabled: boolean
	lastCommand?: { command: string; parameter: unknown; at: number } | null
}

export type Usage = { date: string; count: number; limit: number }

export type DevicesResponse = { devices: Device[]; fetchedAt: number; usage: Usage }

export type StatusEntry = { status?: Record<string, unknown>; fetchedAt?: number; error?: string }

export type StatusesResponse = { statuses: Record<string, StatusEntry>; usage: Usage }

export type Scene = { id: string; name: string }

export type Action = { label: string; command: string; parameter?: unknown; confirm?: string }

export type Page = 'dashboard' | 'layout' | 'schedule'

export const base = `${import.meta.env.BASE_URL}api`

// タスクトレイのポップアップから開くときの表示（URL の ?compact）。# より前に付けるのでページを移っても続く
export const COMPACT = new URLSearchParams(window.location.search).has('compact')
const AUTH_TOKEN_KEY = 'switchbot_home_token'

export function getAuthToken(): string | null {
	try {
		return localStorage.getItem(AUTH_TOKEN_KEY)
	} catch {
		return null
	}
}

export function setAuthToken(token: string | null) {
	try {
		if (token) localStorage.setItem(AUTH_TOKEN_KEY, token)
		else localStorage.removeItem(AUTH_TOKEN_KEY)
	} catch {
		// localStorage error
	}
}

export class UnauthorizedError extends Error {}

// SwitchBot API の呼び出し回数。サーバーが全応答の X-SwitchBot-Usage ヘッダーで返す
let usageValue: { count: number; limit: number } | null = null
const usageListeners = new Set<() => void>()

function updateUsage(header: string | null) {
	const match = header?.match(/^(\d+)\/(\d+)$/)
	if (!match) return
	const count = Number(match[1])
	const limit = Number(match[2])
	if (usageValue?.count === count && usageValue.limit === limit) return
	usageValue = { count, limit }
	usageListeners.forEach(listener => listener())
}

function subscribeUsage(listener: () => void) {
	usageListeners.add(listener)
	return () => {
		usageListeners.delete(listener)
	}
}

export function UsageLabel() {
	const usage = React.useSyncExternalStore(subscribeUsage, () => usageValue)
	if (!usage) return null
	return <small className="usage-label">API {usage.count.toLocaleString()} / {usage.limit.toLocaleString()}</small>
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
	const headers = new Headers(init?.headers)
	const token = getAuthToken()
	if (token) headers.set('Authorization', `Bearer ${token}`)
	if (init?.body) headers.set('Content-Type', 'application/json')
	const res = await fetch(`${base}${path}`, { ...init, headers, credentials: 'include' })
	updateUsage(res.headers.get('X-SwitchBot-Usage'))
	if (res.status === 401) throw new UnauthorizedError('認証が必要です')
	if (!res.ok) {
		const data = await res.json().catch(() => null)
		throw new Error(data?.detail ?? `HTTP ${res.status}`)
	}
	return res.json()
}

export function sendCommand(deviceId: string, command: string, parameter: unknown = 'default') {
	return api(`/devices/${deviceId}/commands`, {
		method: 'POST',
		body: JSON.stringify({ command, parameter, commandType: 'command' }),
	})
}

export function executeScene(sceneId: string) {
	return api(`/scenes/${sceneId}/execute`, { method: 'POST' })
}

// 機器タイプごとに出す操作ボタン（センサーやハブは状態表示のみ）
export function deviceActions(d: Device): Action[] {
	if (d.kind === 'ir') {
		// Others はカスタムボタン名が必要なので対象外。DIY（学習リモコン）は電源ボタンを学習していれば動く
		if (d.type === 'Others') return []
		return [{ label: 'ON', command: 'turnOn' }, { label: 'OFF', command: 'turnOff' }]
	}
	const t = d.type
	if (/Lock/i.test(t)) {
		return [{ label: '施錠', command: 'lock' }, { label: '解錠', command: 'unlock', confirm: `${d.name} を解錠しますか？` }]
	}
	if (t === 'Bot') return [{ label: 'ON', command: 'turnOn' }, { label: 'OFF', command: 'turnOff' }, { label: '押す', command: 'press' }]
	if (/Curtain|Roller Shade|Blind Tilt/i.test(t)) return [{ label: '開く', command: 'turnOn' }, { label: '閉じる', command: 'turnOff' }]
	if (/Plug|Relay|Light|Bulb|Strip|Lamp|Fan|Humidifier|Purifier|Ceiling/i.test(t)) {
		return [{ label: 'ON', command: 'turnOn' }, { label: 'OFF', command: 'turnOff' }]
	}
	return []
}

export const supportsOnOff = (d: Device) => deviceActions(d).some(a => a.command === 'turnOn')

// Remote（ボタン型の機器）と赤外線リモコンは状態を取得できない
export const hasStatus = (d: Device) => d.kind === 'device' && d.type !== 'Remote'

// 状態の中から表示する項目と表示名
const STATUS_FIELDS: [string, string, (v: unknown) => string][] = [
	['power', '電源', v => String(v).toUpperCase()],
	['lockState', '施錠', v => String(v)],
	['doorState', 'ドア', v => String(v)],
	['slidePosition', '位置', v => `${v}%`],
	['brightness', '明るさ', v => `${v}`],
	['colorTemperature', '色温度', v => `${v}K`],
	['temperature', '温度', v => `${v}℃`],
	['humidity', '湿度', v => `${v}%`],
	['CO2', 'CO2', v => `${v}ppm`],
	['lightLevel', '照度', v => `${v}`],
	['voltage', '電圧', v => `${v}V`],
	['weight', '消費電力', v => `${v}W`],
	['electricCurrent', '電流', v => `${v}mA`],
	['moveDetected', '人感', v => (v ? '検知' : 'なし')],
	['openState', '開閉', v => String(v)],
	['battery', '電池', v => `${v}%`],
	['onlineStatus', '接続', v => String(v)],
]

// カーテンの slidePosition は 0 が全開・100 が閉（setPosition の仕様と同じ向き）なので、開度に読み替える
const CURTAIN_OPENNESS: [string, string, (v: unknown) => string] = ['slidePosition', '開度', v => {
	const openness = 100 - Number(v)
	if (openness <= 0) return '0%（閉）'
	if (openness >= 100) return '100%（全開）'
	return `${openness}%`
}]

export function formatTime(sec: number) {
	return new Date(sec * 1000).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function errorMessage(err: unknown) {
	return String(err instanceof Error ? err.message : err)
}

export function StatusView({ device, entry }: { device: Device; entry?: StatusEntry }) {
	if (device.kind === 'ir') {
		const last = device.lastCommand
		return <p className="status muted">{last ? `最後の操作: ${last.command} (${formatTime(last.at)})` : '状態は取得できません'}</p>
	}
	if (!hasStatus(device)) return <p className="status muted">状態なし</p>
	if (!entry) return <p className="status muted">未取得</p>
	if (entry.error) return <p className="status error">{entry.error}</p>
	const status = entry.status ?? {}
	const fields = STATUS_FIELDS.filter(([key]) => status[key] !== undefined && status[key] !== '').map(field =>
		field[0] === 'slidePosition' && /Curtain/i.test(device.type) ? CURTAIN_OPENNESS : field,
	)
	return (
		<dl className="status">
			{fields.map(([key, label, fmt]) => (
				<React.Fragment key={key}>
					<dt>{label}</dt>
					<dd className={key === 'power' ? `power-${String(status[key]).toLowerCase()}` : ''}>{fmt(status[key])}</dd>
				</React.Fragment>
			))}
			{fields.length === 0 && <dd className="muted">表示できる項目なし</dd>}
		</dl>
	)
}

export function useToast() {
	const [toast, setToast] = React.useState<{ text: string; error?: boolean } | null>(null)
	const timer = React.useRef<number | undefined>(undefined)
	const showToast = React.useCallback((text: string, error = false) => {
		setToast({ text, error })
		window.clearTimeout(timer.current)
		timer.current = window.setTimeout(() => setToast(null), 4000)
	}, [])
	const element = toast && <div className={toast.error ? 'toast error' : 'toast'}>{toast.text}</div>
	return { showToast, toastElement: element }
}

export function useHash() {
	const [hash, setHash] = React.useState(window.location.hash)
	React.useEffect(() => {
		const onHashChange = () => setHash(window.location.hash)
		window.addEventListener('hashchange', onHashChange)
		return () => window.removeEventListener('hashchange', onHashChange)
	}, [])
	return hash
}

export type MenuItem = { key: string; label: React.ReactNode; onSelect: () => void; active?: boolean; disabled?: boolean; separator?: boolean }

// ヘッダーの切り替えメニューに出すレイアウト（中身は layout.tsx 側で扱う）
export type LayoutSummary = { id: string; name: string }

export const layoutLabel = (layout: LayoutSummary, index: number) => layout.name || `レイアウト ${index + 1}`

// URL では名前があれば名前、無ければ id で指す
export const layoutPath = (layout: LayoutSummary) => `#/layout/${encodeURIComponent(layout.name || layout.id)}`

// ボタンの真下に開く選択メニュー。外側をクリックするか Esc で閉じる
export function PopupMenu({ label, items, className = '', disabled = false }: {
	label: React.ReactNode
	items: MenuItem[]
	className?: string
	disabled?: boolean
}) {
	const [open, setOpen] = React.useState(false)
	const ref = React.useRef<HTMLSpanElement>(null)
	React.useEffect(() => {
		if (!open) return
		const onPointerDown = (e: PointerEvent) => {
			if (!ref.current?.contains(e.target as Node)) setOpen(false)
		}
		const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
		document.addEventListener('pointerdown', onPointerDown)
		window.addEventListener('keydown', onKey)
		return () => {
			document.removeEventListener('pointerdown', onPointerDown)
			window.removeEventListener('keydown', onKey)
		}
	}, [open])
	return (
		<span className="popup" ref={ref}>
			<button type="button" className={className} onClick={() => setOpen(!open)} disabled={disabled} aria-expanded={open}>
				{label}
			</button>
			{open && (
				<ul className="popup-menu" role="menu">
					{items.map(item => (
						<li key={item.key} className={item.separator ? 'separator' : undefined}>
							<button
								type="button"
								role="menuitem"
								className={item.active ? 'active' : ''}
								disabled={item.disabled}
								onClick={() => {
									setOpen(false)
									item.onSelect()
								}}
							>
								{item.label}
							</button>
						</li>
					))}
				</ul>
			)}
		</span>
	)
}

export function Header({ page, onLogout, currentLayoutId, layoutMenuLabel, onCreateLayout, children }: {
	page: Page
	onLogout: () => void
	// レイアウトページを開いているときの、今のレイアウトと切り替えメニューのボタンに出す名前
	currentLayoutId?: string
	layoutMenuLabel?: string
	// レイアウトページでだけ、メニューの一番上に「新規レイアウト」を出す
	onCreateLayout?: () => void
	children?: React.ReactNode
}) {
	// どのページでも切り替えメニューを開けるよう、レイアウトの一覧はヘッダーでも読む（SwitchBot API は呼ばない）
	const layoutsQuery = useQuery({ queryKey: ['layouts'], queryFn: () => api<{ layouts: LayoutSummary[] }>('/layouts'), retry: false })
	const layouts = layoutsQuery.data?.layouts ?? []
	const menu: MenuItem[] = [
		...(onCreateLayout ? [{ key: 'new', label: <><Plus size={14} /> 新規レイアウト</>, onSelect: onCreateLayout }] : []),
		...layouts.map((l, i) => ({
			key: l.id,
			label: layoutLabel(l, i),
			active: page === 'layout' && l.id === currentLayoutId,
			onSelect: () => { window.location.hash = layoutPath(l) },
		})),
		{ key: 'dashboard', label: '一覧', active: page === 'dashboard', separator: true, onSelect: () => { window.location.hash = '#/' } },
	]
	const menuLabel = page === 'layout' ? layoutMenuLabel ?? 'レイアウト' : page === 'dashboard' ? '一覧' : 'レイアウト'
	return (
		<header>
			<div className="title-row">
				{/* 画面幅が狭いときは文字の代わりにファビコンの家アイコンを出す */}
				<h1>
					<img className="title-icon" src={`${import.meta.env.BASE_URL}favicon.svg`} alt="SwitchBot Home" />
					<span className="title-text">SwitchBot Home</span>
				</h1>
				<nav>
					{/* 一覧ページへはこのメニューの一番下から移る */}
					<PopupMenu
						label={<><span className="nav-current">{menuLabel}</span><ChevronDown size={12} /></>}
						className={page === 'schedule' ? 'nav-button' : 'nav-button active'}
						items={menu}
					/>
					<a href="#/schedule" className={page === 'schedule' ? 'active' : ''}>スケジュール</a>
				</nav>
			</div>
			<div className="header-actions">
				<UsageLabel />
				{children}
				<button onClick={onLogout} title="ログアウト"><LogOut size={16} /></button>
			</div>
		</header>
	)
}
