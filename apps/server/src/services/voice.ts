import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { AppConfig, AppPaths } from '../config.js'

const execFileAsync = promisify(execFile)

/** 录音上限 8MB：60 秒的 opus/mp4 远到不了。 */
const MAX_AUDIO_BYTES = 8 * 1024 * 1024
const MAX_VOICE_MS = 61_000

export class VoiceError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'VoiceError'
    this.status = status
    this.code = code
  }
}

export interface VoiceResult {
  text: string
  durationMs: number
}

export interface VoiceService {
  ready(): boolean
  transcribe(input: { buffer: Buffer; mime: string }): Promise<VoiceResult>
}

/**
 * 语音转写：临时落盘 → ffmpeg 转 16k wav → SenseVoice → 删临时文件。
 *
 * 音频一个字都不留，只把文字和时长交出去。
 */
export function createVoiceService(paths: AppPaths, config: AppConfig): VoiceService {
  const python = config.asr.python || paths.asrPython
  const modelDir = config.asr.modelDir || paths.asrModelDir

  const ready = () =>
    config.asr.enabled &&
    existsSync(python) &&
    existsSync(paths.asrScript) &&
    existsSync(join(modelDir, 'model.int8.onnx')) &&
    existsSync(join(modelDir, 'tokens.txt'))

  const wavDurationMs = async (wavPath: string): Promise<number> => {
    try {
      const { stdout } = await execFileAsync(
        config.media.ffprobe,
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wavPath],
        { timeout: 15_000, windowsHide: true },
      )
      const seconds = Number(stdout.trim())
      if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
    } catch {
      // 下面按文件大小兜底
    }
    try {
      // 16k 单声道 16bit = 32000 字节/秒，去掉约 44 字节头
      const size = statSync(wavPath).size
      return Math.max(0, Math.round(((size - 44) / 32000) * 1000))
    } catch {
      return 0
    }
  }

  const transcribe: VoiceService['transcribe'] = async ({ buffer, mime }) => {
    if (!ready()) {
      throw new VoiceError(503, 'asr_not_ready', '转写还没装好，先跑 scripts/install-asr.ps1')
    }
    if (!buffer.length) throw new VoiceError(400, 'empty_audio', '空的音频')
    if (buffer.length > MAX_AUDIO_BYTES) {
      throw new VoiceError(413, 'audio_too_large', '录音太大了')
    }

    mkdirSync(paths.tmpDir, { recursive: true })
    const id = randomUUID()
    const ext = mime.includes('mp4')
      ? 'mp4'
      : mime.includes('ogg')
        ? 'ogg'
        : mime.includes('wav')
          ? 'wav'
          : 'webm'
    const inPath = join(paths.tmpDir, `${id}.${ext}`)
    // 名字必须跟输入不同：上传的本来就是 wav 的话，同名会让 ffmpeg 拒绝干活
    const wavPath = join(paths.tmpDir, `${id}.16k.wav`)
    writeFileSync(inPath, buffer)

    try {
      try {
        await execFileAsync(
          config.media.ffmpeg,
          ['-y', '-loglevel', 'error', '-i', inPath, '-ac', '1', '-ar', '16000', '-f', 'wav', wavPath],
          { timeout: 30_000, windowsHide: true },
        )
      } catch (error) {
        console.error('[voice] ffmpeg 转换失败：', (error as Error).message)
        throw new VoiceError(400, 'bad_audio', '这段录音读不出来')
      }

      const durationMs = await wavDurationMs(wavPath)
      if (durationMs > MAX_VOICE_MS) {
        throw new VoiceError(400, 'voice_too_long', '超过 60 秒了')
      }

      let stdout = ''
      try {
        const result = await execFileAsync(
          python,
          [
            paths.asrScript,
            '--model-dir',
            modelDir,
            '--threads',
            String(config.asr.threads),
            wavPath,
          ],
          {
            timeout: config.asr.timeoutMs,
            windowsHide: true,
            maxBuffer: 1024 * 1024,
            encoding: 'utf8',
            // Windows 上不强制的话，子进程会按本地代码页输出，中文会变乱码
            env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
          },
        )
        stdout = result.stdout
      } catch (error) {
        const raw = (error as { stdout?: string }).stdout ?? ''
        const parsed = parseAsrJson(raw)
        throw new VoiceError(500, 'asr_failed', parsed.error ?? '转写进程出错了')
      }

      const parsed = parseAsrJson(stdout)
      if (!parsed.ok) throw new VoiceError(500, 'asr_failed', parsed.error ?? '转写失败')

      const text = parsed.text.trim()
      if (!text) throw new VoiceError(422, 'asr_empty', '没听清，再说一遍')

      return { text, durationMs }
    } finally {
      for (const path of [inPath, wavPath]) {
        try {
          unlinkSync(path)
        } catch {
          // 本来就没写出来 / 已经删了
        }
      }
    }
  }

  return { ready, transcribe }
}

interface AsrOutput {
  ok: boolean
  text: string
  error?: string
}

/** 子进程只保证最后一行是 JSON。 */
function parseAsrJson(stdout: string): AsrOutput {
  const lines = stdout.trim().split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim()
    if (!line || !line.startsWith('{')) continue
    try {
      const parsed = JSON.parse(line) as { ok?: boolean; text?: string; error?: string }
      return {
        ok: parsed.ok === true,
        text: String(parsed.text ?? ''),
        error: parsed.error ? String(parsed.error) : undefined,
      }
    } catch {
      // 继续往上找
    }
  }
  return { ok: false, text: '', error: '转写结果读不出来' }
}
