import type http from 'node:http'
import type { Config } from './config'
import { Store } from './store'
import { SyncEngine } from './sync'
import { Ai } from './ai'
import { AgentRegistry } from './agents'
import { createHttpServer } from './http'
import { resumePendingAttachments } from './attachments'
import { scheduleBackups } from './backup'
import { Devices } from './devices'
import { Jobs } from './jobs'
import { JOB_KINDS, registerJobHandlers } from './jobHandlers'
import { Notifier } from './notify'
import { MeaningIndex } from './semantic'
import { Samples } from './bench'

export interface App {
  config: Config
  store: Store
  sync: SyncEngine
  ai: Ai
  devices: Devices
  jobs: Jobs
  server: http.Server
  close(): Promise<void>
}

export function createApp(config: Config, opts: { backups?: boolean } = {}): App {
  if (!config.token || config.token.length < 16) {
    throw new Error('RECON_TOKEN must be set to a secret of at least 16 characters (try: reconnotes-server gen-token)')
  }
  const store = new Store(config.dataDir)
  const ai = new Ai(new AgentRegistry(store, config), config, store)
  const devices = new Devices(store, config.token)
  const sync = new SyncEngine(config, store, ai, devices)
  const jobs = new Jobs(store)
  sync.jobs = jobs
  sync.meaning = new MeaningIndex(store, ai.agents)
  const samples = new Samples(store)
  registerJobHandlers(config, store, sync, ai, jobs, samples)
  const notifier = new Notifier(store)
  jobs.onFinish = (job) => notifier.jobFinished(job, JOB_KINDS[job.kind] ?? 'Job')
  const { server, closeSockets } = createHttpServer(config, store, sync, ai, devices, jobs, notifier, samples)
  jobs.start()
  resumePendingAttachments(config, store, ai, sync)
  sync.embedMissing()
  const stopBackups = opts.backups === false ? () => {} : scheduleBackups(config, store, sync)
  return {
    config,
    store,
    sync,
    ai,
    devices,
    jobs,
    server,
    async close() {
      stopBackups()
      await sync.destroy()
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      closeSockets()
      await closed
      store.close()
    },
  }
}
