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

export class Ai {
  private client: Anthropic | null

  constructor(private config: Config) {
    this.client = config.anthropicApiKey ? new Anthropic({ apiKey: config.anthropicApiKey }) : null
  }

  get enabled() {
    return this.client !== null
  }

  private async ask(content: Anthropic.Beta.BetaContentBlockParam[], maxTokens = 16000): Promise<string> {
    if (!this.client) throw new AiUnavailableError()
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

  private image(data: Buffer, mime: ImageMime): Anthropic.Beta.BetaImageBlockParam {
    return { type: 'image', source: { type: 'base64', media_type: mime, data: data.toString('base64') } }
  }

  /** Handwriting → Markdown. */
  async transcribeHandwriting(png: Buffer): Promise<string> {
    return this.ask([this.image(png, 'image/png'), { type: 'text', text: HANDWRITING_PROMPT }])
  }

  /** Image → searchable text (OCR + short description). */
  async imageText(data: Buffer, mime: string): Promise<string> {
    if (!isAiImage(mime)) throw new Error(`unsupported image type ${mime}`)
    return this.ask([this.image(data, mime as ImageMime), { type: 'text', text: IMAGE_TEXT_PROMPT }], 4000)
  }

  /** PDF → text for search. */
  async pdfText(data: Buffer): Promise<string> {
    return this.ask(
      [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: data.toString('base64') } },
        {
          type: 'text',
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
    const content: Anthropic.Beta.BetaContentBlockParam[] = []
    for (const p of parts) {
      if ('text' in p) {
        if (p.text.trim()) content.push({ type: 'text', text: p.text })
      } else {
        content.push(this.image(p.png, 'image/png'))
      }
    }
    content.push({ type: 'text', text: COMPILE_PROMPT })
    return this.ask(content, 32000)
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
