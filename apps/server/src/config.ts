import path from 'node:path'

/**
 * Server configuration, read from environment variables (see .env.example).
 */
export type AiProvider = 'anthropic' | 'ollama' | 'none'

export interface Config {
  port: number
  /** HTTPS port, served when there's a certificate (see tls.ts) */
  httpsPort: number
  /** your own certificate and key (PEM files); otherwise <data>/tls/server.crt from `https-setup` */
  tlsCert: string | null
  tlsKey: string | null
  host: string
  dataDir: string
  /** shared secret every device must present */
  token: string
  /** directory containing the built web app, served at / (optional) */
  webDir: string | null
  anthropicApiKey: string | null
  /** which AI backend handles each task */
  handwritingProvider: AiProvider
  imageProvider: AiProvider
  compileProvider: AiProvider
  ollamaUrl: string | null
  /** vision/OCR model used for handwriting and images */
  ollamaModel: string
  /** text model used to compile documents (defaults to ollamaModel) */
  ollamaTextModel: string
  /** replace the built-in handwriting prompt for Ollama OCR models */
  ollamaHandwritingPrompt: string | null
  ollamaTimeoutMs: number
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
  const ollamaUrl = env.RECON_OLLAMA_URL || null
  const fallbackProvider: AiProvider = anthropicApiKey ? 'anthropic' : ollamaUrl ? 'ollama' : 'none'
  const provider = (v: string | undefined): AiProvider =>
    v === 'anthropic' || v === 'ollama' || v === 'none' ? v : ((env.RECON_AI_PROVIDER as AiProvider) ?? fallbackProvider)
  const ollamaModel = env.RECON_OLLAMA_MODEL ?? 'HSR-DeepThink/strike-ocr:latest'
  const handwritingProvider = provider(env.RECON_HANDWRITING_PROVIDER)
  const imageProvider = provider(env.RECON_IMAGE_PROVIDER)
  const aiOn = (p: AiProvider) => (p === 'anthropic' && Boolean(anthropicApiKey)) || (p === 'ollama' && Boolean(ollamaUrl))
  return {
    port: Number(env.RECON_PORT ?? env.PORT ?? 8787),
    httpsPort: Number(env.RECON_HTTPS_PORT ?? 8443),
    tlsCert: env.RECON_TLS_CERT ? path.resolve(env.RECON_TLS_CERT) : null,
    tlsKey: env.RECON_TLS_KEY ? path.resolve(env.RECON_TLS_KEY) : null,
    host: env.RECON_HOST ?? '0.0.0.0',
    dataDir,
    token,
    webDir: env.RECON_WEB_DIR ? path.resolve(env.RECON_WEB_DIR) : null,
    anthropicApiKey,
    handwritingProvider,
    imageProvider,
    compileProvider: provider(env.RECON_COMPILE_PROVIDER),
    ollamaUrl,
    ollamaModel,
    ollamaTextModel: env.RECON_OLLAMA_TEXT_MODEL ?? ollamaModel,
    ollamaHandwritingPrompt: env.RECON_OLLAMA_HANDWRITING_PROMPT || null,
    ollamaTimeoutMs: Number(env.RECON_OLLAMA_TIMEOUT_MS ?? 300_000),
    aiModel: env.RECON_AI_MODEL ?? 'claude-opus-5-5',
    aiEffort: (env.RECON_AI_EFFORT as Config['aiEffort']) ?? 'medium',
    autoHandwriting: bool(env.RECON_AUTO_HANDWRITING, aiOn(handwritingProvider)),
    handwritingDebounceMs: Number(env.RECON_HANDWRITING_DEBOUNCE_MS ?? 90_000),
    autoImageText: bool(env.RECON_AUTO_IMAGE_TEXT, aiOn(imageProvider)),
    transcribeUrl: env.RECON_TRANSCRIBE_URL || null,
    transcribeModel: env.RECON_TRANSCRIBE_MODEL ?? 'whisper-1',
    transcribeApiKey: env.RECON_TRANSCRIBE_API_KEY || null,
    backupDir: path.resolve(env.RECON_BACKUP_DIR ?? path.join(dataDir, 'backups')),
    backupIntervalHours: Number(env.RECON_BACKUP_INTERVAL_HOURS ?? 24),
    backupKeep: Number(env.RECON_BACKUP_KEEP ?? 14),
    maxUploadBytes: Number(env.RECON_MAX_UPLOAD_MB ?? 200) * 1024 * 1024,
  }
}
