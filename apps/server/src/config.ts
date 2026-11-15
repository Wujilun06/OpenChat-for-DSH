import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

/** 配置里能改的全部。多一项都要写在 config.example.json 里。 */
export interface AppConfig {
  server: {
    /** 监听地址。Funnel 模式下 127.0.0.1 就够；想让局域网直连改成 0.0.0.0。 */
    host: string
    port: number
    /** 对外网址，只用来拼 PWA 的绝对地址和判断 cookie 要不要 Secure。 */
    publicUrl: string
  }
  /** 登录密码。明文写在 config.json 里，这个文件不进 git。 */
  password: string
  peer: {
    name: string
    avatar: string
  }
  /** 数据目录，相对路径按仓库根算。 */
  dataDir: string
  session: {
    /** 登录一次能撑多少天。 */
    days: number
  }
  sticker: {
    maxBytes: number
    maxCount: number
  }
}

export interface AppPaths {
  /** 仓库根目录。 */
  root: string
  configFile: string
  dataDir: string
  dbFile: string
  stickersDir: string
  thumbsDir: string
  webDist: string
}

const PLACEHOLDER_PASSWORD = '在这里改成你自己的密码'

/**
 * 仓库根目录。
 *
 * 开发时是 apps/server/src，构建后是 apps/server/dist —— 都往上三层就是根。
 * 不依赖 cwd：从哪启动都一样。
 */
export function findRoot(from = import.meta.dirname): string {
  return resolve(from, '../../..')
}

export function resolvePaths(root: string, config: AppConfig, configFile: string): AppPaths {
  const dataDir = isAbsolute(config.dataDir) ? config.dataDir : resolve(root, config.dataDir)
  return {
    root,
    configFile,
    dataDir,
    dbFile: resolve(dataDir, 'openchat.db'),
    stickersDir: resolve(dataDir, 'stickers'),
    thumbsDir: resolve(dataDir, 'thumbs'),
    webDist: resolve(root, 'apps/web/dist'),
  }
}

/** 读配置。文件不在、密码没改、字段不对，一律当场报清楚，不带着坏配置跑。 */
export function loadConfig(root = findRoot()): { config: AppConfig; paths: AppPaths } {
  const configFile = process.env.OPENCHAT_CONFIG
    ? resolve(process.env.OPENCHAT_CONFIG)
    : resolve(root, 'config.json')

  if (!existsSync(configFile)) {
    throw new Error(
      `找不到配置文件：${configFile}\n` +
        `把 config.example.json 复制成 config.json，再把 password 改掉。`,
    )
  }

  let raw: string
  try {
    raw = readFileSync(configFile, 'utf8').replace(/^\uFEFF/, '')
  } catch (error) {
    throw new Error(`读不了配置文件：${configFile}（${String((error as Error).message)}）`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`配置文件不是合法 JSON：${configFile}（${String((error as Error).message)}）`)
  }

  const config = normalize(parsed, configFile)
  const paths = resolvePaths(root, config, configFile)
  return { config, paths }
}

function normalize(value: unknown, where: string): AppConfig {
  if (!value || typeof value !== 'object') throw new Error(`配置不是对象：${where}`)
  const v = value as Record<string, unknown>

  const server = (v.server ?? {}) as Record<string, unknown>
  const peer = (v.peer ?? {}) as Record<string, unknown>
  const session = (v.session ?? {}) as Record<string, unknown>
  const sticker = (v.sticker ?? {}) as Record<string, unknown>

  const password = String(v.password ?? '')
  if (!password) throw new Error(`配置里没写 password：${where}`)
  if (password === PLACEHOLDER_PASSWORD) {
    throw new Error(`password 还是示例里那句占位，先改成你自己的：${where}`)
  }

  const port = Number(server.port ?? 8787)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`server.port 不是合法端口：${String(server.port)}`)
  }

  return {
    server: {
      host: String(server.host ?? '127.0.0.1'),
      port,
      publicUrl: String(server.publicUrl ?? '').replace(/\/+$/, ''),
    },
    password,
    peer: {
      name: String(peer.name ?? '蓝色大肥鱼'),
      avatar: String(peer.avatar ?? '/peer.png'),
    },
    dataDir: String(v.dataDir ?? 'data'),
    session: {
      days: clampInt(session.days, 1, 365, 30),
    },
    sticker: {
      maxBytes: clampInt(sticker.maxBytes, 64 * 1024, 20 * 1024 * 1024, 5 * 1024 * 1024),
      maxCount: clampInt(sticker.maxCount, 1, 1000, 100),
    },
  }
}

function clampInt(input: unknown, min: number, max: number, fallback: number): number {
  const n = Number(input)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

export function ensureDirs(paths: AppPaths): void {
  for (const dir of [paths.dataDir, paths.stickersDir, paths.thumbsDir]) {
    mkdirSync(dir, { recursive: true })
  }
}
