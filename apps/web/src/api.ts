import type { HealthInfo, LoginResult, MeResult } from '@openchat/shared'

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }

  let res: Response
  try {
    res = await fetch(path, { ...init, headers, credentials: 'same-origin' })
  } catch {
    throw new ApiError(0, 'network', '连不上服务器，检查一下网')
  }

  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }

  if (!res.ok) {
    const problem = body as { code?: string; message?: string } | null
    throw new ApiError(
      res.status,
      problem?.code ?? `http_${res.status}`,
      problem?.message ?? `请求失败（${res.status}）`,
    )
  }

  return body as T
}

export const api = {
  health: () => request<HealthInfo>('/api/health'),
  me: () => request<MeResult>('/api/auth/me'),
  login: (password: string) =>
    request<LoginResult>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
}
