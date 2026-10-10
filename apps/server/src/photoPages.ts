import fs from 'node:fs'
import type { Store } from './store'
import type { SyncEngine } from './sync'
import type { Ai } from './ai'
import { jobSignal, reportProgress } from './jobs'
import { uprightPages } from './photoUpright'
import { createPhotoNote, numbersIn, words, type PhotoPage } from './photoRecipe'

/**
 * A note from photos of pages
 * ===========================
 *
 * Photos of pages that aren't a recipe – handwritten notes, a page of a book,
 * a trail guide's directions – become one note: each page's text read (on the
 * phone by Apple's text recognition, or here by the AI), then laid out as the
 * kind of page it is, and the photos kept at the end.
 *
 * The layout never changes the words: the AI's version is checked against
 * what was read, and if it left out or added much (or changed a number), the
 * text is kept as read instead – just with its lines joined back up.
 */

export type PageKind = 'general' | 'handwriting' | 'printed' | 'directions'
export const PAGE_KINDS: PageKind[] = ['general', 'handwriting', 'printed', 'directions']

const TITLES: Record<PageKind, string> = { general: 'Note from photos', handwriting: 'Handwritten notes', printed: 'Pages', directions: 'Directions' }

const COMMON = `- Keep every word and number exactly as read. Don't reword, summarise, correct, translate or add anything – only lay it out.
- Begin with a "# " title: the page's own title if it has one, otherwise a few of its own first words.
- Leave out the "--- Page N ---" markers. A sentence that runs on from one page to the next is one sentence.
- Output only the Markdown.`

const ARRANGE: Record<Exclude<PageKind, 'handwriting'>, string> = {
  general: `Below is the text read from photos (of anything: a page, a sign, a whiteboard, a form, a note – printed or handwritten), page by page. Lay it out as a plain Markdown note:

- Join lines that were only broken by the width of the page back into paragraphs.
- Headings, lists, checkboxes and tables only where the text already has them. Don't turn it into anything else (no recipe, no steps, no summary).
${COMMON}`,
  printed: `Below is the text read from photos of printed pages (a book, a magazine, a letter, a manual), page by page. Lay it out as Markdown:

- Join lines that were only broken by the width of the page back into paragraphs; join a word hyphenated across two lines.
- Headings as headings ("## "), lists as lists, a table as a table – only where the page has them.
- Leave out the page numbers, and a book's title or chapter name repeated at the top or bottom of every page.
${COMMON}`,
  directions: `Below is the text read from photos of directions (a trail guide, a route, a set of instructions), page by page. Lay it out as Markdown:

- The facts at the start, if the pages give them (distance, time, elevation, difficulty, where to start or park): a short "- " list.
- The directions: a numbered list ("1. "), one turn or instruction per item, in order – continuing the numbering across the pages.
- Every distance, time, bearing, landmark, trail or road name and warning exactly as written.
- Headings ("## ") for sections the pages have; notes and warnings that aren't steps as their own paragraphs.
- Join lines that were only broken by the width of the page.
${COMMON}`,
}

/** What share of `of`'s words are in `in` (0–1). */
function share(of: string, inText: string): number {
  const have = new Set(words(inText))
  const w = words(of)
  return w.length ? w.filter((x) => have.has(x)).length / w.length : 1
}

/**
 * Is `laid` the same text as `read`, laid out? Nearly all of what was read is in it, it adds little,
 * and every number in it was read.
 */
export function sameWords(read: string, laid: string): boolean {
  const body = laid.replace(/^#\s.*\n?/, '')
  if (share(read, laid) < 0.9 || share(body, read) < 0.9) return false
  const nums = numbersIn(read)
  // (a numbered list's own numbers aren't the page's)
  return [...numbersIn(body.replace(/^\s*\d+[.)]\s/gm, ''))].every((n) => nums.has(n))
}

/** The text as read, its lines joined back into paragraphs (a blank line, a list item or a short heading-like line starts a new one). */
export function reflow(text: string): string {
  const out: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const last = out[out.length - 1]
    if (!line) {
      if (last) out.push('')
      continue
    }
    const listy = (t: string) => /^(?:[-*•]\s|\d+[.)]\s|#)/.test(t)
    // a line broken only by the page's width: it ends mid-sentence, and the next carries on (or it was a long line)
    const runsOn = last && !listy(line) && !last.startsWith('#') && /[\p{Ll},;–-]$/u.test(last) && (/^[\p{Ll}\d(“"‘']/u.test(line) || last.length > 40)
    if (runsOn) {
      out[out.length - 1] = /\p{L}-$/u.test(last) ? last.slice(0, -1) + line : `${last} ${line}`
    } else out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

const unwrap = (t: string) =>
  t
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/, '$1')
    .trim()

/** Photos of pages → a note in `folderId`. */
export async function notesFromPhotos(
  store: Store,
  sync: SyncEngine,
  ai: Ai,
  pages: PhotoPage[],
  kind: PageKind,
  folderId: string | null,
): Promise<{ noteId: string; title: string; asRead: boolean; agent: string }> {
  if (!pages.length) throw new Error('No photos to read.')
  // the ones the phone didn't read (a browser): turned the right way up here first
  pages = await uprightPages(store, ai, pages)
  // 1. each page's text
  const texts: string[] = []
  let reader = ''
  for (const [k, p] of pages.entries()) {
    const att = store.getAttachment(p.attachmentId)
    if (!att || !store.hasBlob(att.id)) throw new Error('A photo hasn’t reached the server yet – try again in a moment.')
    let text = (p.text ?? '').trim()
    if (text.length < 20) {
      reportProgress(`Reading photo ${k + 1} of ${pages.length}…`)
      const data = fs.readFileSync(store.blobPath(att.id))
      // handwriting: your handwriting readers (with your words); print: the "Pictures" readers
      // (anything: whatever's written or printed in it)
      const r = kind === 'handwriting' || kind === 'general' ? await ai.transcribePhoto(data, att.mime, { format: false }) : await ai.readPrintedPage(data, att.mime)
      text = r.text.trim()
      reader = r.agent
    } else reader ||= 'Apple text recognition (on the phone)'
    texts.push(text)
  }
  if (texts.join('').replace(/[^\p{L}]/gu, '').length < 10) throw new Error('No text could be read in the photos – try clearer, closer photos in good light.')

  // 2. laid out as what it is – the words unchanged
  reportProgress('Laying out the note…')
  const read = texts.length > 1 ? texts.map((t, i) => `--- Page ${i + 1} ---\n${t}`).join('\n\n') : texts[0]
  const plain = texts.map(reflow).join('\n\n')
  let laid = ''
  let agent = ''
  try {
    if (kind === 'handwriting') {
      // the same clean-up as "Convert to text" on a picture of handwriting (it may fix a misread letter)
      const one = pages.length === 1 ? store.getAttachment(pages[0].attachmentId) : null
      laid = (await ai.tidy(texts.join('\n\n'), one ? fs.readFileSync(store.blobPath(one.id)) : null, one?.mime ?? 'image/png')).trim()
    } else if (read.length < 12000) {
      const r = await ai.chat(`${ARRANGE[kind]}\n\n${read}`)
      laid = unwrap(r.text)
      agent = r.agent
    }
  } catch {
    laid = ''
  }
  // handwriting's clean-up may fix a misread word: a looser check
  const ok = laid && (kind === 'handwriting' ? share(texts.join(' '), laid) >= 0.75 : sameWords(read.replace(/^--- Page \d+ ---$/gm, ''), laid))
  const body = ok ? laid : plain

  // 3. the note: a title, the text, the photos
  const top = body.split('\n').find((l) => l.trim()) ?? ''
  const heading = /^#{1,3}\s+(.+)$/.exec(top)
  const rest = heading ? body.slice(body.indexOf(top) + top.length).trim() : body
  const plainTop = top.replace(/^[-*•\d.)\s]+/, '').trim()
  const title = heading?.[1].trim().slice(0, 100) || (plainTop && plainTop.length <= 60 ? plainTop : TITLES[kind])
  const md = [
    `# ${title}`,
    '',
    `*From ${pages.length} photo${pages.length === 1 ? '' : 's'} · read ${new Date().toISOString().slice(0, 10)}${ok ? '' : ' · kept as read'}*`,
    '',
    // (a title taken from the first line: that line stays in the text too)
    rest,
    '',
    '## The original',
    '',
    ...pages.map((_, i) => `![Page ${i + 1}](rnphoto-${i})\n`),
  ].join('\n')
  const noteId = await createPhotoNote(store, sync, md, pages, folderId, title)
  return { noteId, title, asRead: !ok, agent: [reader, agent].filter(Boolean).join(' + ') }
}

export type PhotoKind = PageKind | 'recipe'

const GUESS = (text: string) => `What are these photos of? Answer with one word:
RECIPE – a recipe (a meal-kit card, a cookbook page: ingredients and cooking steps)
HANDWRITING – handwritten notes, a letter or a notebook page (written by hand, not printed)
DIRECTIONS – directions or a route (a trail guide, turn-by-turn instructions, how to get somewhere)
PRINTED – a printed page of text (a book, a magazine, a letter, a manual)
OTHER – anything else, or a mix
${text.trim() ? `\nThe text read from them begins:\n${text.slice(0, 1500)}\n` : ''}
Reply with only the word.`

const WORDS: Record<string, PhotoKind> = { RECIPE: 'recipe', HANDWRITING: 'handwriting', DIRECTIONS: 'directions', PRINTED: 'printed', OTHER: 'general' }
/** The kind named in a model's reply ("RECIPE", "It's a recipe."), if it names one. */
export function kindIn(reply: string): PhotoKind | null {
  const t = reply.replace(/<think>[\s\S]*?<\/think>/g, '').toUpperCase()
  const hits = Object.keys(WORDS).filter((w) => new RegExp(`\\b${w}\\b`).test(t))
  return hits.length === 1 ? WORDS[hits[0]] : null
}

/** A sure guess from the words alone (or null): a recipe's ingredients and steps, a route's turns. */
export function kindFromWords(text: string): PhotoKind | null {
  const count = (re: RegExp) => (text.match(re) ?? []).length
  const recipe =
    count(/\b(?:ingredients?|servings?|preheat|simmer|tbsp|tsp|tablespoons?|teaspoons?|cups?|oz|minced|chopped|stir|bake|saut[eé]|season)\b/gi) +
    2 * count(/\b(?:ingredients|preheat)\b/gi)
  const route = count(/\b(?:trail(?:head)?|turn (?:left|right)|bear (?:left|right)|junction|fork|miles?|km|kilomet(?:er|re)s?|elevation|summit|ridge|parking|north|south|east|west|cairn|blaze[sd]?)\b/gi)
  if (recipe >= 6 && recipe >= route * 3) return 'recipe'
  if (route >= 6 && route >= recipe * 3) return 'directions'
  return null
}

/**
 * Photos of pages whose kind wasn't chosen: what they are. The words first (a recipe and a route are
 * plain from them); otherwise a "Pictures" model looks at the first photo (it can tell handwriting
 * from print) or, without one, the AI reads the text. A general note, when it can't tell.
 */
export async function guessKind(store: Store, ai: Ai, pages: PhotoPage[], text: string): Promise<{ kind: PhotoKind; by: string }> {
  const plain = kindFromWords(text)
  if (plain) return { kind: plain, by: 'the words' }
  try {
    const att = store.getAttachment(pages[0]?.attachmentId ?? '')
    if (ai.canImages && att && store.hasBlob(att.id)) {
      const k = kindIn(await ai.whatPageIs(fs.readFileSync(store.blobPath(att.id)), att.mime, GUESS(text)))
      if (k) return { kind: k, by: 'the picture' }
    }
    if (text.trim()) {
      const k = kindIn((await ai.chat(GUESS(text))).text)
      if (k) return { kind: k, by: 'the text' }
    }
  } catch (e) {
    if (jobSignal()?.aborted) throw e
  }
  return { kind: 'general', by: 'a default' }
}

/** Photos read here (the ones the phone didn't read): their text, for working out what they are. */
export async function readForGuess(store: Store, ai: Ai, pages: PhotoPage[]): Promise<{ pages: PhotoPage[]; agent: string }> {
  pages = await uprightPages(store, ai, pages)
  let agent = ''
  const out: PhotoPage[] = []
  for (const [k, p] of pages.entries()) {
    if ((p.text ?? '').trim().length >= 20) {
      out.push(p)
      continue
    }
    const att = store.getAttachment(p.attachmentId)
    if (!att || !store.hasBlob(att.id)) throw new Error('A photo hasn’t reached the server yet – try again in a moment.')
    reportProgress(`Reading photo ${k + 1} of ${pages.length}…`)
    const r = await ai.readPrintedPage(fs.readFileSync(store.blobPath(att.id)), att.mime)
    agent = r.agent
    out.push({ ...p, text: r.text })
  }
  return { pages: out, agent }
}
