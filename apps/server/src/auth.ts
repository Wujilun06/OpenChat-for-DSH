import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export const SESSION_COOKIE = 'oc_session'

/** 登录失败门禁：同一个 IP 10 分钟内错 5 次，锁 15 分钟。 */
const FAIL_WINDOW_MS = 10 * 60 * 1000
const MAX_FAILS = 5
const LOCK_MS = 15 * 60 * 1000

interface FailRecord {
  fails: number
  firstAt: number
  lockedUntil: number
}

export class LoginGuard {
  private readonly records = new Map<string, FailRecord>()

  /** 返回 null 表示可以试；返回秒数表示还要等多久。 */
  retryAfter(key: string, now = Date.now()): number | null {
    const rec = this.records.get(key)
    if (!rec) return null
    if (rec.lockedUntil > now) return Math.ceil((rec.lockedUntil - now) / 1000)
    // 锁到点了，或者窗口过去了 —— 都是重新开始数。
    if (rec.lockedUntil > 0 || now - rec.firstAt > FAIL_WINDOW_MS) {
      this.records.delete(key)
    }
    return null
  }

  recordFail(key: string, now = Date.now()): number | null {
    const rec = this.records.get(key)
    if (!rec || now - rec.firstAt > FAIL_WINDOW_MS) {
      this.records.set(key, { fails: 1, firstAt: now, lockedUntil: 0 })
      return null
    }
    rec.fails += 1
    if (rec.fails >= MAX_FAILS) {
      rec.lockedUntil = now + LOCK_MS
      return Math.ceil(LOCK_MS / 1000)
    }
    return null
  }

  recordSuccess(key: string): void {
    this.records.delete(key)
  }

  /** 定期清掉过期的记录，别让 Map 一直长。 */
  sweep(now = Date.now()): void {
    for (const [key, rec] of this.records) {
      if (rec.lockedUntil <= now && now - rec.firstAt > FAIL_WINDOW_MS) this.records.delete(key)
    }
  }
}

/**
 * 密码比对。
 *
 * 配置里存的是明文（用户的决定），但比较仍然走常数时间，
 * 顺便把长度差也压平：先各自 sha256，再比。
 */
export function checkPassword(input: string, expected: string): boolean {
  if (!input || !expected) return false
  const a = createHash('sha256').update(input, 'utf8').digest()
  const b = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(a, b)
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export interface IssuedSession {
  token: string
  expiresAt: number
}

export function createSession(
  db: DatabaseSync,
  days: number,
  ua: string | null,
  ip: string | null,
): IssuedSession {
  const token = randomBytes(32).toString('base64url')
  const now = Date.now()
  const expiresAt = now + days * 24 * 60 * 60 * 1000
  db.prepare(
    `INSERT INTO auth_sessions (token_hash, created_at, last_seen_at, expires_at, ua, ip)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(hashToken(token), now, now, expiresAt, ua, ip)
  return { token, expiresAt }
}

export interface SessionLookup {
  expiresAt: number
}

export function verifySession(
  db: DatabaseSync,
  token: string | undefined,
  now = Date.now(),
): SessionLookup | null {
  if (!token) return null
  const hash = hashToken(token)
  const row = db
    .prepare('SELECT expires_at, last_seen_at FROM auth_sessions WHERE token_hash = ?')
    .get(hash) as { expires_at: number; last_seen_at: number } | undefined
  if (!row) return null
  if (Number(row.expires_at) <= now) {
    db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hash)
    return null
  }
  // 一分钟才写一次，别让每个请求都落盘。
  if (now - Number(row.last_seen_at) > 60_000) {
    db.prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?').run(now, hash)
  }
  return { expiresAt: Number(row.expires_at) }
}

export function revokeSession(db: DatabaseSync, token: string | undefined): void {
  if (!token) return
  db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hashToken(token))
}

export function revokeAllSessions(db: DatabaseSync): number {
  const result = db.prepare('DELETE FROM auth_sessions').run()
  return Number(result.changes ?? 0)
}
