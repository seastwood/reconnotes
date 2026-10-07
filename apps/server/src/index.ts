import crypto from 'node:crypto'
import { loadConfig } from './config'
import { createApp } from './app'
import { runBackup } from './backup'
import { decryptPath } from './offsite'
import { VERSION } from './http'
import { log } from './log'

const HELP = `ReconNotes server ${VERSION}

Usage: reconnotes-server [command]

Commands:
  serve       Run the sync server (default)
  backup      Write a backup now (and its offsite copy) and exit
  decrypt     Decrypt an encrypted offsite backup: decrypt <file or folder>
              (the passphrase from RECON_BACKUP_PASSPHRASE)
  reindex     Rebuild the search index and exit
  gen-token   Print a new random access token

Configuration is read from environment variables; see .env.example.
`

async function main() {
  const cmd = process.argv[2] ?? 'serve'
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') return void console.log(HELP)
  if (cmd === 'gen-token') return void console.log(crypto.randomBytes(24).toString('base64url'))

  if (cmd === 'decrypt') {
    const target = process.argv[3]
    const pass = process.env.RECON_BACKUP_PASSPHRASE
    if (!target || !pass) {
      console.error('Usage: RECON_BACKUP_PASSPHRASE=… reconnotes-server decrypt <file.enc or folder>')
      process.exit(1)
    }
    return void console.log(`${decryptPath(target, pass)} file(s) decrypted`)
  }

  const config = loadConfig()
  const app = createApp(config, { backups: cmd === 'serve' })

  if (cmd === 'backup') {
    const dir = await runBackup(config, app.store, app.sync, { waitOffsite: true })
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
      `AI agents: ${app.ai.enabled ? app.ai.describe() : 'none yet – add them in the app under Settings › AI agents'}`,
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
