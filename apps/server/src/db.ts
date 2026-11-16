import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AppPaths } from './config.js'

/** 现在的表结构版本。改表就 +1，并在 migrate() 里补一段。 */
export const SCHEMA_VERSION = 2

/**
 * 打开数据库并跑迁移。
 *
 * 只开一个连接：node:sqlite 是同步的，单人用不着连接池；
 * WAL + busy_timeout 足够扛「另一方在写」的情况。
 */
export function openDatabase(paths: AppPaths): DatabaseSync {
  const dir = dirname(paths.dbFile)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const db = new DatabaseSync(paths.dbFile)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA synchronous = NORMAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec('PRAGMA busy_timeout = 5000;')

  migrate(db)
  return db
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)

  const current = readMeta(db, 'schema_version')

  if (current === null) {
    db.exec(SCHEMA_V2)
    writeMeta(db, 'schema_version', String(SCHEMA_VERSION))
    seed(db)
    return
  }

  const version = Number(current)

  if (version === 1) {
    db.exec('PRAGMA foreign_keys = OFF;')
    try {
      db.exec('BEGIN;')
      db.exec(MIGRATE_1_TO_2)
      db.exec('COMMIT;')
    } catch (error) {
      db.exec('ROLLBACK;')
      throw error
    } finally {
      db.exec('PRAGMA foreign_keys = ON;')
    }
    writeMeta(db, 'schema_version', String(SCHEMA_VERSION))
    return
  }

  if (version !== SCHEMA_VERSION) {
    throw new Error(
      `数据库表结构是 v${current}，代码要的是 v${SCHEMA_VERSION}。` +
        `这个版本还没有自动迁移，先备份 data 目录再处理。`,
    )
  }
}

function seed(db: DatabaseSync): void {
  const now = Date.now()
  const exists = db.prepare('SELECT id FROM conversations LIMIT 1').get()
  if (!exists) {
    db.prepare(
      `INSERT INTO conversations (id, kind, title, last_seq, created_at, updated_at)
       VALUES (?, 'dm', ?, 0, ?, ?)`,
    ).run('c-main', '和鱼', now, now)
  }
}

function readMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row ? String(row.value) : null
}

function writeMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value)
}

const ATTACHMENTS_TABLE = `
CREATE TABLE IF NOT EXISTS attachments (
  id         TEXT PRIMARY KEY,
  sha256     TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL CHECK (kind IN ('image', 'video', 'file')),
  name       TEXT NOT NULL,
  ext        TEXT NOT NULL,
  mime       TEXT NOT NULL,
  width      INTEGER,
  height     INTEGER,
  bytes      INTEGER NOT NULL,
  file_rel   TEXT NOT NULL,
  thumb_rel  TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_created ON attachments(created_at DESC);
`

// 消息表单独拎出来：v2 迁移要重建它（CHECK 里的类型多了 image/video/file）。
const MESSAGES_TABLE = `
CREATE TABLE messages (
  id            TEXT PRIMARY KEY,
  conv_id       TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  sender        TEXT NOT NULL CHECK (sender IN ('me', 'fish')),
  kind          TEXT NOT NULL CHECK (kind IN ('text', 'sticker', 'voice', 'system', 'image', 'video', 'file')),
  text          TEXT,
  sticker_id    TEXT,
  attachment_id TEXT,
  voice_ms      INTEGER,
  -- 现在不存音频。这一列是给以后把语音加回来留的（对象键或文件相对路径）。
  audio_ref     TEXT,
  reply_to      TEXT,
  source        TEXT NOT NULL DEFAULT 'web',
  client_id     TEXT,
  created_at    INTEGER NOT NULL,
  UNIQUE (conv_id, seq),
  UNIQUE (client_id)
);
`

const MESSAGES_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_messages_conv_seq ON messages(conv_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_messages_sticker ON messages(sticker_id);
CREATE INDEX IF NOT EXISTS idx_messages_attachment ON messages(attachment_id);
`

const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash   TEXT PRIMARY KEY,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  ua           TEXT,
  ip           TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_expires ON auth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS conversations (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL DEFAULT 'dm',
  title          TEXT NOT NULL,
  dsh_session_id TEXT,
  last_seq       INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

${MESSAGES_TABLE}
${MESSAGES_INDEXES}

CREATE TABLE IF NOT EXISTS stickers (
  id         TEXT PRIMARY KEY,
  sha256     TEXT NOT NULL UNIQUE,
  ext        TEXT NOT NULL,
  mime       TEXT NOT NULL,
  width      INTEGER NOT NULL,
  height     INTEGER NOT NULL,
  bytes      INTEGER NOT NULL,
  animated   INTEGER NOT NULL DEFAULT 0,
  file_rel   TEXT NOT NULL,
  thumb_rel  TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_stickers_live ON stickers(deleted_at, created_at);

${ATTACHMENTS_TABLE}

CREATE TABLE IF NOT EXISTS calls (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  direction  TEXT NOT NULL,
  state      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ended_at   INTEGER
);
`

/** v1 → v2：消息表加 attachment_id、放开 kind 的 CHECK、加附件表。 */
const MIGRATE_1_TO_2 = `
ALTER TABLE messages RENAME TO messages_v1;

${MESSAGES_TABLE}

INSERT INTO messages
  (id, conv_id, seq, sender, kind, text, sticker_id, attachment_id, voice_ms, audio_ref, reply_to, source, client_id, created_at)
SELECT
  id, conv_id, seq, sender, kind, text, sticker_id, NULL, voice_ms, audio_ref, reply_to, source, client_id, created_at
FROM messages_v1;

DROP TABLE messages_v1;

${MESSAGES_INDEXES}

${ATTACHMENTS_TABLE}
`

/** 一条会话的当前水位（下一个 seq 该给多少）。 */
export function nextSeq(db: DatabaseSync, convId: string): number {
  const row = db
    .prepare('SELECT last_seq FROM conversations WHERE id = ?')
    .get(convId) as { last_seq: number } | undefined
  if (!row) throw new Error(`会话不存在：${convId}`)
  const next = Number(row.last_seq) + 1
  db.prepare('UPDATE conversations SET last_seq = ?, updated_at = ? WHERE id = ?').run(
    next,
    Date.now(),
    convId,
  )
  return next
}

export function cleanupExpiredSessions(db: DatabaseSync, now = Date.now()): number {
  const result = db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now)
  return Number(result.changes ?? 0)
}
