import Anthropic from '@anthropic-ai/sdk'
import { Resvg } from '@resvg/resvg-js'
import { DRAWING_WIDTH, drawingToSvg, unionBounds, type Stroke } from '@reconnotes/core'
import type { Config } from './config'

type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
const IMAGE_MIMES = new Set<string>(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export const isAiImage = (mime: string) => IMAGE_MIMES.has(mime)

export class AiUnavailableError extends Error {
  constructor() {
    super('AI features are disabled: set ANTHROPIC_API_KEY on the server')
  }
}

/**
 * Render a drawing to PNG, cropped to the ink. Returns null for an empty drawing.
 */
export function renderDrawingPng(strokes: Stroke[]): Buffer | null {
  const b = unionBounds(strokes)
  if (!b) return null
  const pad = 20
  const x = Math.max(0, b.x - pad)
  const y = Math.max(0, b.y - pad)
  const w = Math.min(DRAWING_WIDTH, b.x + b.w + pad) - x
  const h = b.y + b.h + pad - y
  const shifted = strokes.map((s) => ({
    ...s,
    pts: s.pts.map((v, i) => (i % 3 === 0 ? v - x : i % 3 === 1 ? v - y : v)),
  }))
  // Scale so the longest side is ~1500px: plenty for recognition, small upload.
  const scale = Math.min(3, 1500 / Math.max(w, h))
  const svg = drawingToSvg(shifted, w, h, scale)
  return new Resvg(svg, { background: '#ffffff' }).render().asPng()
}

const HANDWRITING_PROMPT = `Transcribe the handwriting in this image.

- Preserve the writer's words exactly; fix only obvious letter-recognition ambiguity.
- Use Markdown for structure the writer clearly intended: headings for underlined or boxed titles, "- " for bullets, "- [ ]" / "- [x]" for checkboxes, numbered lists, and tables.
- Describe non-text content (diagrams, arrows, sketches, charts) briefly in square brackets, e.g. [diagram: flow from A to B].
- If a word is illegible write [illegible].
- Output only the transcription, with no preamble.`

const IMAGE_TEXT_PROMPT = `This image was attached to a personal note. Produce text that will make it findable by search:

1. Transcribe all legible text in the image (signs, screenshots, documents, whiteboards, handwriting, chart labels and values).
2. Then add one line starting with "Description:" summarising what the image shows (objects, people, place, chart type and what it measures).

Output only that text, with no preamble.`

const COMPILE_PROMPT = `You will receive a personal note made of typed text and images of handwritten sections (in reading order). Compile it into one clean, well-structured Markdown document.

- Keep all information: every fact, number, name, task and idea from both the typed and handwritten parts.
- Transcribe handwriting faithfully and merge it into the right place in the flow.
- Organise with headings, bullet lists, checklists ("- [ ]" / "- [x]") and tables where it helps; fix spelling and obvious grammar slips.
- Describe diagrams or sketches briefly in square brackets.
- Do not add facts, commentary or a preamble. Output only the Markdown document.`

type Part = { text: string } | { image: Buffer; mime: ImageMime } | { pdf: Buffer }

/** A model that can answer a single multimodal prompt. */
interface Backend {
  generate(parts: Part[], maxTokens: number): Promise<string>
}

class AnthropicBackend implements Backend {
  private client: Anthropic

  constructor(private config: Config) {
    this.client = new Anthropic({ apiKey: config.anthropicApiKey! })
  }

  async generate(parts: Part[], maxTokens: number): Promise<string> {
    const content: Anthropic.Beta.BetaContentBlockParam[] = parts.map((p) => {
      if ('text' in p) return { type: 'text', text: p.text }
      if ('image' in p)
        return { type: 'image', source: { type: 'base64', media_type: p.mime, data: p.image.toString('base64') } }
      return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: p.pdf.toString('base64') } }
    })
    const stream = this.client.beta.messages.stream({
      model: this.config.aiModel,
      max_tokens: maxTokens,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: this.config.aiEffort },
      messages: [{ role: 'user', content }],
    })
    const msg = await stream.finalMessage()
    if (msg.stop_reason === 'refusal') throw new Error('The AI declined to process this content')
    return msg.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
  }
}

/**
 * A local model served by Ollama (https://ollama.com), e.g. an OCR model such
 * as HSR-DeepThink/strike-ocr for handwriting, and/or a general model for
 * compiling documents. Uses Ollama's /api/chat endpoint.
 */
class OllamaBackend implements Backend {
  constructor(
    private url: string,
    private model: string,
    private timeoutMs: number,
  ) {}

  async generate(parts: Part[], maxTokens: number): Promise<string> {
    const text = parts
      .filter((p): p is { text: string } => 'text' in p)
      .map((p) => p.text)
      .join('\n\n')
    const images = parts
      .filter((p): p is { image: Buffer; mime: ImageMime } => 'image' in p)
      .map((p) => p.image.toString('base64'))
    if (parts.some((p) => 'pdf' in p)) throw new Error('PDF input is not supported by the Ollama backend')
    const res = await fetch(this.url.replace(/\/$/, '') + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.model,
        stream: false,
        options: { num_predict: maxTokens, temperature: 0 },
        messages: [{ role: 'user', content: text, ...(images.length ? { images } : {}) }],
      }),
    })
    if (!res.ok) throw new Error(`Ollama request failed: ${res.status} ${await res.text()}`)
    const body = (await res.json()) as { message?: { content?: string } }
    return stripThinking(body.message?.content ?? '')
  }
}

/** Reasoning models served by Ollama may include <think>…</think> blocks. */
export function stripThinking(s: string): string {
  return s
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^[\s\S]*<\/think>/i, '')
    .trim()
}

export class Ai {
  private handwritingBackend: Backend | null
  private imageBackend: Backend | null
  private compileBackend: Backend | null
  /** Ollama can't read PDFs, so PDFs only get text with Claude. */
  readonly canPdf: boolean

  constructor(private config: Config) {
    const make = (provider: Config['handwritingProvider'], ollamaModel: string): Backend | null => {
      if (provider === 'anthropic' && config.anthropicApiKey) return new AnthropicBackend(config)
      if (provider === 'ollama' && config.ollamaUrl) return new OllamaBackend(config.ollamaUrl, ollamaModel, config.ollamaTimeoutMs)
      return null
    }
    this.handwritingBackend = make(config.handwritingProvider, config.ollamaModel)
    this.imageBackend = make(config.imageProvider, config.ollamaModel)
    this.compileBackend = make(config.compileProvider, config.ollamaTextModel)
    this.canPdf = config.imageProvider === 'anthropic' && Boolean(config.anthropicApiKey)
  }

  get canHandwriting() {
    return this.handwritingBackend !== null
  }
  get canImages() {
    return this.imageBackend !== null
  }
  get canCompile() {
    return this.compileBackend !== null
  }
  get enabled() {
    return this.canHandwriting || this.canImages || this.canCompile
  }

  describe(): string {
    const name = (p: string, b: Backend | null, model: string) =>
      b ? (p === 'ollama' ? `ollama:${model}` : this.config.aiModel) : 'off'
    const c = this.config
    return `handwriting=${name(c.handwritingProvider, this.handwritingBackend, c.ollamaModel)} images=${name(c.imageProvider, this.imageBackend, c.ollamaModel)} compile=${name(c.compileProvider, this.compileBackend, c.ollamaTextModel)}`
  }

  private need(b: Backend | null): Backend {
    if (!b) throw new AiUnavailableError()
    return b
  }

  /** Handwriting → Markdown. */
  async transcribeHandwriting(png: Buffer): Promise<string> {
    const prompt =
      this.config.handwritingProvider === 'ollama' && this.config.ollamaHandwritingPrompt
        ? this.config.ollamaHandwritingPrompt
        : HANDWRITING_PROMPT
    return this.need(this.handwritingBackend).generate([{ image: png, mime: 'image/png' }, { text: prompt }], 16000)
  }

  /** Image → searchable text (OCR + short description). */
  async imageText(data: Buffer, mime: string): Promise<string> {
    if (!isAiImage(mime)) throw new Error(`unsupported image type ${mime}`)
    return this.need(this.imageBackend).generate(
      [{ image: data, mime: mime as ImageMime }, { text: IMAGE_TEXT_PROMPT }],
      4000,
    )
  }

  /** PDF → text for search. */
  async pdfText(data: Buffer): Promise<string> {
    if (!this.canPdf) throw new AiUnavailableError()
    return this.need(this.imageBackend).generate(
      [
        { pdf: data },
        {
          text: 'Extract the full text of this document for a search index, including text in tables, charts and figures. Output only the text.',
        },
      ],
      32000,
    )
  }

  /**
   * Compile a note into a clean document. `parts` is the note in reading
   * order: typed Markdown and rendered handwriting images interleaved.
   */
  async compile(parts: ({ text: string } | { png: Buffer })[]): Promise<string> {
    const backend = this.need(this.compileBackend)
    const input: Part[] = []
    if (this.config.compileProvider === 'anthropic') {
      // Claude reads the handwriting images directly, in place.
      for (const p of parts) {
        if ('text' in p) {
          if (p.text.trim()) input.push({ text: p.text })
        } else input.push({ image: p.png, mime: 'image/png' })
      }
    } else {
      // Local models: transcribe each drawing with the handwriting model
      // first, then hand the compile model plain text in reading order.
      let text = ''
      for (const p of parts) {
        if ('text' in p) text += p.text
        else text += '\n[handwritten section]\n' + (await this.transcribeHandwriting(p.png)) + '\n[end handwritten section]\n'
      }
      input.push({ text })
    }
    input.push({ text: COMPILE_PROMPT })
    return backend.generate(input, 32000)
  }
}

/**
 * Speech-to-text through any OpenAI-compatible transcription endpoint, such
 * as a self-hosted whisper.cpp / faster-whisper server on the same machine.
 */
export async function transcribeAudio(config: Config, data: Buffer, mime: string, filename: string): Promise<string> {
  if (!config.transcribeUrl) throw new Error('audio transcription disabled: set RECON_TRANSCRIBE_URL')
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(data)], { type: mime }), filename || 'audio')
  form.append('model', config.transcribeModel)
  form.append('response_format', 'text')
  const url = config.transcribeUrl.replace(/\/$/, '') + '/v1/audio/transcriptions'
  const res = await fetch(url, {
    method: 'POST',
    body: form,
    headers: config.transcribeApiKey ? { Authorization: `Bearer ${config.transcribeApiKey}` } : {},
  })
  if (!res.ok) throw new Error(`transcription failed: ${res.status} ${await res.text()}`)
  const body = await res.text()
  try {
    const json = JSON.parse(body) as { text?: string }
    return (json.text ?? '').trim()
  } catch {
    return body.trim()
  }
}
