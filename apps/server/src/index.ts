import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { loadConfig } from './config'
import { createApp } from './app'
import { runBackup } from './backup'
import { decryptPath } from './offsite'
import { defaultNames, loadTls, setupHttps, suggestedAddress } from './tls'
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
  https-setup Make a certificate so devices can use https:// (also on a
              WireGuard / private address): https-setup [address or name …]
              (by default every address of this machine)

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

  if (cmd === 'https-setup') {
    // the server's own data folder, so the certificate lands where the server looks (no variable to type)
    const config = loadConfig({ ...process.env, RECON_DATA_DIR: process.env.RECON_DATA_DIR || serviceDataDir() })
    const r = setupHttps(config, process.argv.length > 3 ? process.argv.slice(3) : defaultNames())
    const ip = suggestedAddress(r.names)
    console.log(`Certificate made for: ${r.names.join(', ')} (valid 825 days)
Saved in ${path.dirname(r.cert)}
${r.newCa ? 'A new private certificate authority was made' : 'Signed by your existing private certificate authority'}: ${r.ca}

Next:
1. Restart the server (sudo systemctl restart reconnotes). It serves https on port ${config.httpsPort}.
2. On each device, install the authority once – open http://${ip}:${config.port}/ca.crt
   iPhone / iPad: Allow → Settings › General › VPN & Device Management ›
   ReconNotes private CA › Install, then Settings › General › About ›
   Certificate Trust Settings › turn on “ReconNotes private CA”.
   Mac: open it in Keychain Access, double-click it › Trust › Always Trust.
3. In ReconNotes › Settings, change the server address to https://${ip}:${config.httpsPort}
${r.newCa ? '' : '\nDevices that already trust the authority need nothing new.'}`)
    return
  }

  const config = loadConfig()
  const app = createApp(config, { backups: cmd === 'serve', guides: cmd === 'serve' })

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

  if (app.secure) {
    app.secure.listen(config.httpsPort, config.host, () => log.info(`HTTPS on https://${config.host}:${config.httpsPort} (certificate: ${loadTls(config)?.file})`))
    app.secure.on('error', (err) => log.error(`HTTPS couldn't start on port ${config.httpsPort}: ${err.message}`))
  }
  // shared notes and folders – and nothing else – on a port of their own (the one to open up for the people you share with)
  if (config.sharePort) {
    app.shareServer.listen(config.sharePort, config.host, () => log.info(`share links on http://${config.host}:${config.sharePort} (shared notes and folders only)`))
    app.shareServer.on('error', (err) => log.error(`The share port ${config.sharePort} couldn't start: ${err.message} (set RECON_SHARE_PORT to another port, or 0 for none)`))
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

/** RECON_DATA_DIR as the installed service sets it (systemd unit or env file), else /var/lib/reconnotes when it exists. */
function serviceDataDir(): string | undefined {
  for (const f of ['/etc/systemd/system/reconnotes.service', '/etc/reconnotes.env']) {
    try {
      const m = /^\s*(?:Environment=)?["']?RECON_DATA_DIR=([^\s"']+)/m.exec(fs.readFileSync(f, 'utf8'))
      if (m) return m[1]
    } catch {
      /* not installed that way */
    }
  }
  return fs.existsSync('/var/lib/reconnotes') ? '/var/lib/reconnotes' : undefined
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
