import React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import { Play, Power, PowerOff, RefreshCw } from 'lucide-react'
import {
	Action, COMPACT, Device, DevicesResponse, Header, Page, Scene, StatusesResponse, StatusView, UnauthorizedError,
	api, base, deviceActions, errorMessage, executeScene, hasStatus, sendCommand, setAuthToken, supportsOnOff, useToast,
} from './common'
import { LayoutPage } from './layout'
import { SchedulePage } from './schedule'
import './styles.css'

type Filter = 'all' | 'device' | 'ir'

function Login({ onLogin }: { onLogin: () => void }) {
	const [username, setUsername] = React.useState('')
	const [password, setPassword] = React.useState('')
	const [error, setError] = React.useState('')
	const submit = async (e: React.FormEvent) => {
		e.preventDefault()
		setError('')
		try {
			const data = await api<{ token: string }>('/login', { method: 'POST', body: JSON.stringify({ username, password }) })
			setAuthToken(data.token)
			onLogin()
		} catch (err) {
			setError(err instanceof UnauthorizedError ? 'ユーザー名またはパスワードが違います' : err instanceof Error ? err.message : String(err))
		}
	}
	return (
		<main className="login">
			<form onSubmit={submit}>
				<h1>SwitchBot Home</h1>
				<input autoComplete="username" placeholder="ユーザー名" value={username} onChange={e => setUsername(e.target.value)} />
				<input autoComplete="current-password" type="password" placeholder="パスワード" value={password} onChange={e => setPassword(e.target.value)} />
				<button type="submit">ログイン</button>
				{error && <p className="error">{error}</p>}
			</form>
		</main>
	)
}

function Dashboard({ onLogout }: { onLogout: () => void }) {
	const queryClient = useQueryClient()
	const [filter, setFilter] = React.useState<Filter>('all')
	const [selected, setSelected] = React.useState<Set<string>>(new Set())
	const [busy, setBusy] = React.useState<string | null>(null)
	const { showToast, toastElement } = useToast()

	const handleError = (err: unknown) => {
		if (err instanceof UnauthorizedError) onLogout()
		else showToast(errorMessage(err), true)
	}

	const devicesQuery = useQuery({
		queryKey: ['devices'],
		queryFn: () => api<DevicesResponse>('/devices'),
		retry: false,
	})
	const scenesQuery = useQuery({
		queryKey: ['scenes'],
		queryFn: () => api<{ scenes: Scene[] }>('/scenes'),
		retry: false,
	})
	const physicalIds = React.useMemo(() => (devicesQuery.data?.devices ?? []).filter(hasStatus).map(d => d.id), [devicesQuery.data])
	const statusesQuery = useQuery({
		queryKey: ['statuses', physicalIds],
		queryFn: () => api<StatusesResponse>('/devices/status', { method: 'POST', body: JSON.stringify({ ids: physicalIds }) }),
		enabled: physicalIds.length > 0,
		retry: false,
		staleTime: 30_000,
	})

	React.useEffect(() => {
		for (const q of [devicesQuery, scenesQuery, statusesQuery]) if (q.error) handleError(q.error)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [devicesQuery.error, scenesQuery.error, statusesQuery.error])

	const devices = (devicesQuery.data?.devices ?? []).filter(d => filter === 'all' || d.kind === filter)
	const statuses = statusesQuery.data?.statuses ?? {}

	const refreshStatuses = async (ids: string[]) => {
		try {
			const data = await api<StatusesResponse>('/devices/status', { method: 'POST', body: JSON.stringify({ ids, refresh: true }) })
			queryClient.setQueryData<StatusesResponse>(['statuses', physicalIds], old => ({
				statuses: { ...(old?.statuses ?? {}), ...data.statuses },
				usage: data.usage,
			}))
		} catch (err) {
			handleError(err)
		}
	}

	const refreshAll = async () => {
		setBusy('refresh')
		try {
			await api('/devices?refresh=true')
			await api('/scenes?refresh=true')
			await queryClient.invalidateQueries({ queryKey: ['devices'] })
			await queryClient.invalidateQueries({ queryKey: ['scenes'] })
			await refreshStatuses(physicalIds)
		} catch (err) {
			handleError(err)
		} finally {
			setBusy(null)
		}
	}

	const runAction = async (device: Device, action: Action) => {
		if (action.confirm && !window.confirm(action.confirm)) return
		setBusy(`${device.id}:${action.command}`)
		try {
			await sendCommand(device.id, action.command, action.parameter ?? 'default')
			showToast(`${device.name}: ${action.label}`)
			if (device.kind === 'ir') await queryClient.invalidateQueries({ queryKey: ['devices'] })
			else window.setTimeout(() => refreshStatuses([device.id]), 1500)
		} catch (err) {
			handleError(err)
		} finally {
			setBusy(null)
		}
	}

	const runBatch = async (command: 'turnOn' | 'turnOff') => {
		const targets = (devicesQuery.data?.devices ?? []).filter(d => selected.has(d.id) && supportsOnOff(d))
		if (targets.length === 0) return
		setBusy(`batch:${command}`)
		try {
			const data = await api<{ results: { deviceId: string; ok: boolean; error?: string }[] }>('/commands/batch', {
				method: 'POST',
				body: JSON.stringify({ items: targets.map(d => ({ deviceId: d.id, command, parameter: 'default', commandType: 'command' })) }),
			})
			const failed = data.results.filter(r => !r.ok)
			if (failed.length) {
				const names = failed.map(r => targets.find(d => d.id === r.deviceId)?.name ?? r.deviceId)
				showToast(`${failed.length}件失敗: ${names.join('、')}`, true)
			} else {
				showToast(`${targets.length}台に ${command === 'turnOn' ? 'ON' : 'OFF'} を送信しました`)
			}
			await queryClient.invalidateQueries({ queryKey: ['devices'] })
			const physical = targets.filter(hasStatus).map(d => d.id)
			if (physical.length) window.setTimeout(() => refreshStatuses(physical), 1500)
		} catch (err) {
			handleError(err)
		} finally {
			setBusy(null)
		}
	}

	const runScene = async (scene: Scene) => {
		setBusy(`scene:${scene.id}`)
		try {
			await executeScene(scene.id)
			showToast(`シーン「${scene.name}」を実行しました`)
		} catch (err) {
			handleError(err)
		} finally {
			setBusy(null)
		}
	}

	const toggleSelect = (id: string) => {
		setSelected(prev => {
			const next = new Set(prev)
			if (next.has(id)) next.delete(id)
			else next.add(id)
			return next
		})
	}

	const selectableCount = [...selected].filter(id => devicesQuery.data?.devices.some(d => d.id === id && supportsOnOff(d))).length

	return (
		<main>
			<Header page="dashboard" onLogout={onLogout}>
				<button onClick={refreshAll} disabled={busy !== null} title="一覧と状態を再取得">
					<RefreshCw size={16} className={busy === 'refresh' ? 'spin' : ''} /><span className="btn-text">更新</span>
				</button>
			</Header>

			<section>
				<h2>シーン</h2>
				{scenesQuery.isLoading && <p className="muted">読み込み中...</p>}
				<div className="scenes">
					{scenesQuery.data?.scenes.map(scene => (
						<button key={scene.id} onClick={() => runScene(scene)} disabled={busy !== null}>
							<Play size={14} /> {scene.name}
						</button>
					))}
				</div>
			</section>

			<section>
				<div className="section-head">
					<h2>機器</h2>
					<div className="filters">
						{([['all', 'すべて'], ['device', '物理機器'], ['ir', '赤外線']] as [Filter, string][]).map(([key, label]) => (
							<button key={key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>{label}</button>
						))}
					</div>
				</div>
				{devicesQuery.isLoading && <p className="muted">読み込み中...</p>}
				<div className="devices">
					{devices.map(device => {
						const actions = deviceActions(device)
						return (
							<article key={device.id} className={selected.has(device.id) ? 'card selected' : 'card'}>
								<div className="card-head">
									{supportsOnOff(device) && (
										<input type="checkbox" checked={selected.has(device.id)} onChange={() => toggleSelect(device.id)} aria-label={`${device.name} を選択`} />
									)}
									<div>
										<h3>{device.name}</h3>
										<small>{device.kind === 'ir' ? `赤外線 / ${device.type}` : device.type}</small>
									</div>
									{hasStatus(device) && (
										<button className="icon" onClick={() => refreshStatuses([device.id])} title="状態を再取得"><RefreshCw size={14} /></button>
									)}
								</div>
								<StatusView device={device} entry={statuses[device.id]} />
								{actions.length > 0 && (
									<div className="actions">
										{actions.map(action => (
											<button key={action.command} onClick={() => runAction(device, action)} disabled={busy !== null}>
												{action.label}
											</button>
										))}
									</div>
								)}
							</article>
						)
					})}
				</div>
			</section>

			{selected.size > 0 && (
				<div className="batch-bar">
					<span>{selectableCount}台を選択中</span>
					<button onClick={() => runBatch('turnOn')} disabled={busy !== null}><Power size={16} /> まとめてON</button>
					<button onClick={() => runBatch('turnOff')} disabled={busy !== null}><PowerOff size={16} /> まとめてOFF</button>
					<button className="ghost" onClick={() => setSelected(new Set())}>選択解除</button>
				</div>
			)}

			{toastElement}
		</main>
	)
}

// ルーティングは本番の配置先（サブパス）に依存しないようハッシュで行う
function currentPage(): Page {
	if (window.location.hash.startsWith('#/layout')) return 'layout'
	if (window.location.hash.startsWith('#/schedule')) return 'schedule'
	return 'dashboard'
}

function App() {
	const queryClient = useQueryClient()
	// ログイン状態は Query のキャッシュではなく state で持つ（clear() でキャッシュを消すと画面に反映されないため）
	const [authenticated, setAuthenticated] = React.useState<boolean | null>(null)
	const [sessionError, setSessionError] = React.useState('')
	const [page, setPage] = React.useState<Page>(currentPage)
	const loggingOut = React.useRef(false)

	React.useEffect(() => {
		api('/session')
			.then(() => setAuthenticated(true))
			.catch(err => {
				if (err instanceof UnauthorizedError) setAuthenticated(false)
				else setSessionError(errorMessage(err))
			})
	}, [])

	React.useEffect(() => {
		const onHashChange = () => setPage(currentPage())
		window.addEventListener('hashchange', onHashChange)
		return () => window.removeEventListener('hashchange', onHashChange)
	}, [])

	const logout = async () => {
		// 401 を受けた複数のクエリから同時に呼ばれても一度だけ処理する
		if (loggingOut.current) return
		loggingOut.current = true
		setAuthToken(null)
		setAuthenticated(false)
		await fetch(`${base}/logout`, { method: 'POST', credentials: 'include' }).catch(() => null)
		queryClient.clear()
		loggingOut.current = false
	}

	if (sessionError) return <main><p className="error">API に接続できません: {sessionError}</p></main>
	if (authenticated === null) return <main><p className="muted">読み込み中...</p></main>
	if (!authenticated) return <Login onLogin={() => setAuthenticated(true)} />
	if (page === 'layout') return <LayoutPage onLogout={logout} />
	if (page === 'schedule') return <SchedulePage onLogout={logout} />
	return <Dashboard onLogout={logout} />
}

if (COMPACT) document.documentElement.classList.add('compact')

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } })

createRoot(document.getElementById('root')!).render(
	<React.StrictMode>
		<QueryClientProvider client={queryClient}>
			<App />
		</QueryClientProvider>
	</React.StrictMode>,
)
