import { createHash, randomUUID } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import sharp, { type Metadata } from 'sharp'
import type { StickerInfo } from '@openchat/shared'
import type { AppPaths } from '../config.js'

/** 缩略图最长边。 */
const THUMB_SIZE = 240

const FORMATS: Record<string, string> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
  gif: 'gif',
}

export class StickerError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'StickerError'
    this.status = status
    this.code = code
  }
}

export interface StickerRow {
  id: string
  sha256: string
  ext: string
  mime: string
  width: number
  height: number
  bytes: number
  animated: number
  file_rel: string
  thumb_rel: string | null
  created_at: number
  deleted_at: number | null
}

const COLUMNS =
  'id, sha256, ext, mime, width, height, bytes, animated, file_rel, thumb_rel, created_at, deleted_at'

function rowToInfo(row: StickerRow): StickerInfo {
  return {
    id: row.id,
    w: Number(row.width),
    h: Number(row.height),
    animated: Number(row.animated) === 1,
    bytes: Number(row.bytes),
    createdAt: Number(row.created_at),
    thumbUrl: `/api/stickers/${row.id}/thumb`,
    fileUrl: `/api/stickers/${row.id}/file`,
  }
}

export function listStickers(db: DatabaseSync): StickerInfo[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM stickers WHERE deleted_at IS NULL ORDER BY created_at DESC`)
    .all() as unknown as StickerRow[]
  return rows.map(rowToInfo)
}

export function countLive(db: DatabaseSync): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM stickers WHERE deleted_at IS NULL')
    .get() as { n: number } | undefined
  return Number(row?.n ?? 0)
}

/** 连软删的也能拿到 —— 历史消息要照显。 */
export function getStickerRow(db: DatabaseSync, id: string): StickerRow | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM stickers WHERE id = ?`).get(id) as
    | StickerRow
    | undefined
  return row ?? null
}

export function getStickerInfo(db: DatabaseSync, id: string): StickerInfo | null {
  const row = getStickerRow(db, id)
  return row ? rowToInfo(row) : null
}

export function liveStickerInfo(db: DatabaseSync, id: string): StickerInfo | null {
  const row = getStickerRow(db, id)
  if (!row || row.deleted_at !== null) return null
  return rowToInfo(row)
}

function findBySha(db: DatabaseSync, sha: string): StickerRow | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM stickers WHERE sha256 = ?`).get(sha) as
    | StickerRow
    | undefined
  return row ?? null
}

export interface UploadLimits {
  maxBytes: number
  maxCount: number
}

/**
 * 存一张表情：验格式、算哈希、写原图、出首帧缩略图。
 *
 * 同一张图再传一次直接给原来那条；软删过的会复活。
 */
export async function createSticker(
  db: DatabaseSync,
  paths: AppPaths,
  limits: UploadLimits,
  input: { buffer: Buffer; filename?: string },
): Promise<StickerInfo> {
  const { buffer } = input
  if (!buffer.length) throw new StickerError(400, 'empty_file', '这个文件是空的')
  if (buffer.length > limits.maxBytes) {
    throw new StickerError(
      413,
      'file_too_large',
      `单张最多 ${Math.round(limits.maxBytes / 1024 / 1024)} MB`,
    )
  }

  const sha = createHash('sha256').update(buffer).digest('hex')

  const existing = findBySha(db, sha)
  if (existing) {
    if (existing.deleted_at !== null) {
      if (countLive(db) >= limits.maxCount) throw limitError(limits.maxCount)
      db.prepare('UPDATE stickers SET deleted_at = NULL WHERE id = ?').run(existing.id)
      const revived = getStickerRow(db, existing.id)
      if (!revived) throw new Error('复活之后读不出来')
      return rowToInfo(revived)
    }
    return rowToInfo(existing)
  }

  if (countLive(db) >= limits.maxCount) throw limitError(limits.maxCount)

  let meta: Metadata
  try {
    meta = await sharp(buffer).metadata()
  } catch {
    throw new StickerError(400, 'bad_image', '这不是一张能读的图片')
  }

  const format = FORMATS[String(meta.format ?? '')]
  if (!format) {
    throw new StickerError(400, 'unsupported_format', '只收 jpg / png / webp / gif')
  }
  const width = Number(meta.width ?? 0)
  const height = Number(meta.height ?? 0)
  if (!width || !height) throw new StickerError(400, 'bad_image', '读不出尺寸')
  const animated = Number(meta.pages ?? 1) > 1

  const id = randomUUID()
  const folder = sha.slice(0, 2)
  const fileRel = `stickers/${folder}/${sha}.${format}`
  const filePath = join(paths.dataDir, fileRel)
  mkdirSync(join(paths.stickersDir, folder), { recursive: true })

  // 先写临时文件再改名，中途断电不会留下半个图。
  const tmp = `${filePath}.tmp-${id}`
  writeFileSync(tmp, buffer)
  renameSync(tmp, filePath)

  const thumbRel = `thumbs/${sha}.png`
  const thumbPath = join(paths.dataDir, thumbRel)
  mkdirSync(paths.thumbsDir, { recursive: true })
  try {
    await sharp(buffer, { animated: false })
      .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toFile(thumbPath)
  } catch {
    // 缩略图出不来就算了，取图的时候会退回原图。
    try {
      unlinkSync(thumbPath)
    } catch {
      // 本来就没写出来
    }
  }

  const mime =
    format === 'jpg' ? 'image/jpeg' : format === 'gif' ? 'image/gif' : `image/${format}`

  db.prepare(
    `INSERT INTO stickers
       (id, sha256, ext, mime, width, height, bytes, animated, file_rel, thumb_rel, created_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    id,
    sha,
    format,
    mime,
    width,
    height,
    buffer.length,
    animated ? 1 : 0,
    fileRel,
    existsSync(thumbPath) ? thumbRel : null,
    Date.now(),
  )

  const stored = getStickerRow(db, id)
  if (!stored) throw new Error('刚存进去的表情读不出来')
  return rowToInfo(stored)
}

export function softDeleteSticker(db: DatabaseSync, id: string): boolean {
  const row = getStickerRow(db, id)
  if (!row || row.deleted_at !== null) return false
  db.prepare('UPDATE stickers SET deleted_at = ? WHERE id = ?').run(Date.now(), id)
  return true
}

export function stickerFilePath(paths: AppPaths, row: StickerRow): string | null {
  const path = join(paths.dataDir, row.file_rel)
  return existsSync(path) ? path : null
}

export function stickerThumbPath(paths: AppPaths, row: StickerRow): string | null {
  if (row.thumb_rel) {
    const path = join(paths.dataDir, row.thumb_rel)
    if (existsSync(path)) return path
  }
  return null
}

export function openStickerFile(path: string) {
  return createReadStream(path)
}

function limitError(maxCount: number): StickerError {
  return new StickerError(409, 'sticker_limit', `表情最多 ${maxCount} 个，先删几个`)
}
