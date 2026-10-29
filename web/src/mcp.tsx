// MCP サーバーのコネクタ URL の表示と、トークンの発行・作り直し（一覧ページの下に置く）
import React from 'react'
import { api, errorMessage } from './common'

type TokenInfo = { token: string | null; issuedAt: string | null }

// MCP サーバーは Apache の <BASE_URL>mcp/ で公開している（本番は /switchbot_home/mcp/）
const connectorUrl = (token: string) => `${location.origin}${import.meta.env.BASE_URL}mcp/${token}`

export function McpPanel({ showToast, onError }: { showToast: (text: string, error?: boolean) => void; onError: (err: unknown) => void }) {
	const [info, setInfo] = React.useState<TokenInfo | null>(null)
	const [shown, setShown] = React.useState(false)
	const [busy, setBusy] = React.useState(false)

	// 開いたときに 1 回だけ読む
	const load = () => {
		if (info === null) api<TokenInfo>('/mcp-token').then(setInfo).catch(onError)
	}

	const regenerate = async () => {
		const message = info?.token
			? 'トークンを作り直しますか？\n今のコネクタ URL はすぐ使えなくなるので、AI 側のコネクタの URL も新しいものに変えてください。'
			: 'トークンを発行しますか？'
		if (!confirm(message)) return
		setBusy(true)
		try {
			setInfo(await api<TokenInfo>('/mcp-token', { method: 'POST' }))
			setShown(true)
			showToast(info?.token ? 'トークンを作り直しました' : 'トークンを発行しました')
		} catch (err) {
			onError(err)
		} finally {
			setBusy(false)
		}
	}

	const copy = async () => {
		if (!info?.token) return
		try {
			await navigator.clipboard.writeText(connectorUrl(info.token))
			showToast('コネクタ URL をコピーしました')
		} catch (err) {
			setShown(true)
			showToast(`コピーできませんでした。表示した URL を選んでコピーしてください（${errorMessage(err)}）`, true)
		}
	}

	const url = info?.token ? connectorUrl(info.token) : null
	return (
		<section>
			<details className="mcp-panel" onToggle={e => e.currentTarget.open && load()}>
				<summary><h2>MCP コネクタ（AI からの接続）</h2></summary>
				<p className="muted">
					AI（claude.ai のカスタムコネクタなど）に登録する URL です。この URL を知っていれば誰でも機器を操作できるので、人に渡さないでください。
					漏れたかもしれないときは作り直してください（前の URL はすぐ使えなくなります）。
				</p>
				{info === null ? <p className="muted">読み込み中...</p> : (
					<>
						{url ? (
							<div className="mcp-url">
								<input type="text" readOnly value={shown ? url : url.replace(/[0-9a-f]{64}$/, '•'.repeat(16))}
									onFocus={e => shown && e.target.select()} />
								{info.issuedAt && <small>発行: {new Date(info.issuedAt).toLocaleString('ja-JP')}</small>}
							</div>
						) : <p className="muted">未発行です。発行するまで、MCP サーバーはすべての接続を拒否します。</p>}
						<div className="actions">
							{url && <button onClick={() => setShown(s => !s)}>{shown ? '隠す' : '表示'}</button>}
							{url && <button onClick={copy}>コピー</button>}
							<button className={url ? 'danger' : ''} disabled={busy} onClick={regenerate}>
								{url ? 'トークンを作り直す' : 'トークンを発行する'}
							</button>
						</div>
					</>
				)}
			</details>
		</section>
	)
}
