import type http from 'node:http'
import { usePromptStore } from './prompts'
import type https from 'node:https'
import type { Config } from './config'
import { Store } from './store'
import { SyncEngine } from './sync'
import { Ai } from './ai'
import { AgentRegistry } from './agents'
import { createHttpServer } from './http'
import { createShareServer } from './shareServer'
import { resumePendingAttachments } from './attachments'
import { scheduleBackups } from './backup'
import { startDigestSchedule } from './digest'
import { GUIDES_FOLDER, seedSetupGuides } from './setupGuides'
import { log } from './log'
import { Devices } from './devices'
import { Jobs } from './jobs'
import { JOB_KINDS, registerJobHandlers } from './jobHandlers'
import { Notifier } from './notify'
import { MeaningIndex } from './semantic'
import { Samples } from './bench'
import { Apns } from './apns'

export interface App {
  config: Config
  store: Store
  sync: SyncEngine
  ai: Ai
  devices: Devices
  jobs: Jobs
  server: http.Server
  /** HTTPS, when there's a certificate */
  secure: https.Server | null
  /** the share port's server: shared notes and folders only (shareServer.ts) */
  shareServer: http.Server
  close(): Promise<void>
}

export function createApp(config: Config, opts: { backups?: boolean; guides?: boolean } = {}): App {
  if (!config.token || config.token.length < 16) {
    throw new Error('RECON_TOKEN must be set to a secret of at least 16 characters (try: reconnotes-server gen-token)')
  }
  const store = new Store(config.dataDir)
  const ai = new Ai(new AgentRegistry(store, config), config, store)
  // the prompts you changed (Settings › Prompts)
  usePromptStore(store)
  const devices = new Devices(store, config.token)
  const sync = new SyncEngine(config, store, ai, devices)
  const jobs = new Jobs(store)
  sync.jobs = jobs
  sync.meaning = new MeaningIndex(store, ai.agents)
  const samples = new Samples(store)
  registerJobHandlers(config, store, sync, ai, jobs, samples)
  const notifier = new Notifier(store, new Apns(store))
  jobs.onFinish = (job) => notifier.jobFinished(job, JOB_KINDS[job.kind] ?? 'Job')
  const { server, secure, closeSockets, shares } = createHttpServer(config, store, sync, ai, devices, jobs, notifier, samples)
  const shareServer = createShareServer({ store, sync, shares })
  jobs.start()
  resumePendingAttachments(config, store, ai, sync)
  sync.embedMissing()
  const stopBackups = opts.backups === false ? () => {} : scheduleBackups(config, store, sync)
  const stopDigest = startDigestSchedule(store, jobs)
  // the setup guides, as notes in a "ReconNotes Setup" folder (each added once)
  if (opts.guides)
    void seedSetupGuides(config, store, ai, sync)
      .then((ids) => ids.length && log.info(`added ${ids.length} setup guide${ids.length === 1 ? '' : 's'} to the “${GUIDES_FOLDER}” folder`))
      .catch((err) => log.warn(`setup guides not added: ${(err as Error).message}`))
  return {
    config,
    store,
    sync,
    ai,
    devices,
    jobs,
    server,
    secure,
    shareServer,
    async close() {
      stopBackups()
      stopDigest()
      await sync.destroy()
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      secure?.close()
      shareServer.close()
      shareServer.closeAllConnections()
      closeSockets()
      await closed
      store.close()
    },
  }
}
