import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { DatabaseSync } from 'node:sqlite'
import sharp from 'sharp'
import type { AttachmentInfo, AttachmentKind } from '@openchat/shared'
import type { AppPaths } from '../config.js'

const THUMB_SIZE = 320
const execFileAsync = promisify(execFile)

export class AttachmentError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'AttachmentError'
    this.status = status
    this.code = code
  }
}

export interface AttachmentRow {
  id: string
  sha256: string
  kind: string
  name: string
  ext: string
  mime: string
  width: number | null
  height: number | null
  bytes: number
  file_rel: string
  thumb_rel: string | null
  created_at: number
}

const COLUMNS =
  'id, sha256, kind, name, ext, mime, width, height, bytes, file_rel, thumb_rel, created_at'

function rowToInfo(row: AttachmentRow): AttachmentInfo {
  return {
    id: row.id,
    kind: row.kind as AttachmentKind,
    name: row.name,
    mime: row.mime,
    bytes: Number(row.bytes),
    w: row.width === null ? null : Number(row.width),
    h: row.height === null ? null : Number(row.height),
    thumbUrl: row.thumb_rel ? `/api/attachments/${row.id}/thumb` : null,
    fileUrl: `/api/attachments/${row.id}/file`,
  }
}

export function getAttachmentRow(db: DatabaseSync, id: string): AttachmentRow | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM attachments WHERE id = ?`).get(id) as
    | AttachmentRow
    | undefined
  return row ?? null
}

export function getAttachmentInfo(db: DatabaseSync, id: string): AttachmentInfo | null {
  const row = getAttachmentRow(db, id)
  return row ? rowToInfo(row) : null
}

function findBySha(db: DatabaseSync, sha: string): AttachmentRow | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM attachments WHERE sha256 = ?`).get(sha) as
    | AttachmentRow
    | undefined
  return row ?? null
}

export interface AttachmentLimits {
  imageMaxBytes: number
  videoMaxBytes: number
  fileMaxBytes: number
}

export interface MediaTools {
  ffmpeg: string
  ffprobe: string
}

const IMAGE_FORMATS: Record<string, string> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
  gif: 'gif',
}

const VIDEO_FORMATS: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
}

/** 从文件名里拿个像样的扩展名，拿不到就按 mime 猜。 */
function guessExt(filename: string | undefined, fallback: string): string {
  const match = /\.([a-z0-9]{1,8})$/i.exec(filename ?? '')
  if (match?.[1]) return match[1].toLowerCase()
  return fallback
}

function cleanName(filename: string | undefined, fallback: string): string {
  const base = (filename ?? '').split(/[\\/]/).pop() ?? ''
  // 控制字符、路径分隔符、点开头的一律不要
  const safe = base.replace(/[\u0000-\u001f\u007f]/g, '').replace(/^\.+/, '').trim()
  if (!safe) return fallback
  return safe.length > 120 ? safe.slice(0, 120) : safe
}

/**
 * 存一个普通附件（图片 / 视频 / 文件）。
 *
 * 跟表情不一样：这里没有池子、没有软删，发完就挂在消息上。
 * 内容相同的文件只存一份。
 */
export async function createAttachment(
  db: DatabaseSync,
  paths: AppPaths,
  limits: AttachmentLimits,
  media: MediaTools,
  input: { buffer: Buffer; filename?: string; mime?: string },
): Promise<AttachmentInfo> {
  const { buffer } = input
  const mime = String(input.mime ?? 'application/octet-stream').toLowerCase()

  if (!buffer.length) throw new AttachmentError(400, 'empty_file', '这个文件是空的')

  const sha = createHash('sha256').update(buffer).digest('hex')
  const existing = findBySha(db, sha)
  if (existing) {
    // 早先传的视频可能还没有首帧（ffmpeg 后来才装、或者当时抽失败），补一次
    if (existing.kind === 'video' && (!existing.thumb_rel || !existing.width)) {
      const refreshed = await backfillVideo(db, paths, media, existing)
      if (refreshed) return rowToInfo(refreshed)
    }
    return rowToInfo(existing)
  }

  let kind: AttachmentKind = 'file'
  let ext = guessExt(input.filename, 'bin')
  let width: number | null = null
  let height: number | null = null
  let thumbRel: string | null = null

  if (mime.startsWith('image/')) {
    kind = 'image'
    if (buffer.length > limits.imageMaxBytes) {
      throw tooLarge('图片', limits.imageMaxBytes)
    }
    let meta
    try {
      meta = await sharp(buffer).metadata()
    } catch {
      throw new AttachmentError(400, 'bad_image', '这不是一张能读的图片')
    }
    const format = IMAGE_FORMATS[String(meta.format ?? '')]
    if (!format) throw new AttachmentError(400, 'unsupported_image', '只收 jpg / png / webp / gif')
    ext = format
    width = Number(meta.width ?? 0) || null
    height = Number(meta.height ?? 0) || null
    thumbRel = `file-thumbs/${sha}.png`
  } else if (mime.startsWith('video/')) {
    kind = 'video'
    if (buffer.length > limits.videoMaxBytes) {
      throw tooLarge('视频', limits.videoMaxBytes)
    }
    ext = VIDEO_FORMATS[mime] ?? guessExt(input.filename, 'mp4')
    // 视频首帧当缩略图（抽不出来就没有，前端会显示一个占位方块）
    thumbRel = `file-thumbs/${sha}.png`
  } else {
    kind = 'file'
    if (buffer.length > limits.fileMaxBytes) {
      throw tooLarge('文件', limits.fileMaxBytes)
    }
  }

  const id = randomUUID()
  const folder = sha.slice(0, 2)
  const fileRel = `files/${folder}/${sha}.${ext}`
  const filePath = join(paths.dataDir, fileRel)
  mkdirSync(join(paths.filesDir, folder), { recursive: true })

  const tmp = `${filePath}.tmp-${id}`
  writeFileSync(tmp, buffer)
  renameSync(tmp, filePath)

  if (kind === 'image' && thumbRel) {
    const thumbPath = join(paths.dataDir, thumbRel)
    mkdirSync(paths.fileThumbsDir, { recursive: true })
    try {
      await sharp(buffer, { animated: false })
        .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
        .png()
        .toFile(thumbPath)
    } catch {
      try {
        unlinkSync(thumbPath)
      } catch {
        // 本来就没写出来
      }
      thumbRel = null
    }
  }

  if (kind === 'video' && thumbRel) {
    const thumbPath = join(paths.dataDir, thumbRel)
    mkdirSync(paths.fileThumbsDir, { recursive: true })
    const probed = await probeVideo(media.ffprobe, filePath)
    width = probed.w
    height = probed.h
    const ok = await makeVideoThumb(media.ffmpeg, filePath, thumbPath)
    if (!ok) {
      thumbRel = null
      try {
        unlinkSync(thumbPath)
      } catch {
        // 本来就没写出来
      }
    }
  }

  const name = cleanName(input.filename, kind === 'image' ? 'image' : kind === 'video' ? 'video' : 'file')

  db.prepare(
    `INSERT INTO attachments
       (id, sha256, kind, name, ext, mime, width, height, bytes, file_rel, thumb_rel, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    sha,
    kind,
    name,
    ext,
    mime || 'application/octet-stream',
    width,
    height,
    buffer.length,
    fileRel,
    thumbRel && existsSync(join(paths.dataDir, thumbRel)) ? thumbRel : null,
    Date.now(),
  )

  const stored = getAttachmentRow(db, id)
  if (!stored) throw new Error('刚存进去的附件读不出来')
  return rowToInfo(stored)
}

export function attachmentFilePath(paths: AppPaths, row: AttachmentRow): string | null {
  const path = join(paths.dataDir, row.file_rel)
  return existsSync(path) ? path : null
}

export function attachmentThumbPath(paths: AppPaths, row: AttachmentRow): string | null {
  if (!row.thumb_rel) return null
  const path = join(paths.dataDir, row.thumb_rel)
  return existsSync(path) ? path : null
}

export function openAttachment(path: string, range?: { start: number; end: number }) {
  return range ? createReadStream(path, { start: range.start, end: range.end }) : createReadStream(path)
}

/** 老视频补首帧；抽不出来就不改。 */
async function backfillVideo(
  db: DatabaseSync,
  paths: AppPaths,
  media: MediaTools,
  row: AttachmentRow,
): Promise<AttachmentRow | null> {
  const file = join(paths.dataDir, row.file_rel)
  if (!existsSync(file)) return null
  mkdirSync(paths.fileThumbsDir, { recursive: true })

  const thumbRel = `file-thumbs/${row.sha256}.png`
  const thumbPath = join(paths.dataDir, thumbRel)
  const probed = await probeVideo(media.ffprobe, file)
  const ok = await makeVideoThumb(media.ffmpeg, file, thumbPath)
  if (!ok) return null

  db.prepare('UPDATE attachments SET width = ?, height = ?, thumb_rel = ? WHERE id = ?').run(
    probed.w ?? row.width,
    probed.h ?? row.height,
    thumbRel,
    row.id,
  )
  return getAttachmentRow(db, row.id)
}

async function probeVideo(
  ffprobe: string,
  file: string,
): Promise<{ w: number | null; h: number | null }> {
  try {
    const { stdout } = await execFileAsync(
      ffprobe,
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height',
        '-of',
        'json',
        file,
      ],
      { timeout: 15_000, windowsHide: true },
    )
    const parsed = JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number }> }
    const stream = parsed.streams?.[0]
    return {
      w: Number(stream?.width ?? 0) || null,
      h: Number(stream?.height ?? 0) || null,
    }
  } catch {
    return { w: null, h: null }
  }
}

/** 抽第一帧。ffmpeg 不在、或者这个片子读不了，就返回 false（没缩略图）。 */
async function makeVideoThumb(ffmpeg: string, file: string, out: string): Promise<boolean> {
  try {
    await execFileAsync(
      ffmpeg,
      ['-y', '-loglevel', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=320:-2', '-f', 'image2', out],
      { timeout: 30_000, windowsHide: true },
    )
    return existsSync(out)
  } catch {
    return false
  }
}

function tooLarge(label: string, maxBytes: number): AttachmentError {
  return new AttachmentError(
    413,
    'file_too_large',
    `${label}最多 ${Math.round(maxBytes / 1024 / 1024)} MB`,
  )
}
