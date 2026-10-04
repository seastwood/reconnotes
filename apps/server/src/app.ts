import type http from 'node:http'
import type { Config } from './config'
import { Store } from './store'
import { SyncEngine } from './sync'
import { Ai } from './ai'
import { createHttpServer } from './http'
import { resumePendingAttachments } from './attachments'
import { scheduleBackups } from './backup'

export interface App {
  config: Config
  store: Store
  sync: SyncEngine
  ai: Ai
  server: http.Server
  close(): Promise<void>
}

export function createApp(config: Config, opts: { backups?: boolean } = {}): App {
  if (!config.token || config.token.length < 16) {
    throw new Error('RECON_TOKEN must be set to a secret of at least 16 characters (try: reconnotes-server gen-token)')
  }
  const store = new Store(config.dataDir)
  const ai = new Ai(config)
  const sync = new SyncEngine(config, store, ai)
  const server = createHttpServer(config, store, sync, ai)
  resumePendingAttachments(config, store, ai, sync)
  const stopBackups = opts.backups === false ? () => {} : scheduleBackups(config, store, sync)
  return {
    config,
    store,
    sync,
    ai,
    server,
    async close() {
      stopBackups()
      await sync.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      store.close()
    },
  }
}
