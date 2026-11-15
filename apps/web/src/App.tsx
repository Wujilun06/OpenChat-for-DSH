import { useCallback, useEffect, useState } from 'react'
import type { MeResult } from '@openchat/shared'
import { api } from './api'
import { Login } from './components/Login'
import { ChatShell } from './components/ChatShell'

type Phase = 'loading' | 'login' | 'chat'

export function App() {
  const [phase, setPhase] = useState<Phase>('loading')
  const [me, setMe] = useState<MeResult | null>(null)

  useEffect(() => {
    let alive = true
    api
      .me()
      .then((result) => {
        if (!alive) return
        setMe(result)
        setPhase('chat')
      })
      .catch(() => {
        if (alive) setPhase('login')
      })
    return () => {
      alive = false
    }
  }, [])

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

  if (phase === 'loading') return <div className="splash">…</div>
  if (phase === 'login' || !me) return <Login onDone={handleLoggedIn} />
  return <ChatShell me={me} onLogout={handleLogout} />
}
