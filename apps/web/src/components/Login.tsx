import { useState, type FormEvent } from 'react'
import { ApiError, api } from '../api'

export function Login({ onDone }: { onDone: () => Promise<void> }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await api.login(password)
      await onDone()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '出了点问题，再试一次')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <img className="login-logo" src="/peer.png" alt="" />
      <h1>OpenChat</h1>
      <p className="login-sub">自己的聊天，掉线也能找到人</p>
      <form onSubmit={submit}>
        <input
          type="password"
          value={password}
          autoFocus
          autoComplete="current-password"
          placeholder="密码"
          onChange={(e) => setPassword(e.target.value)}
        />
        <button type="submit" disabled={busy || password.length === 0}>
          {busy ? '进去中…' : '进去'}
        </button>
        <p className="login-error">{error}</p>
      </form>
    </div>
  )
}
