import { Resvg } from '@resvg/resvg-js'
import { promptText, standing } from './prompts'
import { cosine, cutAt, isMeant, likeness, pointText, stretches, topicCuts, type Embed, type Stretch } from './meetingMeaning'
import { stem, telling } from './listen'
import { extraInstructions, isRedo, jobSignal, withExtra } from './jobs'
import type { Store } from './store'
import { fixHeard, Vocabulary } from './vocabulary'
import { reportProgress } from './jobs'
import { DRAWING_WIDTH, drawingToSvg, extractTags, linesToMarkdown, segmentLines, unionBounds, type Stroke } from '@reconnotes/core'
import type { Config } from './config'
import { EmptyReplyError, NoTextError, describeError, freeOllamaGpu, readingMode, rememberSpeechNeedsRoom, speechNeedsRoom, speechUsed, streaming, tracing, type AgentConfig, type AgentRegistry, type AiTask, type Backend, type Part } from './agents'
import { log } from './log'
import { fitForAi, pictureLines, type PictureLine } from './images'
import { cleanOcrLine, cleanOcrText, cleanTranscript, collapseRepeats, unwrapModelOutput } from './text'
import { createHash } from 'node:crypto'
import { coverTopics, groundMeetingNotes, keepAgreedDecisions, normalizeMeetingNotes, partOutcomes, partTopics, topicBullet, type PartOutcome } from './meetingNotes'
export { stripThinking } from './agents'

const IMAGE_MIMES = new Set<string>(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export const isAiImage = (mime: string) => IMAGE_MIMES.has(mime)


/**
 * Render a drawing to PNG, cropped to the ink. Returns null for an empty drawing.
 */
export function renderDrawingPng(allStrokes: Stroke[]): Buffer | null {
  const strokes = allStrokes.filter((s) => s.tool !== 'highlighter')
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
  const svg = drawingToSvg(shifted, w, h, scale, { recognition: true })
  return new Resvg(svg, { background: '#ffffff' }).render().asPng()
}

const HANDWRITING_PROMPT = `Transcribe the handwriting in this image.

- Preserve the writer's words exactly; fix only obvious letter-recognition ambiguity.
- Use Markdown for structure the writer clearly intended: headings for underlined or boxed titles, "- " for bullets, "- [ ]" / "- [x]" for checkboxes, numbered lists, and tables.
- If a word is illegible write [illegible].
- If there is no writing at all (only a sketch, shapes or scribbles), output exactly: NO TEXT
- Output ONLY the transcribed text. Do not describe the image, the handwriting style or the layout, do not explain, do not use LaTeX or $ signs, do not make up text that isn't there, and do not repeat yourself.`

/** The word HELLO in simple handwritten strokes, for testing an agent. */
export function sampleHandwritingPng(): Buffer {
  const line = (pts: [number, number][]): number[] => {
    const out: number[] = []
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i]
      const [x1, y1] = pts[i + 1]
      const n = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 6))
      for (let k = i ? 1 : 0; k <= n; k++) out.push(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n, 0.5)
    }
    return out
  }
  const ring: [number, number][] = []
  for (let a = 0; a <= 360; a += 10) ring.push([560 + 45 * Math.cos((a * Math.PI) / 180), 100 + 60 * Math.sin((a * Math.PI) / 180)])
  const paths: [number, number][][] = [
    [[40, 40], [42, 160]], [[120, 38], [118, 160]], [[42, 100], [118, 98]],
    [[170, 40], [170, 160]], [[170, 40], [240, 42]], [[170, 100], [228, 100]], [[170, 160], [242, 158]],
    [[290, 38], [292, 160], [356, 158]],
    [[400, 40], [400, 160], [466, 160]],
    ring,
  ]
  return renderDrawingPng(paths.map((p, i) => ({ id: `s${i}`, tool: 'pen' as const, color: '#000000', size: 4, pts: line(p) })))!
}

/** A minimal fallback instruction for OCR models that ignore long prompts. */
const SHORT_HANDWRITING_PROMPT = 'Transcribe the handwritten text in this image. Output only the text.'

/**
 * Dedicated OCR models are trained on a fixed task prompt and can ramble or
 * loop with a long instruction. Used when the agent has no custom prompt.
 */
function knownOcrPrompt(model: string): string | null {
  const m = model.toLowerCase()
  if (m.includes('glm-ocr')) return 'Text Recognition:'
  if (m.includes('deepseek-ocr')) return 'Free OCR.'
  return null
}

/** For photos and screenshots, which may mix handwriting with printed text. */
const PHOTO_PROMPT = `Transcribe all the text in this image – handwritten and printed – such as a photo of a notebook page, a whiteboard, a sticky note or a screenshot.

- Preserve the words exactly; fix only obvious letter-recognition ambiguity.
- Use Markdown for structure that is clearly intended: headings for titles, "- " for bullets, "- [ ]" / "- [x]" for checkboxes, numbered lists, and tables.
- Ignore the background (paper texture, lines, shadows, the desk) and anything cut off at the edges.
- If a word is illegible write [illegible].
- If the image has no text at all (a photo of a place, a person or an object), output exactly: NO TEXT
- Output ONLY the transcribed text. Do not describe the image, do not explain, do not make up text that isn't there, and do not use LaTeX or $ signs.`

const SHORT_PHOTO_PROMPT = 'Transcribe all the text in this image. Output only the text.'

/** One line of a drawing, for line-by-line recognition. */
const LINE_PROMPT = 'Transcribe the handwritten text in this image. It is a single line of handwriting: output only that line as plain text – no description of the image, no explanation, no LaTeX, no quotes.'

/** One-tap note actions (⋯ menu). */
const NOTE_ACTION_PROMPTS = {
  summary: `Summarise the note below in 2 to 8 short bullet points: the key points, decisions and outcomes. Lines starting with ✍️ are handwriting, 📷 text from pictures and 🎙️ recordings – use them too.

- Keep the note's titles: if it (or a part of it) has a title such as "Leadership Meeting", put that title on its own line in bold (**Leadership Meeting**) above the bullets that belong to it.
- Stay close to the note's own words: don't reinterpret, generalise or add anything that isn't written there.
- Write in the same language as the note.
- Output only the Markdown (titles and "- …" bullets), with no preamble or closing remark.

Note:
`,
  todos: `List every action item in the note below – tasks, things someone has to do, follow-ups, deadlines. Lines starting with ✍️ are handwriting, 📷 text from pictures and 🎙️ recordings – use them too.

- One Markdown checkbox per item: "- [ ] …". Keep names and dates that are mentioned. Leave out items already marked done ([x]).
- Write in the same language as the note.
- If there are no action items, output exactly: NONE
- Output only the checklist, with no heading, preamble or closing remark.

Note:
`,
  clean: `Improve the wording of the text below: fix spelling, grammar and punctuation and make awkward sentences clear and concise.

- Keep the meaning, every fact, name and number, and the writer's voice; don't add anything.
- Keep the structure exactly: headings, lists, checkboxes ("- [ ]" / "- [x]"), line breaks between items.
- Write in the same language as the text.
- Output only the improved Markdown.

Text:
`,
} as const
export type NoteAction = keyof typeof NOTE_ACTION_PROMPTS
/** your standing instructions for a note action (Settings › Prompts) */
const standingFor = (action: NoteAction) => standing(action === 'summary' ? 'summarise' : action === 'todos' ? 'todos' : 'clean')

/** Second pass: tidy OCR output into well-structured Markdown. */
const FORMAT_PROMPT = `Below is text that an OCR model recognised from handwritten notes{IMAGE}. Clean it up:

- Fix obvious recognition mistakes (misread letters, words split or run together) using {SOURCE} and the context – but keep the writer's own words; don't reword, summarise or add anything.
- Join fragments that belong on one line; keep genuinely separate lines and items separate. Handwriting often wraps: a line that just continues the sentence above it (often a little indented) belongs to that line or item – it is not a new bullet or sub-item.
- Rebuild the structure from the meaning: a title/heading if the first line is one, bullet lists, "- [ ]" / "- [x]" checkboxes, numbered lists, tables. The OCR's line breaks and indents are often wrong where handwriting wraps: text that continues a sentence belongs to that item, not a new or nested one. Only nest an item when it is clearly a sub-point. Drop stray marks the OCR read as text (a lone "-", "—", "*" or quote mark).
- Output only the cleaned-up Markdown: no comments about the text or image, no LaTeX.

Recognised text:
`

const RECIPE_PAGE_PROMPT = `This is a photo of a page of a recipe (a meal-kit recipe card, a cookbook page or a printout). Write out all of its text, exactly as printed, in reading order.

- Keep every word, number, fraction and unit exactly as printed ("1 ½ tbsp", "10 oz", "2 | 4"). Don't round, convert or correct anything.
- Ingredient amounts in columns for different numbers of people (e.g. a "2 people" and a "4 people" column): write each ingredient on its own line as "amount for the first | amount for the second | ingredient", and write the column headings first.
- Ingredients shown as a grid of pictures, each with its amount and its name printed under it: write one line per ingredient, its own amount with its own name ("1 | 1 | Yellow Onion", "¼ oz | ¼ oz | Parsley") – going across each row of the grid. Never a row of amounts and then a row of names.
- Keep numbered steps numbered, with their titles.
- Leave out nothing that's text; don't describe the pictures. Write only the text.`

/** A photographed page of print (a book, a letter, a manual, a trail guide): its text as printed. */
const PRINTED_PAGE_PROMPT = `This is a photo of a printed page (a page of a book, a magazine, a letter, a manual, a guide). Write out all of its text, exactly as printed, in reading order.

- Keep every word and number exactly as printed. Don't correct, reword, summarise or leave anything out.
- Two columns: the whole first column, then the second.
- Keep headings, lists and numbered steps as they are on the page.
- Don't describe the pictures, maps or photos; write only the text (a caption under a picture is text).`

const IMAGE_TEXT_PROMPT = `This image was attached to a personal note. Produce text that will make it findable by search:

1. Transcribe all legible text in the image (signs, screenshots, documents, whiteboards, handwriting, chart labels and values).
2. Then add one line starting with "Description:" summarising what the image shows (objects, people, place, chart type and what it measures).

Output only that text, with no preamble.`

const COMPILE_RULES = `- Use ONLY what is in the note. Never add meetings, tasks, to-dos, dates, names, numbers or ideas that are not in it – if the note is short, the document is short.
- Keep all of its information: every fact, number, name, task and idea.
- Organise it with headings, bullet lists, checklists ("- [ ]" / "- [x]") and tables only where the note's own content fits them; only things written as tasks in the note become checklist items. Fix spelling and obvious grammar slips.
- Lines like ⟦DRAWING:…⟧ and ⟦IMAGE:…⟧ are the original handwritten sections and pictures, and ⟦AUDIO:…⟧ / ⟦FILE:…⟧ are recordings and files. Copy each of these lines exactly, on its own line, where it belongs (a drawing or picture just before the text that came from it). Don't write links or image tags for them yourself.
- Keep every #tag (such as #work), every link to another note (such as [[Shopping list]]) and every due date (such as !2026-10-14) exactly as written, next to the text they belong to.
- Do not add commentary, a preamble or a closing remark. Output only the Markdown document.`

/** Cloud models with vision see the drawings and pictures themselves. */
const COMPILE_PROMPT = `You will receive a personal note made of typed text, images of handwritten sections and attached pictures such as photos of paper notes or screenshots (in reading order). Compile it into one clean, well-structured Markdown document. Transcribe handwriting and text in pictures faithfully and merge it into the right place in the flow; describe a sketch in a few words in square brackets.

${COMPILE_RULES}`

/** Other models get the note as text, with the handwriting and pictures already read. */
const COMPILE_TEXT_PROMPT = `Below, between the lines "=== NOTE ===" and "=== END OF NOTE ===", is a personal note. Its handwritten sections and pictures were read by OCR: the text under a ⟦DRAWING:…⟧ line came from that handwriting, the text under an ⟦IMAGE:…⟧ line from that picture. Rewrite the note as one clean, well-structured Markdown document.

${COMPILE_RULES}`

/**
 * The AI features, each run through the configured agents for that task with
 * failover (see agents.ts).
 */
export class Ai {
  constructor(
    readonly agents: AgentRegistry,
    private config: Config,
    /** for the saved readings (so unchanged handwriting and pictures aren't read twice) */
    private store?: Store,
  ) {
    store?.db.exec('CREATE TABLE IF NOT EXISTS ai_readings (key TEXT PRIMARY KEY, text TEXT NOT NULL, created_at INTEGER NOT NULL)')
    this.vocabulary = store ? new Vocabulary(store) : null
  }

  /** your names and terms, given to every reading and clean-up */
  readonly vocabulary: Vocabulary | null

  /** The prompt with your words added (when you have any). */
  private withVocab(prompt: string): string {
    const v = this.vocabulary?.hint()
    return v ? `${prompt}\n\n${v}` : prompt
  }

  /** A saved reading of exactly this image by exactly this model and prompt. */
  private savedReading(key: string): string | null {
    const r = this.store?.db.prepare('SELECT text FROM ai_readings WHERE key = ?').get(key) as { text: string } | undefined
    return r ? r.text : null
  }
  private saveReading(key: string, text: string) {
    if (!this.store) return
    this.store.db.prepare('INSERT OR REPLACE INTO ai_readings (key, text, created_at) VALUES (?, ?, ?)').run(key, text, Date.now())
    // keep the newest 20,000
    if (Math.random() < 0.02) this.store.db.exec('DELETE FROM ai_readings WHERE key NOT IN (SELECT key FROM ai_readings ORDER BY created_at DESC LIMIT 20000)')
  }

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
  get canAudio() {
    return this.agents.available('audio')
  }
  get autoAudio() {
    return this.agents.settings().autoAudio && this.canAudio
  }
  get enabled() {
    return this.canHandwriting || this.canImages || this.canPdf || this.canCompile || this.canAudio
  }

  /**
   * Summarise / extract to-dos from a note, or clean up the wording of some
   * text. Uses the "Compile notes" agents (general models); clean-up prefers
   * the "Clean up converted text" agents when there are any.
   */
  async noteAction(action: NoteAction, markdown: string): Promise<{ text: string; agent: string }> {
    const task = action === 'clean' && this.agents.available('format') ? 'format' : 'compile'
    const limit = action === 'clean' ? Math.min(8192, Math.ceil(markdown.length / 2) + 512) : 1500
    const { result, agent } = await this.agents.run(task, async (backend) => {
      const raw = await backend.generate([{ text: withExtra(NOTE_ACTION_PROMPTS[action] + standingFor(action), 'start') + markdown.slice(0, 60_000) }], limit)
      return collapseRepeats(unwrapModelOutput(raw)).trim()
    })
    log.info(`note action "${action}" via "${agent.name}" (${markdown.length} → ${result.length} chars)`)
    return { text: /^NONE\.?$/i.test(result) ? '' : result, agent: agent.name }
  }

  /**
   * Meeting notes from a recording's transcript and what was written during
   * the meeting: a summary, decisions, and the action items as a checklist.
   */
  async meetingNotes(
    notes: string,
    transcript: string,
    today: string,
    /** `fresh`: read every part again, not the notes on it from before (asked for a fresh start) */
    who: { attendees?: string[]; people?: number; voices?: number; named?: string[]; fresh?: boolean } = {},
  ): Promise<{ text: string; agent: string; draft?: { parts: string[]; raw: string; how: string[]; dropped: string[] } }> {
    // a line per speaker's turn ("Jesse: …") when the voices were told apart: kept as lines
    const said = transcript.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim()
    // how long it was, from how much was said (people speak ~140 words a minute)
    const minutes = Math.round(said.split(/\s+/).filter(Boolean).length / 140)
    // the transcript read by meaning (an embedding model, where there is one): parts cut where the
    // talk changes subject, and points worded differently from what was said still recognised
    const meaning = await this.readByMeaning(said)
    // how long a part is (Settings › Prompts: minutes of talk, ~875 characters a minute) and whether to reason first
    const { meetingPartMinutes, meetingThink } = this.agents.settings()
    const partChars = Math.round(meetingPartMinutes * 875) || PART_CHARS
    const parts = meetingPartsByTopic(said, partChars, meaning) ?? meetingParts(said, partChars)
    const layout = `Use exactly this Markdown layout:

## Summary
- ${promptText('meeting.summary')}

## Decisions
- ${promptText('meeting.decisions')}

## Open questions
- ${promptText('meeting.open')}

## Action items
- [ ] ${promptText('meeting.actions')}

If no task was said, write "- [ ] No action items" under that heading.`
    const length =
      minutes >= 5
        ? `The meeting lasted about ${minutes} minutes: cover every topic that came up – a meeting this long usually has ${Math.min(15, Math.max(4, Math.round(minutes / 3)))} or more summary bullets. Don't leave the later parts out.`
        : 'A short recording gets short notes: one summary bullet is fine. If nothing was decided or assigned, say so.'
    // what a small model gets wrong most: taking every idea floated for a decision
    const reasoning = `How to tell what was decided:
${promptText('meeting.reasoning')}${standing('meeting')}`
    const attendees = (who.attendees ?? []).filter(Boolean)
    const speakers =
      (who.voices ?? 0) >= 2
        ? `
- The transcript is a line per turn, starting with who spoke: a name, or "Speaker N" for a voice that hasn't been named (${who.voices} voices). The voices were told apart by the sound of them, which is occasionally wrong. Use the names to say who said, suggested, agreed or took on what; for "Speaker N", say "Speaker N" only where who matters (a task's owner), never guess a name for it.`
        : ''
    const count = who.people ?? 0
    const people =
      (attendees.length ? `\n- The people at the meeting: ${attendees.join(', ')}. Spell their names like that.` : '') +
      (count > attendees.length ? `\n- ${count} people were at the meeting${attendees.length ? ' (not all of them named)' : ''}.` : '')
    const agenda = /^#{1,6}\s*agenda\b/im.test(notes)
      ? `\n- The notes have an agenda: give the Summary its topics in that order (then anything else that came up), and list an agenda item nobody got to under Open questions.`
      : ''
    const rules = `Rules:
- Use ONLY what is in the transcript and the notes. Never invent names, people, projects, dates, numbers or tasks.
- The transcript is from speech recognition: words can be misheard. Write what was clearly meant; leave out what makes no sense, rather than guessing.
- Never write placeholders like [TBD], "unspecified" or "N/A": what wasn't said is left out.${people}${speakers}${agenda}
- ${length}
- Stop after the Action items section.

${reasoning}`
    const { result, agent } = await this.agents.run('compile', async (backend, model) => {
      const partNotesAll: string[] = []
      // how each step was answered (thinking or not, reloads, the CPU): kept with the job
      const how: string[] = []
      const ask = async (step: string, ...args: Parameters<typeof backend.generate>) => {
        const r = await tracing(() => backend.generate(...args))
        how.push(`${step}: ${r.how.join('; ') || 'answered'}`)
        return r.value
      }
      let body: string
      if (parts.length === 1) {
        body = `Write meeting notes from a recording's transcript and the notes taken during it. Today is ${today}.

${rules}

${layout}

<notes>
${notes.slice(0, 8000) || '(none)'}
</notes>

<transcript>
${said || '(no speech recognised)'}
</transcript>`
      } else {
        // a long meeting: each part read on its own (a small model skims a long transcript and
        // writes up only its start), then the parts' notes put together
        const partNotes: string[] = partNotesAll
        for (let i = 0; i < parts.length; i++) {
          reportProgress(`Reading part ${i + 1} of ${parts.length} of the meeting…`)
          const from = Math.round((minutes * i) / parts.length)
          const to = Math.round((minutes * (i + 1)) / parts.length)
          const prompt = withExtra(`This is part ${i + 1} of ${parts.length} of a meeting's transcript (about minutes ${from}–${to}), from speech recognition – words can be misheard.${people}${speakers}

Write notes on this part, topic by topic, in the order they came up:

- Topic: a few words naming it
  - Said: the details (numbers, names, dates, places, reasons)
  - Ideas: suggestions made along the way, in order (who, if said)
  - Outcome: how it was left by the end of this part – "Agreed: …" if people agreed; "Changed: … (instead of …)" if a later idea replaced an earlier one; "Open: …" if it wasn't settled
  - Who: who said or suggested what, where the transcript says (names, or "Speaker N")
  - Tasks: who took on or was given what (and when, only if said) – including what someone said they or "we" will do ("I'll look it up", "let's make space for the dumpster Tuesday", "we'll pull them today"); leave out a task that was taken back

Leave out a line that has nothing (no "Ideas" if there were none). Read the whole part before writing an outcome: what's said later can change it.

${reasoning}

Use ONLY what is in this part; leave out small talk and what makes no sense. Never write placeholders like [TBD].

<transcript part="${i + 1}">
${parts[i]}
</transcript>`)
          // read before – the same words, the same instructions, the same model (a redo of the notes):
          // what it made of it then. Most of a long meeting's time is here, so a redo only puts it together again.
          const key = createHash('sha256').update(`meeting-part|${model.kind}|${model.baseUrl}|${model.model}|${prompt}`).digest('hex')
          const saved = who.fresh ? null : this.savedReading(key)
          let t: string
          if (saved !== null) {
            t = saved
            how.push(`Part ${i + 1}: read before – reused`)
          } else {
            // reasoning first: who suggested what, what replaced it, what was agreed
            const raw = await ask(`Part ${i + 1}`, [{ text: prompt }], 1500, { think: meetingThink })
            t = collapseRepeats(unwrapModelOutput(raw)).trim()
            if (t) this.saveReading(key, t)
          }
          if (t) partNotes.push(`Part ${i + 1} (about minutes ${from}–${to}):\n${t}`)
        }
        reportProgress('Putting the meeting notes together…')
        body = `Write meeting notes from notes on each part of a meeting (made from its recording) and the notes taken during it. Today is ${today}.

${rules}
- Every part's points belong in the notes: merge what's the same, keep the order.
- A topic can carry on into a later part: its last outcome is the one that counts.
- Decisions come only from the parts' "Agreed" and "Changed" outcomes; Open questions from their "Open" ones; Action items from their "Tasks".

${layout}

<notes>
${notes.slice(0, 8000) || '(none)'}
</notes>

<parts>
${partNotes.join('\n\n')}
</parts>`
      }
      // putting a long meeting together takes thinking: room for it, so it isn't cut off and asked
      // again without (a much weaker answer)
      const raw = await ask('Final notes', [{ text: withExtra(body) }], parts.length > 1 ? 3000 : 2000, { think: meetingThink, thinkRoom: parts.length > 1 ? 6144 : undefined })
      const rawOut = raw
      // every topic the parts found is in the Summary, even if putting them together dropped it –
      // then all of it checked against what was said
      const written = coverTopics(normalizeMeetingNotes(collapseRepeats(unwrapModelOutput(raw)).trim()), partTopics(partNotesAll))
      // the model's own writing kept with the job: when the notes come out poorly, it shows why
      const dropped: string[] = []
      const fallback = partTopics(partNotesAll).map(topicBullet)
      // points that say, in other words, what was said: kept, though they share few words with it
      let meant: Set<string> | undefined
      if (meaning) {
        const points = written.split('\n').filter((l) => /^\s*[-*]\s/.test(l) && pointText(l))
        const sims = await likeness(points.map(pointText), meaning.vecs, meaning.embed).catch(() => null)
        if (sims) meant = new Set(points.filter((_, i) => isMeant(sims[i])).map((l) => l.trim()))
        how.unshift(`Read by meaning: ${parts.length > 1 ? `${parts.length} parts, cut where the subject changes; ` : ''}${meant?.size ?? 0} of ${points.length} points match what was said`)
      }
      // decisions only for what the parts say was agreed: matched to their topics by meaning (or words)
      const outcomes = partOutcomes(partNotesAll)
      const decided = outcomes.some((o) => o.outcome) ? keepAgreedDecisions(written, outcomes, await this.topicMatcher(written, outcomes, meaning?.embed), dropped) : written
      const text = groundMeetingNotes(decided, transcript, notes, { fallback, dropped, meant })
      if (dropped.length) log.info(`meeting notes: left out ${dropped.length} line(s) not found in what was said`)
      return { text, draft: { parts: partNotesAll, raw: rawOut.slice(0, 20000), how, dropped } }
    })
    log.info(`meeting notes via "${agent.name}" (${transcript.length} chars of transcript, ${parts.length} part(s) → ${result.text.length})`)
    return { text: result.text, agent: agent.name, draft: result.draft }
  }

  /**
   * Texts → vectors, with the embedding model search by meaning uses (null: there isn't one). nomic
   * models are told which side each text is: what's searched ('document') or what's looked for.
   */
  embedder(): Embed | null {
    if (!this.agents.available('embed')) return null
    return async (texts, as) => {
      const { result } = await this.agents.run('embed', async (backend, agent) => {
        if (!backend.embed) throw new Error(`${agent.name} can't make embeddings`)
        const prefix = /nomic/i.test(agent.model) ? (as === 'query' ? 'search_query: ' : 'search_document: ') : ''
        return backend.embed(texts.map((t) => prefix + t))
      })
      return result
    }
  }

  /** A transcript in stretches, each as a vector – or null (no embedding model, or it failed: words alone then). */
  async readByMeaning(text: string): Promise<{ stretches: Stretch[]; vecs: number[][]; embed: Embed } | null> {
    const embed = this.embedder()
    if (!embed || text.length < 200) return null
    try {
      const parts = stretches(text)
      reportProgress('Reading the meeting by meaning…')
      return { stretches: parts, vecs: await embed(parts.map((p) => p.text), 'document'), embed }
    } catch (e) {
      log.warn(`couldn't read the meeting by meaning (${describeError(e)}) – by its words alone`)
      return null
    }
  }

  /**
   * Which part topic each Decisions point is about: by meaning where there's an embedding model
   * (likeness of 0.5 or more), else by the telling words they share (two or more). -1: none.
   */
  private async topicMatcher(markdown: string, outcomes: PartOutcome[], embed?: Embed): Promise<(line: string) => number> {
    const lines = markdown.split('\n')
    const start = lines.findIndex((l) => /^#{1,6}\s+decisions?\b/i.test(l))
    const end = start < 0 ? -1 : lines.findIndex((l, i) => i > start && /^#{1,6}\s/.test(l))
    const points = start < 0 ? [] : lines.slice(start + 1, end < 0 ? lines.length : end).filter((l) => /^\s*[-*]\s/.test(l))
    const docs = outcomes.map((o) => `${o.topic}: ${o.text}`.slice(0, 1500))
    if (embed && points.length) {
      try {
        const [pv, dv] = await Promise.all([embed(points.map(pointText), 'query'), embed(docs, 'document')])
        const best = new Map<string, number>()
        points.forEach((p, i) => {
          let at = -1
          let top = 0.5
          dv.forEach((d, k) => {
            const c = cosine(pv[i], d)
            if (c > top) (top = c), (at = k)
          })
          best.set(p, at)
        })
        return (line) => best.get(line) ?? -1
      } catch {
        /* by words */
      }
    }
    const words = (t: string) => new Set(t.split(/\s+/).map(stem).filter(telling))
    const topics = docs.map(words)
    return (line) => {
      const w = words(pointText(line))
      let at = -1
      let top = 1
      topics.forEach((t, k) => {
        const shared = [...w].filter((x) => t.has(x)).length
        if (shared > top) (top = shared), (at = k)
      })
      return at
    }
  }

  /** "Ask your notes": a question with the relevant notes, answered by the "Compile notes" agents. */
  async ask(prompt: string, onText?: (soFar: string) => void): Promise<{ text: string; agent: string }> {
    // its own agents ("Ask your notes"), else the ones that compile notes
    const { result, agent } = await this.agents.run(this.agents.available('ask') ? 'ask' : 'compile', async (backend) => {
      const gen = () => backend.generate([{ text: withExtra(prompt + standing('ask')) }], 1000)
      const raw = await (onText ? streaming(onText, gen) : gen())
      return collapseRepeats(unwrapModelOutput(raw)).trim()
    })
    log.info(`answered a question via "${agent.name}" (${prompt.length} chars of notes → ${result.length})`)
    return { text: result, agent: agent.name }
  }

  /**
   * A request that isn't about the notes ("make me a chili recipe"): the AI's own answer, with the
   * "Ask your notes" agents – room for a longer one (a whole recipe).
   */
  async chat(prompt: string, onText?: (soFar: string) => void): Promise<{ text: string; agent: string }> {
    const { result, agent } = await this.agents.run(this.agents.available('ask') ? 'ask' : 'compile', async (backend) => {
      const gen = () => backend.generate([{ text: withExtra(prompt) }], 3000)
      const raw = await (onText ? streaming(onText, gen) : gen())
      return collapseRepeats(unwrapModelOutput(raw)).trim()
    })
    log.info(`answered a general request via "${agent.name}" (${result.length} chars)`)
    return { text: result, agent: agent.name }
  }

  /** Recording or audio file → text, with the "Audio to text" agents (failover as usual). */
  /** `names`: people who'll be heard (a meeting's attendees) – spelled right */
  /** `group`: the recording's group (top-level folder) – only its fixed words are used */
  async transcribeAudio(data: Buffer, mime: string, filename: string, names: string[] = [], group = ''): Promise<{ text: string; agent: string; words?: { word: string; start: number; end: number }[] }> {
    const { result, agent } = await this.agents.run('audio', async (backend, agent) => {
      if (!backend.transcribe)
        throw new Error(`${agent.name} can't transcribe audio – use a Wyoming (Home Assistant) or OpenAI-compatible speech-to-text server, e.g. Whisper`)
      const prompt = (this.vocabulary ? this.vocabulary.speechPrompt(names, group) : names.length ? `${names.join(', ')}.` : '') || undefined
      // with each word's time, where the server gives it (to follow along as it plays)
      const language = this.agents.settings().speechLanguage || undefined
      const once = async () =>
        backend.transcribeTimed ? await backend.transcribeTimed(data, mime, filename, prompt, language) : { text: await backend.transcribe!(data, mime, filename, prompt, language) }
      // Whisper on the same GPU as Ollama: room made first if it's needed it before
      const ollama = this.agents.agents().filter((a) => a.enabled && a.kind === 'ollama').map((a) => a.baseUrl)
      const shared = agent.kind === 'openai' && ollama.length > 0
      if (shared && speechNeedsRoom(agent)) await freeOllamaGpu(ollama)
      let r: Awaited<ReturnType<typeof once>>
      try {
        r = await once()
      } catch (e) {
        // failed (often out of GPU memory beside a language model): once more with the GPU to itself
        if (!shared || jobSignal()?.aborted || /timed out|aborted/i.test(describeError(e)) || !(await freeOllamaGpu(ollama)).length) throw e
        log.warn(`${agent.name} failed (${describeError(e)}) – trying again with Ollama's models out of the GPU`)
        reportProgress('Transcribing the recording again, with the GPU to itself…')
        r = await once()
        rememberSpeechNeedsRoom(agent)
      }
      // words you've fixed in transcripts before ("Summet" → "Summit"): fixed in this one too
      const fixed = fixHeard(collapseRepeats(r.text), r.words, this.vocabulary?.heardFixes(group) ?? [])
      return { text: fixed.text, words: fixed.words }
    })
    log.info(`transcribed ${Math.round(data.length / 1024)} KB of audio via "${agent.name}" (${result.text.length} chars${result.words ? `, ${result.words.length} timed words` : ''})`)
    // Speaches keeps it loaded a while – unloaded later only if the next model doesn't fit beside it
    speechUsed(agent)
    return { text: result.text, agent: agent.name, ...(result.words ? { words: result.words } : {}) }
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

  /**
   * Handwriting → Markdown. With `requireText` (an explicit "Convert to
   * text"), an agent that returns nothing counts as a failure, so the next
   * agent gets a try and the error explains what happened.
   */
  async transcribeHandwriting(png: Buffer, opts: { requireText?: boolean } = {}): Promise<{ text: string; agent: string }> {
    const { result, agent } = await this.agents.run('handwriting', (backend, agent) => this.transcribeWith(backend, agent, png, opts))
    return { text: result, agent: agent.name }
  }

  /** Transcribe with one specific agent (used by the chain above and by "Test reading handwriting"). */
  async transcribeWith(
    backend: Backend,
    agent: AgentConfig,
    png: Buffer,
    opts: { requireText?: boolean; mime?: string; photo?: boolean; line?: boolean; noCache?: boolean } = {},
  ): Promise<string> {
    // Try the agent's own prompt (or the detailed built-in one); if the model
    // returns nothing, try once more with a minimal instruction, which many
    // OCR models handle better.
    const extra = !opts.line && !this.agents.available('format') ? extraInstructions() : ''
    const prompts = [
      ...new Set([
        // (OCR-only models get their fixed prompt as is; single lines stay short)
        (knownOcrPrompt(agent.model) && !agent.prompt.trim()
          ? knownOcrPrompt(agent.model)!
          : opts.line
            ? agent.prompt.trim() || LINE_PROMPT
            : this.withVocab(agent.prompt.trim() || (opts.photo ? PHOTO_PROMPT : HANDWRITING_PROMPT)) + standing(opts.photo ? 'pictures' : 'handwriting')) +
          (extra ? `\n\nAdditional instructions from the user: ${extra}` : ''),
        opts.photo ? SHORT_PHOTO_PROMPT : SHORT_HANDWRITING_PROMPT,
      ]),
    ]
    // A single line can't need many tokens; a low cap also stops runaway loops quickly.
    const maxTokens = opts.line ? 200 : 4096
    const empties: string[] = []
    let explanation: string | undefined
    // the same image read the same way before: use that (a redo or extra instructions read it afresh)
    const cacheKey = opts.line || opts.noCache || extraInstructions() || isRedo() ? null : createHash('sha1').update(`${agent.kind}|${agent.baseUrl}|${agent.model}|${prompts[0]}|`).update(png).digest('hex')
    const saved = cacheKey ? this.savedReading(cacheKey) : null
    if (saved) {
      log.info(`handwriting via "${agent.name}": unchanged image, using the earlier reading`)
      return saved
    }
    for (const [i, prompt] of prompts.entries()) {
      try {
        const raw = await backend.generate([{ image: png, mime: opts.mime ?? 'image/png' }, { text: prompt }], maxTokens)
        const text = opts.line ? cleanOcrLine(raw) : cleanOcrText(raw)
        if (text.length < raw.length) log.info(`"${agent.name}" repeated itself; collapsed ${raw.length} → ${text.length} chars`)
        // the model says there's nothing written here: don't ask again (a second try tends to invent something)
        if (/^\W*no text\W*$/i.test(text)) {
          log.info(`"${agent.name}" found no text in the image`)
          if (opts.requireText) throw new NoTextError(opts.photo ? 'No text was found in this picture.' : 'No writing was found in this drawing.')
          return ''
        }
        log.info(`handwriting via "${agent.name}" (prompt ${i + 1}): ${text.length} chars – ${JSON.stringify(text.slice(0, 120))}`)
        if (text.trim()) {
          if (cacheKey) this.saveReading(cacheKey, text)
          return text
        }
        empties.push(`prompt ${i + 1}: empty reply`)
      } catch (err) {
        if (!(err instanceof EmptyReplyError)) throw err
        explanation ??= err.summary
        empties.push(prompts.length > 1 ? `prompt ${i + 1}: ${err.details}` : err.details)
        if (err.reason === 'thinking') break // asking differently won't stop it thinking
      }
    }
    if (!opts.requireText) return ''
    // the plain explanation first (when there is one), the details after it
    throw new Error(explanation ? `${explanation} (returned no text: ${empties.join(' | ')})` : `returned no text (${empties.join(' | ')})`)
  }

  /**
   * A photo or screenshot (e.g. of handwritten notes) → Markdown, using the
   * handwriting agents in priority order, then the clean-up agents.
   */
  async transcribePhoto(data: Buffer, mime: string, opts: { format?: boolean } = {}): Promise<{ text: string; agent: string; raw: string }> {
    if (!isAiImage(mime)) throw new Error(`unsupported image type ${mime}`)
    const fit = fitForAi(data, mime)
    // Find the written lines once (only needed for line-by-line agents).
    let lines: PictureLine[] | null | undefined
    const { result, agent } = await this.agents.run('handwriting', async (backend, agent) => {
      // A photo or screenshot is read whole: line-by-line (the default for local
      // models on Pencil drawings) loses the context that joins wrapped lines.
      // Only an agent explicitly set to "line by line" reads pictures that way.
      if (agent.reading === 'lines') {
        if (lines === undefined) lines = pictureLines(data, mime)
        if (lines) {
          const md = await this.readLines(backend, agent, lines)
          if (md !== null) return md
          log.info(`"${agent.name}": most lines came back empty – reading the picture as a whole instead`)
        }
      }
      return this.transcribeWith(backend, agent, fit.data, { requireText: true, mime: fit.mime, photo: true })
    })
    const text = opts.format === false ? result : await this.tidy(result, fit.data, fit.mime)
    return { text, agent: agent.name, raw: result }
  }

  /**
   * Read the lines found in a picture one at a time and rebuild the
   * structure. Returns null when the picture doesn't seem to be lines of
   * text after all (most lines empty), so the caller can read it whole.
   */
  private async readLines(backend: Backend, agent: AgentConfig, lines: PictureLine[]): Promise<string | null> {
    const texts: string[] = []
    for (const line of lines) {
      const key = `v2|${agent.id}|${agent.model}|${agent.prompt}|${createHash('sha1').update(line.png).digest('hex')}`
      let text = this.lineCache.get(key)
      if (text === undefined) {
        text = await this.transcribeWith(backend, agent, line.png, { line: true })
        this.lineCache.set(key, text)
        if (this.lineCache.size > 5000) this.lineCache.delete(this.lineCache.keys().next().value!)
      }
      texts.push(text)
    }
    const filled = texts.filter((t) => t).length
    if (filled < Math.max(1, lines.length * 0.4)) return null
    const md = linesToMarkdown(lines, texts)
    log.info(`picture via "${agent.name}" line by line: ${lines.length} lines, ${md.length} chars`)
    return md
  }

  /** Recent line results, so unchanged lines aren't re-read every time a drawing changes. */
  private lineCache = new Map<string, string>()

  /**
   * Handwritten drawing → Markdown. Agents set to read "line by line" get
   * each text line separately and the structure (bullets, indentation) is
   * rebuilt from the stroke layout; "whole page" agents get one image.
   * With `format`, the result is then tidied by the clean-up agents.
   */
  async transcribeDrawing(
    strokes: Stroke[],
    opts: { requireText?: boolean; format?: boolean } = {},
  ): Promise<{ text: string; agent: string | null; raw?: string }> {
    const page = renderDrawingPng(strokes)
    if (!page) return { text: '', agent: null }
    const lines = segmentLines(strokes)
    const { result, agent } = await this.agents.run('handwriting', async (backend, agent) => {
      if (readingMode(agent) === 'page' || lines.length < 2) return this.transcribeWith(backend, agent, page, opts)
      const texts: string[] = []
      for (const line of lines) {
        const key = `v2|${agent.id}|${agent.model}|${agent.prompt}|${line.strokes.map((s) => s.id).join(',')}`
        let text = this.lineCache.get(key)
        if (text === undefined) {
          const png = renderDrawingPng(line.strokes)
          text = png ? await this.transcribeWith(backend, agent, png, { line: true }) : ''
          this.lineCache.set(key, text)
          if (this.lineCache.size > 5000) this.lineCache.delete(this.lineCache.keys().next().value!)
        }
        texts.push(text)
      }
      const md = linesToMarkdown(lines, texts)
      log.info(`handwriting via "${agent.name}" line by line: ${lines.length} lines, ${md.length} chars`)
      if (opts.requireText && !md.trim()) throw new Error(`returned no text for any of the ${lines.length} lines`)
      return md
    })
    const text = opts.format && result.trim() ? await this.tidy(result, page, 'image/png') : result
    return { text, agent: agent.name, raw: result }
  }

  /**
   * Optional clean-up pass with the "Clean up converted text" agents. Never
   * fails the conversion: if no agent is set up or all fail, the recognised
   * text is returned as is.
   */
  /** The model the clean-up pass would use (kind|url|model), if any. */
  cleanupModel(): string | null {
    const key = (a: AgentConfig) => `${a.kind}|${a.baseUrl}|${a.model}`
    const readers = new Set(this.agents.chain('handwriting').map(key))
    const a = this.agents.chain('format')[0] ?? this.agents.chain('compile').find((x) => !readers.has(key(x)))
    return a ? key(a) : null
  }

  async tidy(text: string, image: Buffer | null, mime: string): Promise<string> {
    // no "Clean up converted text" agent: the "Compile notes" (text) models do it –
    // they're much better at joining wrapped lines and fixing structure than OCR models
    // (but not models that are also the handwriting readers: they'd just read it the same way again)
    const readers = new Set(this.agents.chain('handwriting').map((a) => `${a.kind}|${a.baseUrl}|${a.model}`))
    const notReader = (a: AgentConfig) => !readers.has(`${a.kind}|${a.baseUrl}|${a.model}`)
    const task = this.agents.available('format') ? 'format' : this.agents.chain('compile').some(notReader) ? 'compile' : null
    if (!task || !text.trim()) return text
    try {
      const { result, agent } = await this.agents.run(task, (backend, agent) => {
        const prompt =
          FORMAT_PROMPT.replace('{IMAGE}', agent.vision && image ? ' (the original image is attached)' : '').replace(
            '{SOURCE}',
            agent.vision && image ? 'the image' : 'common sense',
          ) + (standing('clean') ? `(${standing('clean').trim()})\n\n` : '') + (this.vocabulary?.hint() ? `(${this.vocabulary.hint()})\n\n` : '') + (extraInstructions() ? `(Additional instructions from the user – follow these: ${extraInstructions()})\n\n` : '') + text
        // The tidied text should be about as long as the input; leave some room for Markdown.
        const limit = Math.min(8192, Math.ceil(text.length / 2) + 512)
        return backend.generate(agent.vision && image ? [{ image, mime }, { text: prompt }] : [{ text: prompt }], limit)
      }, task === 'compile' ? notReader : undefined)
      const raw = unwrapModelOutput(result)
      const tidied = collapseRepeats(cleanTranscript(raw))
      log.info(`cleaned up converted text via "${agent.name}" (${text.length} → ${raw.length} chars)`)
      // Reject clean-ups that wander off: much longer than the input (before
      // or after collapsing repeats) means the model looped or invented text.
      const wandered = extraInstructions() ? raw.length > text.length * 3 + 1000 : raw.length > text.length * 2 + 200 || tidied.length < raw.length * 0.7
      if (!tidied.trim() || wandered) {
        log.warn(`clean-up by "${agent.name}" rejected (${text.length} → ${tidied.length} chars); keeping the recognised text`)
        return text
      }
      return tidied
    } catch (err) {
      if (jobSignal()?.aborted) throw err
      log.warn(`clean-up skipped: ${(err as Error).message}`)
      return text
    }
  }

  /**
   * Text the server read from a picture when it was added (for search), as a
   * transcription: the "Description:" line it adds for search is left out.
   */
  static searchTextAsTranscript(text: string): string {
    return text
      .split('\n')
      .filter((l) => !/^\s*\**\s*description\s*:/i.test(l))
      .join('\n')
      .trim()
  }

  /**
   * A photographed page of a recipe (a meal-kit card, a cookbook page) → its text, exactly as printed:
   * every amount and unit, amounts in columns for different numbers of people kept as columns.
   */
  async readRecipePage(data: Buffer, mime: string): Promise<{ text: string; agent: string }> {
    return this.readPage(data, mime, RECIPE_PAGE_PROMPT)
  }

  /** A photographed page of print (a book, a letter, a trail guide) → its text, exactly as printed. */
  async readPrintedPage(data: Buffer, mime: string): Promise<{ text: string; agent: string }> {
    return this.readPage(data, mime, PRINTED_PAGE_PROMPT)
  }

  /**
   * What a photographed page is – a recipe, handwriting, a printed page or directions – seen by a
   * "Pictures" model (it can tell handwriting from print). The raw one-word reply.
   */
  async whatPageIs(data: Buffer, mime: string, prompt: string): Promise<string> {
    if (!isAiImage(mime)) throw new Error(`unsupported image type ${mime}`)
    const fit = fitForAi(data, mime)
    const { result } = await this.agents.run('images', (backend) => backend.generate([{ image: fit.data, mime: fit.mime }, { text: prompt }], 400))
    return result
  }

  /** A few lines of a photo's text (to tell which way round it reads best): quick, short. */
  async readSnippet(data: Buffer, mime: string): Promise<string> {
    if (!isAiImage(mime)) return ''
    const fit = fitForAi(data, mime, 1200)
    const { result } = await this.agents.run(this.agents.available('images') ? 'images' : 'handwriting', (backend) =>
      backend.generate([{ image: fit.data, mime: fit.mime }, { text: 'Transcribe the first few lines of text in this image, exactly as written. Output only the text.' }], 160),
    )
    return result
  }

  private async readPage(data: Buffer, mime: string, prompt: string): Promise<{ text: string; agent: string }> {
    if (!isAiImage(mime)) throw new Error(`unsupported image type ${mime}`)
    const fit = fitForAi(data, mime)
    const task: AiTask = this.agents.available('images') ? 'images' : 'handwriting'
    const { result, agent } = await this.agents.run(task, (backend) => backend.generate([{ image: fit.data, mime: fit.mime }, { text: prompt }], 4000))
    return { text: result.trim(), agent: agent.name }
  }

  /** Image → searchable text (OCR + short description). */
  async imageText(data: Buffer, mime: string): Promise<string> {
    if (!isAiImage(mime)) throw new Error(`unsupported image type ${mime}`)
    const fit = fitForAi(data, mime)
    const { result } = await this.agents.run('images', (backend) =>
      backend.generate([{ image: fit.data, mime: fit.mime }, { text: IMAGE_TEXT_PROMPT + standing('pictures') }], 4000),
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
            text: 'Extract the full text of this document for a search index, including text in tables, charts and figures. Output only the text.' + standing('pictures'),
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
  async compile(parts: CompilePart[]): Promise<{ markdown: string; dropped: string[] }> {
    // For agents that can't read images, transcribe drawings and pictures
    // first (once, even if we fail over between several such agents).
    let transcribed: Promise<string> | null = null
    const asText = () =>
      (transcribed ??= (async () => {
        let text = ''
        for (const p of parts) {
          if ('text' in p) text += p.text
          else if (p.kind === 'drawing') {
            const t = (await this.transcribeDrawing(p.strokes)).text.trim()
            text += `\n${compileMarker('drawing', p.id)}\n${t || '(a sketch with no writing)'}\n\n`
          } else {
            const t = await this.transcribePhoto(p.image, p.mime, { format: false }).then((r) => r.text.trim(), () => '')
            text += `\n${compileMarker('image', p.id)}\n${t || '(a picture with no text)'}\n\n`
          }
        }
        return text
      })())

    let checked = false
    const { result } = await this.agents.run('compile', async (backend, agent) => {
      // Cloud models read the drawings and pictures themselves. Local (Ollama)
      // models get the handwriting read first and compile plain text: small
      // models do much better with text, and a note's worth of images at once
      // overflows a home graphics card.
      if (agent.vision && agent.kind !== 'ollama') {
        checked = false
        const input: Part[] = [{ text: this.withVocab(withExtra(COMPILE_PROMPT)) }, { text: '=== NOTE ===' }]
        for (const p of parts) {
          if ('text' in p) {
            if (p.text.trim()) input.push({ text: p.text })
          } else if (p.kind === 'drawing') input.push({ text: compileMarker('drawing', p.id) }, { image: p.image, mime: p.mime })
          else {
            const fit = fitForAi(p.image, p.mime)
            input.push({ text: compileMarker('image', p.id) }, { image: fit.data, mime: fit.mime })
          }
        }
        input.push({ text: '=== END OF NOTE ===' })
        return backend.generate(input, 32000)
      }
      // instructions first, then the note clearly marked, then a reminder: small
      // models otherwise drift into writing a "typical" note of their own
      checked = true
      const note = await asText()
      return backend.generate(
        [{ text: `${this.withVocab(withExtra(COMPILE_TEXT_PROMPT))}\n\n=== NOTE ===\n${note.trim()}\n=== END OF NOTE ===\n\nNow write the compiled document, using only what is in the note above.` }],
        32000,
      )
    })
    if (!checked) return { markdown: result, dropped: [] }
    // drop lines made of words that appear nowhere in the note (made up by the model)
    const source = await asText()
    const { markdown, dropped } = dropInvented(result, source)
    if (dropped.length) log.warn(`compile: removed ${dropped.length} line(s) that weren't in the note: ${dropped.map((d) => JSON.stringify(d.slice(0, 60))).join(', ')}`)
    return { markdown, dropped }
  }
}

const STOP = new Set(
  'the and for are but not you all any can had her was one our out day get has him his how man new now old see two way who boy did its let put say she too use that with have this will your from they know want been good much some time very when come here just like long make many more only over such take than them well were what into also then there their about would could should which these those after before other being under while where each'.split(' '),
)
const words = (s: string) =>
  (s.toLowerCase().normalize('NFKD').match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOP.has(w)).map((w) => w.replace(/(ing|ed|es|s)$/, ''))

/**
 * Remove lines of a compiled document that the note doesn't support: a
 * line of five or more words, most of which appear nowhere in the note, was
 * made up (headings and short lines may add a few words of their own).
 * Throws when most of the document is made up.
 */
export function dropInvented(markdown: string, source: string): { markdown: string; dropped: string[] } {
  const known = new Set(words(source))
  const out: string[] = []
  const dropped: string[] = []
  let total = 0
  let unknownTotal = 0
  for (const line of markdown.split('\n')) {
    const w = words(line.replace(/⟦[^⟧]*⟧/g, '').replace(/\]\([^)]*\)/g, ']'))
    const unknown = w.filter((x) => !known.has(x)).length
    total += w.length
    unknownTotal += unknown
    if (w.length >= 5 && unknown / w.length > 0.6) dropped.push(line.trim())
    else out.push(line)
  }
  if (total >= 20 && unknownTotal / total > 0.6)
    throw new Error('The model wrote a document that is mostly not in your note, so it wasn’t saved. Try again, or use a bigger model for “Compile notes” in Settings › AI agents.')
  return { markdown: out.join('\n'), dropped }
}

const MARKER = /[ \t]*⟦(?:AUDIO|FILE|IMAGE|DRAWING):[a-z0-9]+⟧[ \t]*/g

/** The line that stands for a recording or file in compile input and output. */
export const compileMarker = (kind: 'audio' | 'file' | 'image' | 'drawing', id: string) => `⟦${kind.toUpperCase()}:${id}⟧`

/**
 * Make sure a compiled document still has the note's recordings, files and
 * #tags (models sometimes drop or mangle them): each marker on its own line,
 * unknown or repeated ones removed, missing ones and tags added at the end.
 */
export function keepCompileExtras(markdown: string, markers: string[], tags: string[], links: string[] = []): string {
  const wanted = new Set(markers)
  const seen = new Set<string>()
  // pictures and links the model made up point nowhere: the originals come back through their markers
  markdown = markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\((?!https?:|mailto:)[^)]*\)/g, '$1')
  let md = markdown.replace(MARKER, (found) => {
    const m = found.trim()
    if (!wanted.has(m) || seen.has(m)) return ' '
    seen.add(m)
    return `\n\n${m}\n\n`
  })
  md = md.replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n').trim()
  const missing = markers.filter((m) => !seen.has(m))
  if (missing.length) md += '\n\n' + missing.join('\n\n')
  const linked = new Set([...md.matchAll(/\[\[([^\]\n]+)\]\]/g)].map((m) => m[1].trim().toLowerCase()))
  const unlinked = [...new Set(links)].filter((l) => !linked.has(l.trim().toLowerCase()))
  if (unlinked.length) md += '\n\nLinked: ' + unlinked.map((l) => `[[${l}]]`).join(' ')
  const have = new Set(extractTags(md))
  const lost = tags.filter((t) => !have.has(t))
  if (lost.length) md += '\n\n' + lost.map((t) => `#${t}`).join(' ')
  return md + '\n'
}

/** The note in reading order: text, drawings (rendered) and pictures. */
export type CompilePart =
  | { text: string }
  | { image: Buffer; mime: string; kind: 'drawing'; strokes: Stroke[]; id: string }
  | { image: Buffer; mime: string; kind: 'photo'; id: string }

/** How much of a meeting's transcript a part is (about 8 minutes of talk): a small model reads that well. */
const PART_CHARS = 7000

/** A transcript in parts of about `size` characters, cut between sentences. */
/**
 * A long transcript in parts cut where the talk changes subject (see meetingMeaning.ts) – null
 * without its stretches' vectors, or when no good cuts were found (then cut by length).
 */
export function meetingPartsByTopic(text: string, size: number, meaning: { stretches: Stretch[]; vecs: number[][] } | null): string[] | null {
  const t = text.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim()
  if (!meaning || t !== text || t.length <= size * 1.4) return null
  const parts = cutAt(t, topicCuts(t, meaning.stretches, meaning.vecs, size))
  return parts.length > 1 && parts.every((p) => p.length <= size * 1.6) ? parts : null
}

export function meetingParts(text: string, size: number): string[] {
  // line breaks stay: a transcript in speaker turns has one per turn
  const t = text.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim()
  if (t.length <= size * 1.4) return [t]
  const n = Math.ceil(t.length / size)
  const each = t.length / n
  const out: string[] = []
  let from = 0
  for (let i = 1; i < n; i++) {
    const aim = Math.round(each * i)
    // the nearest sentence end to where it should be cut
    // between turns, else between sentences
    const turnAfter = t.slice(aim).indexOf('\n')
    const after = turnAfter >= 0 && turnAfter < 600 ? turnAfter : t.slice(aim).search(/[.!?]\s/)
    const before = t.slice(0, aim).search(/[.!?]\s[^.!?]*$/)
    const cut = after >= 0 && after < 400 ? aim + after + 1 : before >= 0 && aim - before < 400 ? before + 1 : aim
    out.push(t.slice(from, cut).trim())
    from = cut
  }
  out.push(t.slice(from).trim())
  return out.filter(Boolean)
}
