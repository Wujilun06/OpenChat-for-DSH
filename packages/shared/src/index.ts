/**
 * 前后端共用的契约类型。
 *
 * 这里只放「跨进程边界」的形状：HTTP 请求/响应、SSE 事件、消息对象。
 * 数据库行、内部状态不要往这里塞 —— 那是 server 自己的事。
 */

/** 谁说的。`me` = 网页这一端的人，`fish` = 对面那条鱼。 */
export type Sender = 'me' | 'fish'

/** 消息种类。 */
export type MessageKind = 'text' | 'sticker' | 'voice' | 'system' | 'image' | 'video' | 'file'

/** 普通附件（图片/视频/文件）跟表情是两回事：表情进池子，附件发完就完了。 */
export type AttachmentKind = 'image' | 'video' | 'file'

/** 这条消息从哪来：网页打的、开发期假鱼、DSH 会话、历史导入。 */
export type MessageSource = 'web' | 'mock' | 'dsh' | 'import'

export type CallKind = 'audio' | 'video'

export type CallState =
  | 'unsupported'
  | 'ringing'
  | 'active'
  | 'ended'
  | 'missed'
  | 'declined'

/** 对面的公开信息，不含任何账号数据。 */
export interface PeerInfo {
  name: string
  /** 相对路径或绝对 URL。 */
  avatar: string
}

export interface ConversationInfo {
  id: string
  kind: 'dm'
  title: string
  peer: PeerInfo
  /** 这条会话最后一条消息的 seq，客户端拿它当游标。 */
  lastSeq: number
}

export interface StickerInfo {
  id: string
  w: number
  h: number
  animated: boolean
  bytes: number
  createdAt: number
  thumbUrl: string
  fileUrl: string
}

export interface AttachmentInfo {
  id: string
  kind: AttachmentKind
  /** 原始文件名，只用来显示。 */
  name: string
  mime: string
  bytes: number
  /** 图片才有宽高。 */
  w: number | null
  h: number | null
  /** 图片有缩略图；视频和文件没有。 */
  thumbUrl: string | null
  fileUrl: string
}

/** 引用回复里只带够画一行的那点东西。 */
export interface MessageRef {
  id: string
  sender: Sender
  kind: MessageKind
  /** 文字或语音转写；表情消息为空。 */
  text: string | null
  stickerId: string | null
}

export interface MessageInfo {
  id: string
  convId: string
  seq: number
  sender: Sender
  kind: MessageKind
  /** 正文；语音消息里放转写结果。 */
  text: string | null
  sticker: StickerInfo | null
  attachment: AttachmentInfo | null
  /** 语音时长（毫秒）。没有音频时也保留，气泡上要显示秒数。 */
  voiceMs: number | null
  replyTo: MessageRef | null
  source: MessageSource
  createdAt: number
}

export interface CallInfo {
  id: string
  kind: CallKind
  direction: 'outgoing' | 'incoming'
  state: CallState
  createdAt: number
  endedAt: number | null
}

/* ------------------------------------------------------------------ */
/* HTTP 响应                                                            */
/* ------------------------------------------------------------------ */

export interface ApiError {
  ok: false
  code: string
  message: string
}

export type ApiResult<T> = ({ ok: true } & T) | ApiError

export interface HealthInfo {
  ok: true
  version: string
  node: string
  db: 'ok'
  asr: 'ready' | 'not_installed'
  /** 接 DSH 的桥开没开。 */
  dsh?: 'on' | 'off'
  time: number
}

export interface LoginResult {
  ok: true
  expiresAt: number
}

export interface MeResult {
  ok: true
  peer: PeerInfo
  conversation: ConversationInfo
  expiresAt: number
}

export interface MessagesResult {
  ok: true
  items: MessageInfo[]
  /** 再往前还有没有。 */
  hasMore: boolean
}

export interface StickersResult {
  ok: true
  items: StickerInfo[]
  maxCount: number
}

/* ------------------------------------------------------------------ */
/* SSE 事件                                                             */
/* ------------------------------------------------------------------ */

/**
 * 事件名写在 `type` 里，服务端也按这个名字当 SSE 的 `event:` 字段发。
 * 名字和含义在 README 的「事件」一节里逐个说明。
 */
export type StreamEvent =
  | { type: 'hello'; data: { convId: string; lastSeq: number; serverTime: number } }
  | { type: 'message.created'; data: MessageInfo }
  | {
      type: 'message.updated'
      data: { id: string; changes: { text?: string; voiceMs?: number } }
    }
  | { type: 'message.deleted'; data: { id: string } }
  | { type: 'typing.changed'; data: { who: Sender; on: boolean } }
  | { type: 'call.state'; data: CallInfo }
  | { type: 'ping'; data: { t: number } }

/* ------------------------------------------------------------------ */
/* 限制（前后端都按这些值校验）                                          */
/* ------------------------------------------------------------------ */

export const LIMITS = {
  /** 单张表情上限：5MB。 */
  stickerMaxBytes: 5 * 1024 * 1024,
  /** 表情共享池一共多少个。 */
  stickerMaxCount: 100,
  /** 语音最长 60 秒。 */
  voiceMaxMs: 60_000,
  /** 一条文字消息最长多少字。 */
  messageMaxChars: 4000,
  /** 普通图片单张上限。 */
  imageMaxBytes: 10 * 1024 * 1024,
  /** 视频单条上限。 */
  videoMaxBytes: 50 * 1024 * 1024,
  /** 文件单条上限。 */
  fileMaxBytes: 50 * 1024 * 1024,
} as const

/** 允许的表情格式，扩展名小写。 */
export const STICKER_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif'] as const
