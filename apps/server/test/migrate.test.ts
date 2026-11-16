import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import type { AppPaths } from '../src/config.js'
import { openDatabase } from '../src/db.js'

/**
 * 这是 v1 的表结构，冻在这儿当迁移测试的输入。
 * 别改成 v2 —— 改了这测试就没意义了。
 */
const V1_SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, ua TEXT, ip TEXT
);
CREATE TABLE conversations (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'dm', title TEXT NOT NULL,
  dsh_session_id TEXT, last_seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conv_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  sender TEXT NOT NULL CHECK (sender IN ('me', 'fish')),
  kind TEXT NOT NULL CHECK (kind IN ('text', 'sticker', 'voice', 'system')),
  text TEXT, sticker_id TEXT, voice_ms INTEGER, audio_ref TEXT, reply_to TEXT,
  source TEXT NOT NULL DEFAULT 'web', client_id TEXT, created_at INTEGER NOT NULL,
  UNIQUE (conv_id, seq), UNIQUE (client_id)
);
CREATE INDEX idx_messages_conv_seq ON messages(conv_id, seq DESC);
CREATE INDEX idx_messages_sticker ON messages(sticker_id);
CREATE TABLE stickers (
  id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, ext TEXT NOT NULL, mime TEXT NOT NULL,
  width INTEGER NOT NULL, height INTEGER NOT NULL, bytes INTEGER NOT NULL,
  animated INTEGER NOT NULL DEFAULT 0, file_rel TEXT NOT NULL, thumb_rel TEXT,
  created_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE TABLE calls (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, direction TEXT NOT NULL,
  state TEXT NOT NULL, created_at INTEGER NOT NULL, ended_at INTEGER
);
INSERT INTO meta VALUES ('schema_version', '1');
INSERT INTO conversations VALUES ('c-main', 'dm', '和鱼', NULL, 1, 1000, 1000);
INSERT INTO messages (id, conv_id, seq, sender, kind, text, created_at)
  VALUES ('m1', 'c-main', 1, 'me', 'text', '迁移前的一句', 1001);
`

let workDir = ''

after(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

test('v1 的库能迁到 v2，旧消息还在', () => {
  workDir = mkdtempSync(join(tmpdir(), 'openchat-migrate-'))
  const paths: AppPaths = {
    root: workDir,
    configFile: join(workDir, 'config.json'),
    dataDir: workDir,
    dbFile: join(workDir, 'openchat.db'),
    stickersDir: join(workDir, 'stickers'),
    thumbsDir: join(workDir, 'thumbs'),
    filesDir: join(workDir, 'files'),
    fileThumbsDir: join(workDir, 'file-thumbs'),
    webDist: join(workDir, 'no-web'),
  }

  const old = new DatabaseSync(paths.dbFile)
  old.exec(V1_SCHEMA)
  old.close()

  const db = openDatabase(paths)

  const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
    value: string
  }
  assert.equal(String(version.value), '2')

  const message = db.prepare("SELECT id, text, attachment_id FROM messages WHERE id = 'm1'").get() as {
    id: string
    text: string
    attachment_id: string | null
  }
  assert.equal(message.text, '迁移前的一句')
  assert.equal(message.attachment_id, null)

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'attachments'")
    .get() as { name: string } | undefined
  assert.ok(tables, '应该建出 attachments 表')

  // 新类型现在能写了
  db.prepare(
    `INSERT INTO messages (id, conv_id, seq, sender, kind, text, attachment_id, created_at)
     VALUES ('m2', 'c-main', 2, 'me', 'image', NULL, 'a1', 2000)`,
  ).run()

  db.close()

  // 再开一次不会重复迁移
  const again = openDatabase(paths)
  const againVersion = again.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
    value: string
  }
  assert.equal(String(againVersion.value), '2')
  again.close()
})
