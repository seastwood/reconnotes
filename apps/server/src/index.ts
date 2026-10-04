import crypto from 'node:crypto'
import { loadConfig } from './config'
import { createApp } from './app'
import { runBackup } from './backup'
import { VERSION } from './http'
import { log } from './log'

const HELP = `ReconNotes server ${VERSION}

Usage: reconnotes-server [command]

Commands:
  serve       Run the sync server (default)
  backup      Write a backup now and exit
  reindex     Rebuild the search index and exit
  gen-token   Print a new random access token

Configuration is read from environment variables; see .env.example.
`

async function main() {
  const cmd = process.argv[2] ?? 'serve'
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') return void console.log(HELP)
  if (cmd === 'gen-token') return void console.log(crypto.randomBytes(24).toString('base64url'))

  const config = loadConfig()
  const app = createApp(config, { backups: cmd === 'serve' })

  if (cmd === 'backup') {
    const dir = await runBackup(config, app.store, app.sync)
    console.log(dir)
    return app.close()
  }
  if (cmd === 'reindex') {
    app.sync.reindexAll()
    console.log('search index rebuilt')
    return app.close()
  }
  if (cmd !== 'serve') {
    console.error(HELP)
    process.exit(1)
  }

  app.server.listen(config.port, config.host, () => {
    log.info(`ReconNotes server ${VERSION} listening on http://${config.host}:${config.port}`)
    log.info(`data: ${config.dataDir}  backups: ${config.backupDir}`)
    log.info(
      `AI: ${app.ai.enabled ? config.aiModel : 'disabled (set ANTHROPIC_API_KEY)'}; audio transcription: ${config.transcribeUrl ?? 'disabled'}`,
    )
  })

  const shutdown = async () => {
    log.info('shutting down')
    await app.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
