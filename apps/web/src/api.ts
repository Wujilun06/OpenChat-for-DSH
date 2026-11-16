import type {
  HealthInfo,
  LoginResult,
  MeResult,
  MessageInfo,
  MessagesResult,
} from '@openchat/shared'

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

export interface ListMessagesParams {
  before?: number
  since?: number
  limit?: number
}

function messageQuery(params: ListMessagesParams): string {
  const query = new URLSearchParams()
  if (params.before !== undefined) query.set('before', String(params.before))
  if (params.since !== undefined) query.set('since', String(params.since))
  if (params.limit !== undefined) query.set('limit', String(params.limit))
  const text = query.toString()
  return text ? `?${text}` : ''
}

export interface SendMessageInput {
  clientId: string
  kind: 'text'
  text: string
  replyTo?: string | null
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

  messages: (params: ListMessagesParams = {}) =>
    request<MessagesResult>(`/api/messages${messageQuery(params)}`),

  sendMessage: (input: SendMessageInput) =>
    request<{ ok: true; message: MessageInfo; created: boolean }>('/api/messages', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  typing: (on: boolean) =>
    request<{ ok: true }>('/api/typing', {
      method: 'POST',
      body: JSON.stringify({ on }),
    }),
}
