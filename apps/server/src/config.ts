import path from 'node:path'

/**
 * Server configuration, read from environment variables (see .env.example).
 */
export interface Config {
  port: number
  host: string
  dataDir: string
  /** shared secret every device must present */
  token: string
  /** directory containing the built web app, served at / (optional) */
  webDir: string | null
  anthropicApiKey: string | null
  aiModel: string
  aiEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** automatically recognise handwriting in drawings so it is searchable */
  autoHandwriting: boolean
  /** wait this long after the last stroke before recognising a drawing */
  handwritingDebounceMs: number
  /** automatically extract text from images (OCR + description) */
  autoImageText: boolean
  /** OpenAI-compatible speech-to-text endpoint, e.g. a local whisper server */
  transcribeUrl: string | null
  transcribeModel: string
  transcribeApiKey: string | null
  backupDir: string
  backupIntervalHours: number
  backupKeep: number
  maxUploadBytes: number
}

const bool = (v: string | undefined, dflt: boolean) => (v === undefined || v === '' ? dflt : /^(1|true|yes|on)$/i.test(v))

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = path.resolve(env.RECON_DATA_DIR ?? './data')
  const token = env.RECON_TOKEN ?? ''
  const anthropicApiKey = env.ANTHROPIC_API_KEY || null
  return {
    port: Number(env.RECON_PORT ?? env.PORT ?? 8787),
    host: env.RECON_HOST ?? '0.0.0.0',
    dataDir,
    token,
    webDir: env.RECON_WEB_DIR ? path.resolve(env.RECON_WEB_DIR) : null,
    anthropicApiKey,
    aiModel: env.RECON_AI_MODEL ?? 'claude-opus-5-5',
    aiEffort: (env.RECON_AI_EFFORT as Config['aiEffort']) ?? 'medium',
    autoHandwriting: bool(env.RECON_AUTO_HANDWRITING, Boolean(anthropicApiKey)),
    handwritingDebounceMs: Number(env.RECON_HANDWRITING_DEBOUNCE_MS ?? 90_000),
    autoImageText: bool(env.RECON_AUTO_IMAGE_TEXT, Boolean(anthropicApiKey)),
    transcribeUrl: env.RECON_TRANSCRIBE_URL || null,
    transcribeModel: env.RECON_TRANSCRIBE_MODEL ?? 'whisper-1',
    transcribeApiKey: env.RECON_TRANSCRIBE_API_KEY || null,
    backupDir: path.resolve(env.RECON_BACKUP_DIR ?? path.join(dataDir, 'backups')),
    backupIntervalHours: Number(env.RECON_BACKUP_INTERVAL_HOURS ?? 24),
    backupKeep: Number(env.RECON_BACKUP_KEEP ?? 14),
    maxUploadBytes: Number(env.RECON_MAX_UPLOAD_MB ?? 200) * 1024 * 1024,
  }
}
