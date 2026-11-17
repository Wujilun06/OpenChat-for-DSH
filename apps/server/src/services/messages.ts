import type { DatabaseSync } from 'node:sqlite'
import type {
  MessageInfo,
  MessageKind,
  MessageRef,
  MessageSource,
  Sender,
} from '@openchat/shared'
import { nextSeq } from '../db.js'
import type { Hub } from './hub.js'
import { getAttachmentInfo } from './attachments.js'
import { getStickerInfo } from './stickers.js'

export interface MessageRow {
  id: string
  conv_id: string
  seq: number
  sender: string
  kind: string
  text: string | null
  sticker_id: string | null
  attachment_id: string | null
  voice_ms: number | null
  reply_to: string | null
  source: string
  created_at: number
}

export interface NewMessage {
  convId: string
  sender: Sender
  kind: MessageKind
  text: string | null
  voiceMs?: number | null
  stickerId?: string | null
  attachmentId?: string | null
  replyTo?: string | null
  source: MessageSource
  clientId?: string | null
  /** 只有从别处导入的历史才需要指定；平时用现在的时刻。 */
  createdAt?: number
}

const COLUMNS =
  'id, conv_id, seq, sender, kind, text, sticker_id, attachment_id, voice_ms, reply_to, source, created_at'

export function rowToMessage(db: DatabaseSync, row: MessageRow): MessageInfo {
  const reply = row.reply_to ? refOf(db, row.reply_to) : null
  return {
    id: row.id,
    convId: row.conv_id,
    seq: Number(row.seq),
    sender: row.sender as Sender,
    kind: row.kind as MessageKind,
    text: row.text,
    sticker: row.sticker_id ? getStickerInfo(db, row.sticker_id) : null,
    attachment: row.attachment_id ? getAttachmentInfo(db, row.attachment_id) : null,
    voiceMs: row.voice_ms === null ? null : Number(row.voice_ms),
    replyTo: reply,
    source: row.source as MessageSource,
    createdAt: Number(row.created_at),
  }
}

function refOf(db: DatabaseSync, id: string): MessageRef | null {
  const row = db
    .prepare('SELECT id, sender, kind, text, sticker_id FROM messages WHERE id = ?')
    .get(id) as
    | { id: string; sender: string; kind: string; text: string | null; sticker_id: string | null }
    | undefined
  if (!row) return null
  return {
    id: row.id,
    sender: row.sender as Sender,
    kind: row.kind as MessageKind,
    text: row.text,
    stickerId: row.sticker_id,
  }
}

export function findMessage(db: DatabaseSync, id: string): MessageInfo | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM messages WHERE id = ?`).get(id) as
    | MessageRow
    | undefined
  return row ? rowToMessage(db, row) : null
}

function existsBefore(db: DatabaseSync, convId: string, seq: number): boolean {
  return Boolean(
    db
      .prepare('SELECT 1 AS n FROM messages WHERE conv_id = ? AND seq < ? LIMIT 1')
      .get(convId, seq),
  )
}

function existsAfter(db: DatabaseSync, convId: string, seq: number): boolean {
  return Boolean(
    db
      .prepare('SELECT 1 AS n FROM messages WHERE conv_id = ? AND seq > ? LIMIT 1')
      .get(convId, seq),
  )
}

/**
 * 翻历史：`before` 是「比这个 seq 更早的」，不给就是最新的。
 * 一律按 seq 升序交回去，前端直接往列表后面接。
 */
export function listBefore(
  db: DatabaseSync,
  convId: string,
  before: number | null,
  limit: number,
): { items: MessageInfo[]; hasMore: boolean } {
  const rows = (
    before === null
      ? db
          .prepare(
            `SELECT ${COLUMNS} FROM messages WHERE conv_id = ? ORDER BY seq DESC LIMIT ?`,
          )
          .all(convId, limit)
      : db
          .prepare(
            `SELECT ${COLUMNS} FROM messages WHERE conv_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`,
          )
          .all(convId, before, limit)
  ) as unknown as MessageRow[]

  const items = rows.reverse().map((row) => rowToMessage(db, row))
  const first = items[0]
  const hasMore = items.length === limit && first ? existsBefore(db, convId, first.seq) : false
  return { items, hasMore }
}

/** 断线补齐：`seq > since` 的全部，升序。 */
export function listSince(
  db: DatabaseSync,
  convId: string,
  since: number,
  limit: number,
): { items: MessageInfo[]; hasMore: boolean } {
  const rows = db
    .prepare(
      `SELECT ${COLUMNS} FROM messages WHERE conv_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
    )
    .all(convId, since, limit) as unknown as MessageRow[]

  const items = rows.map((row) => rowToMessage(db, row))
  const last = items[items.length - 1]
  const hasMore = items.length === limit && last ? existsAfter(db, convId, last.seq) : false
  return { items, hasMore }
}

/**
 * 落一条消息。seq 的分配和插入在同一个事务里，
 * 两个人同时发也不会拿到同一个号。
 */
export function insertMessage(db: DatabaseSync, input: NewMessage): MessageInfo {
  const id = crypto.randomUUID()
  const now =
    typeof input.createdAt === 'number' && Number.isFinite(input.createdAt)
      ? Math.trunc(input.createdAt)
      : Date.now()

  db.exec('BEGIN IMMEDIATE')
  try {
    const seq = nextSeq(db, input.convId)
    db.prepare(
      `INSERT INTO messages
         (id, conv_id, seq, sender, kind, text, sticker_id, attachment_id, voice_ms, reply_to, source, client_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.convId,
      seq,
      input.sender,
      input.kind,
      input.text,
      input.stickerId ?? null,
      input.attachmentId ?? null,
      input.voiceMs ?? null,
      input.replyTo ?? null,
      input.source,
      input.clientId ?? null,
      now,
    )
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  const stored = findMessage(db, id)
  if (!stored) throw new Error('刚插进去的消息读不出来')
  return stored
}

/**
 * 对外发消息：先按 clientId 去重，再落库，最后广播。
 *
 * 返回 `created: false` 说明是重发，直接给客户端原来那条。
 */
export function createMessage(
  db: DatabaseSync,
  hub: Hub,
  input: NewMessage,
): { message: MessageInfo; created: boolean } {
  if (input.clientId) {
    const existing = db
      .prepare(`SELECT ${COLUMNS} FROM messages WHERE client_id = ?`)
      .get(input.clientId) as MessageRow | undefined
    if (existing) return { message: rowToMessage(db, existing), created: false }
  }

  const message = insertMessage(db, input)
  hub.publish({ type: 'message.created', data: message })
  return { message, created: true }
}
