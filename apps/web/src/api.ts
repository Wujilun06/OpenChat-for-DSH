import type {
  AttachmentInfo,
  HealthInfo,
  LoginResult,
  MeResult,
  MessageInfo,
  MessagesResult,
  StickerInfo,
  StickersResult,
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
  const isForm = init.body instanceof FormData
  if (init.body !== undefined && !isForm && !headers.has('content-type')) {
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
  kind: 'text' | 'sticker' | 'image' | 'video' | 'file'
  text?: string
  stickerId?: string
  attachmentId?: string
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

  stickers: () => request<StickersResult>('/api/stickers'),

  uploadSticker: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<{ ok: true; sticker: StickerInfo }>('/api/stickers', {
      method: 'POST',
      body: form,
    })
  },

  deleteSticker: (id: string) =>
    request<{ ok: true }>(`/api/stickers/${id}`, { method: 'DELETE' }),

  uploadAttachment: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<{ ok: true; attachment: AttachmentInfo }>('/api/attachments', {
      method: 'POST',
      body: form,
    })
  },

  sendVoice: (blob: Blob, input: { clientId: string; replyTo?: string | null }) => {
    const form = new FormData()
    const ext = blob.type.includes('mp4') ? 'mp4' : blob.type.includes('ogg') ? 'ogg' : 'webm'
    form.append('file', blob, `voice.${ext}`)
    const query = new URLSearchParams({ clientId: input.clientId })
    if (input.replyTo) query.set('replyTo', input.replyTo)
    return request<{ ok: true; message: MessageInfo; created: boolean }>(
      `/api/messages/voice?${query.toString()}`,
      { method: 'POST', body: form },
    )
  },

  requestCall: (kind: 'audio' | 'video') =>
    request<{ ok: false; code: string; message: string }>('/api/calls', {
      method: 'POST',
      body: JSON.stringify({ kind }),
    }),
}
