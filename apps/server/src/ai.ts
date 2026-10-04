import { Resvg } from '@resvg/resvg-js'
import { DRAWING_WIDTH, drawingToSvg, unionBounds, type Stroke } from '@reconnotes/core'
import type { Config } from './config'
import type { AgentRegistry, Part } from './agents'
export { stripThinking } from './agents'

const IMAGE_MIMES = new Set<string>(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export const isAiImage = (mime: string) => IMAGE_MIMES.has(mime)


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

/**
 * The AI features, each run through the configured agents for that task with
 * failover (see agents.ts).
 */
export class Ai {
  constructor(
    readonly agents: AgentRegistry,
    private config: Config,
  ) {}

  get canHandwriting() {
    return this.agents.available('handwriting')
  }
  get canImages() {
    return this.agents.available('images')
  }
  get canPdf() {
    return this.agents.available('pdf')
  }
  get canCompile() {
    return this.agents.available('compile')
  }
  get enabled() {
    return this.canHandwriting || this.canImages || this.canPdf || this.canCompile
  }
  get autoHandwriting() {
    return this.agents.settings().autoHandwriting && this.canHandwriting
  }
  get autoImageText() {
    return this.agents.settings().autoImageText
  }

  describe(): string {
    return this.agents.describe()
  }

  /** Handwriting → Markdown. */
  async transcribeHandwriting(png: Buffer): Promise<string> {
    const { result } = await this.agents.run('handwriting', (backend, agent) =>
      backend.generate([{ image: png, mime: 'image/png' }, { text: agent.prompt.trim() || HANDWRITING_PROMPT }], 16000),
    )
    return result
  }

  /** Image → searchable text (OCR + short description). */
  async imageText(data: Buffer, mime: string): Promise<string> {
    if (!isAiImage(mime)) throw new Error(`unsupported image type ${mime}`)
    const { result } = await this.agents.run('images', (backend) =>
      backend.generate([{ image: data, mime }, { text: IMAGE_TEXT_PROMPT }], 4000),
    )
    return result
  }

  /** PDF → text for search. */
  async pdfText(data: Buffer): Promise<string> {
    const { result } = await this.agents.run('pdf', (backend) =>
      backend.generate(
        [
          { pdf: data },
          {
            text: 'Extract the full text of this document for a search index, including text in tables, charts and figures. Output only the text.',
          },
        ],
        32000,
      ),
    )
    return result
  }

  /**
   * Compile a note into a clean document. `parts` is the note in reading
   * order: typed Markdown and rendered handwriting images interleaved.
   */
  async compile(parts: ({ text: string } | { png: Buffer })[]): Promise<string> {
    // For agents that can't read images, transcribe the drawings first (once,
    // even if we fail over between several such agents).
    let transcribed: Promise<string> | null = null
    const asText = () =>
      (transcribed ??= (async () => {
        let text = ''
        for (const p of parts) {
          if ('text' in p) text += p.text
          else text += '\n[handwritten section]\n' + (await this.transcribeHandwriting(p.png)) + '\n[end handwritten section]\n'
        }
        return text
      })())

    const { result } = await this.agents.run('compile', async (backend, agent) => {
      const input: Part[] = []
      if (agent.vision) {
        for (const p of parts) {
          if ('text' in p) {
            if (p.text.trim()) input.push({ text: p.text })
          } else input.push({ image: p.png, mime: 'image/png' })
        }
      } else input.push({ text: await asText() })
      input.push({ text: COMPILE_PROMPT })
      return backend.generate(input, 32000)
    })
    return result
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
