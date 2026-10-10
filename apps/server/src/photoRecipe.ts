import * as Y from 'yjs'
import fs from 'node:fs'
import { WORKSPACE_DOC, createNote, extractNote, getContent, newId, noteDocName, updateNote } from '@reconnotes/core'
import type { Store } from './store'
import type { SyncEngine } from './sync'
import type { Ai } from './ai'
import { reportProgress } from './jobs'
import { markdownToNodes } from './importNotes'
import { recipeCard, type Recipe } from './recipe'

/**
 * A recipe from photos
 * ====================
 *
 * A meal-kit card (front and back), a cookbook page, a printout over several
 * pages: each photo's text is read (on the phone, by Apple's text recognition,
 * or here by the "Pictures" AI), then the AI sets it out as a recipe – the same
 * kind of note as a recipe imported from a website, cook mode and all.
 *
 * It's checked against what was read, so nothing is made up: an ingredient or
 * step whose words aren't on the pages is left out (and said so), and an
 * amount that isn't is marked to check (dotted underline). The photos come
 * along at the end of the note.
 */

export interface PhotoPage {
  attachmentId: string
  /** the text the phone read in it (Apple's text recognition), if it did */
  text?: string
}

const esc = (s: string) => s.replace(/([\\`*_[\]<>|~!#])/g, '\\$1')
export const words = (t: string) => (t.toLowerCase().match(/[\p{L}]{3,}/gu) ?? []).map((w) => w.replace(/(?:es|s)$/, ''))

const FRACTIONS: Record<string, string> = { '½': '1/2', '⅓': '1/3', '⅔': '2/3', '¼': '1/4', '¾': '3/4', '⅛': '1/8' }
/** the numbers in a text, every way they could be written (½ is 1/2, 1 ½ is 1½) */
export function numbersIn(t: string): Set<string> {
  const out = new Set<string>()
  const norm = t.replace(/[½⅓⅔¼¾⅛]/g, (f) => ` ${FRACTIONS[f]}`)
  for (const m of norm.matchAll(/\d+(?:[.,]\d+)?(?:\/\d+)?/g)) out.add(m[0].replace(',', '.'))
  return out
}

/** How much of `item`'s wording is in what was read (0–1). */
export function grounded(item: string, read: Set<string>): number {
  const w = [...new Set(words(item))]
  if (!w.length) return 1
  return w.filter((x) => read.has(x)).length / w.length
}

/** Amounts in `item` that aren't anywhere in what was read: marked to check (⸢12⸣). */
export function markUnreadAmounts(item: string, readNumbers: Set<string>): string {
  return item.replace(/\d+(?:[.,]\d+)?(?:\/\d+)?|[½⅓⅔¼¾⅛]/g, (n) => {
    const key = FRACTIONS[n] ?? n.replace(',', '.')
    return readNumbers.has(key) ? n : `⸢${n}⸣`
  })
}

const STRUCTURE = (text: string) => `Below is the text read from photos of a recipe (a meal-kit card, a cookbook page…), page by page. Set it out as a recipe, as JSON:

{"name": "", "description": "", "servings": "", "prep": "", "cook": "", "total": "", "ingredients": [""], "steps": [{"title": "", "text": ""}], "notes": [""], "nutrition": [["Calories", ""]]}

- Copy the wording exactly – every amount, unit and word as read. Don't add, guess, convert or reword anything; leave a field "" or [] when the text doesn't give it.
- name: the recipe's title – the big name on the front (e.g. "Lemon Thyme Pork with Jasmine Rice"), not the time or calorie line.
- ingredients: only what goes into the dish, one per line, amount first ("10 oz Ground Beef"). Where amounts are given for different numbers of people (columns like "2-person | 4-person"), keep both exactly as on the card ("½ Cup | 1 Cup Jasmine Rice") and set servings to the first column's number of people. An ingredient whose amount you can't read: just its name.
- Not ingredients: the equipment ("Bust out", "You'll need": pans, pots, baking sheets, paper towels) and what you bring from home (salt, pepper, oil, butter you supply) – those go in notes ("You'll need: …", "From your pantry: …").
- steps: in order, each with its title if it has one ("Cook the beef") and its text.
- notes: what else matters – what you'll need (pans, tools), what you bring from home (salt, oil, butter), tips. Never a "?" or a placeholder: leave out what you can't read.
- Times as written ("30 min"), only the ones the text gives: don't work out a cook or total time yourself.
- Reply with the JSON only.

${text}`

interface Structured {
  name?: string
  description?: string
  servings?: string
  prep?: string
  cook?: string
  total?: string
  ingredients?: unknown[]
  steps?: unknown[]
  notes?: unknown[]
  nutrition?: unknown[]
}

/** The JSON in the AI's reply (it may wrap it in a code fence, or think first). */
function parseJson(reply: string): Structured | null {
  const t = reply.replace(/<think>[\s\S]*?<\/think>/g, '')
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(t.slice(start, end + 1)) as Structured
  } catch {
    return null
  }
}

/** an amount: a number (or fraction) and its unit – "2 TBSP", "½ Cup", "12 oz", "1" */
const AMOUNT = String.raw`(?:\d+(?:[.,/]\d+)?|[½⅓⅔¼¾⅛])(?:\s*[½⅓⅔¼¾⅛])?(?:\s*(?:tbsps?|tsps?|tablespoons?|teaspoons?|oz|ounces?|cups?|lbs?|pounds?|g|kg|ml|l|cloves?|pieces?|cans?|slices?|qt|pt|unit|units|pkg|packages?)\b\.?)?`

/**
 * An ingredient with amounts for different numbers of people side by side: the first amount, the
 * other(s), and the ingredient. "2 TBSP | 4 TBSP • Sour Cream", "1|2 • Lemon", "Butter (1 TBSP | 2 TBSP)".
 */
export function splitColumns(raw: string): { first: string; other: string; name: string } | null {
  const t = fixBars(raw)
  let m = new RegExp(`^(${AMOUNT})\\s*\\|\\s*(${AMOUNT})\\s*[•·:–-]?\\s*(.+)$`, 'i').exec(t)
  if (m) return { first: m[1].trim(), other: m[2].trim(), name: m[3].trim() }
  m = new RegExp(`^(.+?)\\s*\\((${AMOUNT})\\s*\\|\\s*(${AMOUNT})\\)\\s*$`, 'i').exec(t)
  if (m) return { first: m[2].trim(), other: m[3].trim(), name: m[1].replace(/^\(contains:[^)]*\)\s*[•·]?\s*/i, '').trim() }
  // after the name, as in a card's table: "Jasmine Rice ½ Cup | 1 Cup"
  m = new RegExp(`^(.*?\\p{L}.*?)\\s+(${AMOUNT})\\s*\\|\\s*(${AMOUNT})\\s*$`, 'iu').exec(t)
  if (m) return { first: m[2].trim(), other: m[3].trim(), name: m[1].replace(/\s*[•·:–-]\s*$/, '').trim() }
  return null
}

/**
 * The bar between two amounts, as text recognition sometimes reads it: an "I" or "l" ("¼ Oz I¼ Oz"),
 * or a "1" run into the numbers ("Zucchini 112" for 1 | 2 – the second twice the first, as for
 * twice the people).
 */
export function fixBars(t: string): string {
  return t
    .replace(new RegExp(`(${AMOUNT})\\s*[Il]\\s*(?=[\\d½⅓⅔¼¾⅛])`, 'gi'), (all, a: string) => (/[\d½⅓⅔¼¾⅛]/.test(a) ? `${a.trim()} | ` : all))
    .replace(/(^|\s)([1-9])[1lI|]([2-9]|1[02468])(?=\s|$)/g, (all, sp: string, a: string, b: string) => (Number(b) === Number(a) * 2 ? `${sp}${a} | ${b}` : all))
}

/** Kitchen equipment, not food: a pan, a pot, a baking sheet, paper towels, a bowl… (with no amount). */
export const isEquipment = (t: string) =>
  !/\d|[½⅓⅔¼¾⅛]/.test(t) &&
  /^(?:an?\s+)?(?:(?:large|small|medium|big|non-?stick|oven-?proof|mixing|sauce|baking|sheet|frying|grill|cast[- ]iron)\s+)*(?:pans?|pots?|skillets?|baking sheets?|sheet pans?|paper towels?|bowls?|whisk|zester|grater|colander|strainer|peeler|cutting board|knife|tongs|spatula|blender|food processor|foil|parchment(?: paper)?|plastic wrap|microplane|measuring cups?|measuring spoons?|dutch oven|wok|baking dish|casserole dish)$/i.test(
    t.trim(),
  )

const str = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : typeof v === 'number' ? String(v) : '')

/** Photos → a recipe note in `folderId`. */
export async function recipeFromPhotos(
  store: Store,
  sync: SyncEngine,
  ai: Ai,
  pages: PhotoPage[],
  folderId: string | null,
): Promise<{ noteId: string; title: string; left: string[]; unsure: number; agent: string }> {
  if (!pages.length) throw new Error('No photos to read.')
  // 1. each page's text
  const texts: string[] = []
  let reader = ''
  for (const [k, p] of pages.entries()) {
    const att = store.getAttachment(p.attachmentId)
    if (!att || !store.hasBlob(att.id)) throw new Error('A photo hasn’t reached the server yet – try again in a moment.')
    let text = (p.text ?? '').trim()
    if (text.length < 40) {
      reportProgress(`Reading photo ${k + 1} of ${pages.length}…`)
      const r = await ai.readRecipePage(fs.readFileSync(store.blobPath(att.id)), att.mime)
      text = r.text
      reader = r.agent
    } else reader ||= 'Apple text recognition (on the phone)'
    texts.push(text)
  }
  const all = texts.map((t, i) => `--- Page ${i + 1} ---\n${t}`).join('\n\n')
  if (all.replace(/[^\p{L}]/gu, '').length < 40) throw new Error('No recipe text could be read in the photos – try clearer, closer photos in good light.')

  // 2. set out as a recipe
  reportProgress('Setting out the recipe…')
  const { text: reply, agent } = await ai.chat(STRUCTURE(all))
  const s = parseJson(reply)
  if (!s) throw new Error('The AI didn’t set it out as a recipe – try again (or with clearer photos).')

  // 3. checked against what was read: nothing made up
  const readWords = new Set(words(all))
  const readNumbers = numbersIn(all)
  const left: string[] = []
  // the lead-ins it's asked to write ("Amounts for 4 people are also on the card: …", "You'll need: …")
  // aren't on the card themselves: what follows them is what's checked
  const LEAD = /^(?:amounts for [^:]{1,40} (?:are )?also on the card|you['’]ll need|bring from home|from home|you(?: will)? need|allergens?|tip)\s*:\s*/i
  const keep = (t: string) => {
    if (!t) return false
    if (grounded(t.replace(LEAD, ''), readWords) >= 0.6) return true
    left.push(t)
    return false
  }
  let unsure = 0
  const mark = (t: string) => {
    const m = markUnreadAmounts(t, readNumbers)
    if (m !== t) unsure++
    return m
  }
  const columns: string[] = []
  const kitchen: string[] = []
  const ingredients = (s.ingredients ?? [])
    .map(str)
    .filter(keep)
    .map((t) => {
      // amounts for 2 and 4 people side by side ("2 TBSP | 4 TBSP • Sour Cream", "Butter (1 TBSP | 2 TBSP)"): the first
      const c = splitColumns(t)
      if (c) columns.push(`${c.other} ${c.name}`.trim())
      return c ? `${c.first} ${c.name}`.trim() : t
    })
    .filter((t) => {
      // a pan, a sheet, paper towels… (no amount): equipment, not an ingredient
      if (isEquipment(t)) return (kitchen.push(t), false)
      return true
    })
    .map(mark)
  const steps = (s.steps ?? [])
    .map((x) => (typeof x === 'string' ? { title: '', text: str(x) } : { title: str((x as Record<string, unknown>)?.title), text: str((x as Record<string, unknown>)?.text) }))
    .filter((x) => keep(`${x.title} ${x.text}`.trim()))
    .map((x) => mark(x.title && !x.text.toLowerCase().startsWith(x.title.toLowerCase()) ? `${x.title}: ${x.text}` : x.text || x.title))
  if (!ingredients.length && !steps.length) throw new Error('No ingredients or steps could be found in the photos.')
  const notes = (s.notes ?? [])
    .map(str)
    // the other column's amounts are worked out here (not the AI's version, often with gaps: "Zucchini: ?"); an allergen on its own, a gap
    .filter((n) => !/also on the card|\bfor n people\b/i.test(n) && !/^\(?contains:[^)]*\)?\.?$/i.test(n) && !/:\s*\?|\?\s*(?:oz|,|\))/i.test(n))
    .filter(keep)
    .map(mark)
  // what was taken out of the ingredients goes in the notes (unless the AI already said so there)
  const said = notes.join(' ').toLowerCase()
  const needed = kitchen.filter((k) => !said.includes(k.toLowerCase()))
  if (needed.length) notes.unshift(`You’ll need: ${needed.join(', ')}`)
  if (columns.length) notes.push(`Amounts for the other number of people on the card: ${columns.join(', ')}`)
  const nutrition = (s.nutrition ?? [])
    .map((x) => (Array.isArray(x) ? ([str(x[0]), str(x[1])] as [string, string]) : (['', ''] as [string, string])))
    .filter(([k, v]) => k && v && readNumbers.has((/\d+(?:\.\d+)?/.exec(v)?.[0] ?? '').replace(',', '.')))
  // a time whose number wasn't read (worked out by the AI) is left out
  const time = (v: unknown) => {
    const t = str(v)
    const n = /\d+/.exec(t)?.[0]
    return t && n && readNumbers.has(n) ? t : undefined
  }
  // a cook time that's the card's total (the AI moved it, and worked out a total of its own): the total
  const cookAndTotal = () => {
    const cook = time(s.cook)
    const total = time(s.total)
    const cardTotal = /\btotal\b\W{0,3}(\d+)/i.exec(all)?.[1]
    if (cook && cardTotal && /\d+/.exec(cook)?.[0] === cardTotal && /\d+/.exec(total ?? '')?.[0] !== cardTotal) return { cook: undefined, total: cook }
    if (cook && cook === total) return { cook: undefined, total }
    return { cook, total }
  }
  const name = str(s.name) && grounded(str(s.name), readWords) >= 0.5 ? str(s.name) : texts[0].split('\n').find((l) => l.trim().length > 3)?.trim().slice(0, 80) || 'Recipe'
  const recipe: Recipe = {
    name,
    description: str(s.description) && grounded(str(s.description), readWords) >= 0.6 ? str(s.description) : undefined,
    servings: str(s.servings) || undefined,
    prep: time(s.prep),
    ...cookAndTotal(),
    ingredients,
    steps: [{ steps }],
    nutrition,
  }

  // 4. the note: the recipe (the first photo as its picture), its notes, the photos
  const md = [
    `# ${esc(name)}`,
    '',
    `*From ${pages.length} photo${pages.length === 1 ? '' : 's'} · read ${new Date().toISOString().slice(0, 10)}*`,
    '',
    recipeCard(recipe, 'rnphoto-0', esc),
    ...(notes.length ? ['', '## Notes', '', ...notes.map((n) => `- ${esc(n)}`)] : []),
    ...(unsure ? ['', `*Amounts with a dotted underline weren’t found in what was read – check them against the photos.*`] : []),
    ...(pages.length > 1 ? ['', '## The original', '', ...pages.slice(1).map((_, i) => `![Page ${i + 2}](rnphoto-${i + 1})\n`)] : []),
  ].join('\n')
  const noteId = await createPhotoNote(store, sync, md, pages, folderId, name)
  return { noteId, title: name, left, unsure, agent: [reader, agent].filter(Boolean).join(' + ') }
}

/** A note made from photos: its Markdown, where "rnphoto-N" is the Nth photo. */
export async function createPhotoNote(store: Store, sync: SyncEngine, md: string, pages: PhotoPage[], folderId: string | null, title: string): Promise<string> {
  const noteId = newId()
  await sync.change(WORKSPACE_DOC, (ws) => void createNote(ws, { id: noteId, folderId, title }))
  await sync.change(noteDocName(noteId), (doc) => {
    const nodes = markdownToNodes(md, {
      attach: (href) => {
        const m = /^rnphoto-(\d+)$/.exec(href)
        const att = m ? store.getAttachment(pages[Number(m[1])]?.attachmentId ?? '') : null
        return att ? { id: att.id, name: att.name, mime: att.mime, size: att.size } : null
      },
      noteFor: () => null,
    })
    getContent(doc).insert(0, nodes)
  })
  const doc = sync.getDoc(noteDocName(noteId)) as Y.Doc | null
  if (doc) {
    const ex = extractNote(doc)
    await sync.change(WORKSPACE_DOC, (ws) => updateNote(ws, noteId, { title: ex.title, snippet: ex.snippet, tags: ex.tags, links: ex.links }))
  }
  return noteId
}
