import { useCallback, useEffect, useState } from 'react'
import type { MeResult } from '@openchat/shared'
import { api, ApiError } from './api'
import { Login } from './components/Login'
import { ChatShell } from './components/ChatShell'

type Phase = 'loading' | 'login' | 'chat' | 'error'

export function App() {
  const [phase, setPhase] = useState<Phase>('loading')
  const [me, setMe] = useState<MeResult | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [bootError, setBootError] = useState('')

  useEffect(() => {
    let alive = true
    setPhase('loading')
    api
      .me()
      .then((result) => {
        if (!alive) return
        setMe(result)
        setPhase('chat')
      })
      .catch((error: unknown) => {
        if (!alive) return
        // 401 才是没登录；网络超时/断线单独给重试，不要假装是密码问题
        if (error instanceof ApiError && error.status === 401) {
          setPhase('login')
          return
        }
        setBootError(error instanceof Error && error.message ? error.message : '连不上服务器')
        setPhase('error')
      })
    return () => {
      alive = false
    }
  }, [attempt])

  const handleLoggedIn = useCallback(async () => {
    const result = await api.me()
    setMe(result)
    setPhase('chat')
  }, [])

  const handleLogout = useCallback(async () => {
    try {
      await api.logout()
    } catch {
      // 退不出去也把本地状态清掉，下次进来会重新问服务器。
    }
    setMe(null)
    setPhase('login')
  }, [])

  if (phase === 'loading') return <div className="splash">正在连接…</div>

  if (phase === 'error') {
    return (
      <div className="splash splash-error">
        <p className="splash-title">连不上服务器</p>
        <p className="splash-detail">{bootError}</p>
        <button type="button" className="splash-retry" onClick={() => setAttempt((n) => n + 1)}>
          重试
        </button>
      </div>
    )
  }

  if (phase === 'login' || !me) return <Login onDone={handleLoggedIn} />
  return <ChatShell me={me} onLogout={handleLogout} />
}
