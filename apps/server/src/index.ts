import { ensureDirs, loadConfig } from './config.js'
import { cleanupExpiredSessions, openDatabase } from './db.js'
import { APP_VERSION, buildApp } from './app.js'

async function main(): Promise<void> {
  const { config, paths } = loadConfig()
  ensureDirs(paths)

  const db = openDatabase(paths)
  const purged = cleanupExpiredSessions(db)

  const app = buildApp({ config, paths, db }, { logger: true })

  const address = await app.listen({ host: config.server.host, port: config.server.port })
  app.log.info(
    `OpenChat v${APP_VERSION} 起来了：${address}（配置 ${paths.configFile}，数据库 ${paths.dbFile}）`,
  )
  if (purged > 0) app.log.info(`清掉了 ${purged} 条过期登录`)

  let closing = false
  const shutdown = async (signal: string) => {
    if (closing) return
    closing = true
    app.log.info(`收到 ${signal}，收尾…`)
    try {
      await app.close()
    } catch (error) {
      app.log.error(error)
    }
    try {
      db.close()
    } catch (error) {
      app.log.error(error)
    }
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  // Windows 关机时不会发 SIGTERM，靠这个兜底把 WAL 收拾干净。
  process.on('SIGBREAK', () => void shutdown('SIGBREAK'))
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`\n启动失败：${message}\n`)
  process.exit(1)
})
