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
- name: the recipe's title – the big name on the front with the line under it, if it has one (e.g. "Lemon Thyme Pork with Jasmine Rice", "Balsamic Tomato & Herb Chicken over Buttery Garlic Spaghetti"), not the time or calorie line. A letter missing where the card has a hole punched in it ("ALM ND", "TOM TO"): fill it in.
- ingredients: only what goes into the dish, one per line, amount first ("10 oz Ground Beef"). Where amounts are given for different numbers of people (columns like "2-person | 4-person"), keep both exactly as on the card ("½ Cup | 1 Cup Jasmine Rice") and set servings to the first column's number of people. An ingredient whose amount you can't read: just its name.
- A card often shows the ingredients as a grid of pictures, each with its amount on one line and its name on the next ("1 | 1" then "Yellow Onion"): put each amount with its own name, one ingredient per line – never two in one. Leave out what's only the other side of the card's options ("HelloCustom", calories for a swap).
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

/** an amount with its unit ("1 TBSP", "½ Cup") – not a bare number */
const UNIT_AMOUNT = String.raw`(?:\d+(?:[.,/]\d+)?|[½⅓⅔¼¾⅛])(?:\s*[½⅓⅔¼¾⅛])?\s*(?:tbsps?|tsps?|tablespoons?|teaspoons?|oz|ounces?|cups?|lbs?|pounds?|g|kg|ml|cloves?|slices?|cans?)\b\.?`

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
  // the bar not read at all, between two amounts with units: "Italian Seasoning 1 TBSP 1 TBSP"
  m = new RegExp(`^(.*?\\p{L}.*?)\\s+(${UNIT_AMOUNT})\\s+(${UNIT_AMOUNT})\\s*$`, 'iu').exec(t)
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
    .replace(/(^|\s)([1-9])\s?[1lI|]([1-9]|1[02468])(?=\s|$)/g, (all, sp: string, a: string, b: string) =>
      // (the second column the same as the first, or twice it – as for twice the people)
      Number(b) === Number(a) * 2 || b === a ? `${sp}${a} | ${b}` : all,
    )
}

/** Kitchen equipment, not food: a pan, a pot, a baking sheet, paper towels, a bowl… (with no amount). */
export const isEquipment = (raw: string) => {
  // ("*Baking sheet", "2 Small bowls": a mark, or how many – still no amount of anything)
  const t = raw.replace(/^[\s*•·-]+/, '').replace(/^\d+\s+(?=\p{L})/u, '')
  return !/\d|[½⅓⅔¼¾⅛]/.test(t) &&
  /^(?:an?\s+)?(?:(?:large|small|medium|big|non-?stick|oven-?proof|mixing|sauce|baking|sheet|frying|grill|cast[- ]iron)\s+)*(?:pans?|pots?|skillets?|baking sheets?|sheet pans?|paper towels?|bowls?|whisk|zester|grater|colander|strainer|peeler|cutting board|knife|tongs|spatula|blender|food processor|foil|parchment(?: paper)?|plastic wrap|microplane|measuring cups?|measuring spoons?|dutch oven|wok|baking dish|casserole dish)$/i.test(
    t.trim(),
  )
}

/** What everyone has at home – salt, pepper (with no amount): "From your pantry", not an ingredient. */
export const isPantry = (raw: string) => /^(?:(?:kosher|sea|table|fine)\s+)?salt(?:\s*(?:&|and)\s*(?:black\s+)?pepper)?$|^(?:(?:ground\s+)?black\s+)?pepper$/i.test(raw.replace(/^[\s*•·-]+/, '').trim())

const ALLERGEN = String.raw`(?:milk|eggs?|wheat|soy|fish|shellfish|tree\s+nuts?|peanuts?|sesame|gluten)`
/**
 * An ingredient line tidied: an allergen note ("(Contains: Milk)", "Contains: Wheat") taken out and
 * given back, a stray mark first ("*", "•"), and a lone letter last (from an icon read as text).
 */
export function tidyIngredient(raw: string): { text: string; allergens: string[] } {
  const allergens: string[] = []
  const text = raw
    .replace(new RegExp(String.raw`\(?\s*contains:?\s*((?:${ALLERGEN}\s*(?:,|and|&)?\s*)+)\)?`, 'gi'), (_all, list: string) => {
      for (const a of list.split(/,|and|&/)) if (a.trim()) allergens.push(a.trim().replace(/^\w/, (c) => c.toUpperCase()))
      return ' '
    })
    // a picture read as letters of another script ("ن/٦" for an onion), a badge (©, ®, ™)
    .replace(/[^\p{Script=Latin}0-9½⅓⅔¼¾⅛⅜⅝⅞\p{P}\p{Zs}+=<>|~^`$°]/gu, ' ')
    .replace(/^[\s*•·/\\-]+/, '')
    // a stray letter first ("C Ground Beef…", from a badge) – not "A" or "I"
    .replace(/^(?![AI]\s)[B-HJ-Z]\s+(?=\p{Lu})/u, '')
    .replace(/\s+[a-z]$/, '')
    .replace(/\s*[•·]\s*$/, '')
    // a unit twice ("¼ Oz Oz": the second column's amount lost)
    .replace(/\b(tbsps?|tsps?|oz|cups?|cloves?|lbs?)\s+\1\b/gi, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return { text, allergens }
}

/** An amount with nothing else (its name read on the next line, as on a card's grid of pictures). */
const amountOnly = (t: string) => new RegExp(`^(?:${AMOUNT})(?:\\s*\\|\\s*(?:${AMOUNT}))?$`, 'i').test(t.trim())
/** A name with no amount. */
const nameOnly = (t: string) => !/[\d½⅓⅔¼¾⅛]/.test(t) && /\p{L}{3}/u.test(t)

/** On a card's grid, each amount is read above its name ("1 | 1", "Yellow Onion"): put back together. */
export function joinAmountsToNames(items: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < items.length; i++) {
    if (amountOnly(items[i]) && i + 1 < items.length && nameOnly(items[i + 1])) {
      out.push(`${items[i]} ${items[i + 1]}`)
      i++
    } else if (items[i].trim()) out.push(items[i])
  }
  return out
}

/** The card's own small print – not part of the recipe: social media, a phone number, packaging, the other side's options. */
export const isBoilerplate = (t: string) =>
  /hellofresh(?:pics|\.com)|share your|@\w{3,}|\(\d{3}\)\s*\d{3}-\d{4}|sustainab|rest assured|if you chose to modify|flip side of this card|scan here|issues with your order|get social|www\.|\.com\b/i.test(t)

/** A "Bust out" list as one note ("BUST OUT • Zester • 2 Small bowls • Kosher salt • Olive oil (2 TBSP | 3 TBSP)"): its items. */
export function bustOutItems(t: string): string[] | null {
  if (!/^\s*bust out\b/i.test(t)) return null
  return t
    .replace(/^\s*bust out\s*:?/i, '')
    .split(/[•·]/)
    .map((x) => tidyIngredient(x).text)
    // (leftovers of icons read as text: "0 e")
    .filter((x) => /\p{L}{3}/u.test(x))
}

/**
 * Steps numbered on the card ("4 COOK VEGGIES: …"): in the card's order, without the numbers – they
 * come back in the order they were read, which on a card in columns isn't always the card's.
 */
export function inCardOrder(steps: string[]): string[] {
  const num = (t: string) => /^(\d{1,2})\s*[.):]?\s+(?=\S)/.exec(t)
  const numbered = steps.map((t) => ({ t, m: num(t) }))
  const have = numbered.filter((x) => x.m)
  if (have.length < Math.max(2, steps.length * 0.6)) return steps
  const nums = have.map((x) => Number(x.m![1]))
  const order = new Set(nums).size === nums.length
  const out = numbered.map((x, i) => ({ t: x.m ? x.t.slice(x.m[0].length) : x.t, n: x.m ? Number(x.m[1]) : i + 0.5 }))
  return (order ? out.sort((a, b) => a.n - b.n) : out).map((x) => x.t)
}

/** A name in capitals ("APRICOT, ALMOND & CHICKPEA TAGINE") in title case ("Apricot, Almond & Chickpea Tagine"). */
export function titleCase(name: string): string {
  const letters = name.replace(/[^\p{L}]/gu, '')
  if (!letters || letters.replace(/[^\p{Lu}]/gu, '').length < letters.length * 0.8) return name
  const small = new Set(['a', 'an', 'and', 'or', 'of', 'with', 'over', 'on', 'in', 'the', 'to', 'for', 'by'])
  return name
    .toLowerCase()
    .split(/(\s+)/)
    .map((w, i) => (i > 0 && small.has(w) ? w : w.replace(/\p{L}/u, (c) => c.toUpperCase())))
    .join('')
}

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
  const pantry: string[] = []
  const allergens = new Set<string>()
  const ingredients = joinAmountsToNames(
    (s.ingredients ?? []).map(str).map((t) => {
      const x = tidyIngredient(t)
      x.allergens.forEach((a) => allergens.add(a))
      return x.text
    }),
  )
    .filter(keep)
    .map((t) => {
      // amounts for 2 and 4 people side by side ("2 TBSP | 4 TBSP • Sour Cream", "Butter (1 TBSP | 2 TBSP)"): the first
      const c = splitColumns(t)
      if (c) columns.push(`${c.other} ${c.name}`.trim())
      return c ? `${c.first} ${c.name}`.trim() : t
    })
    .filter((t) => {
      // a pan, a sheet, paper towels… (no amount): equipment, not an ingredient
      if (isEquipment(t)) return (kitchen.push(t.replace(/^[\s*•·-]+/, '')), false)
      // salt, pepper: from home
      if (isPantry(t)) return (pantry.push(t.replace(/^[\s*•·-]+/, '')), false)
      return true
    })
    .map(mark)
  const steps = (s.steps ?? [])
    .map((x) => (typeof x === 'string' ? { title: '', text: str(x) } : { title: str((x as Record<string, unknown>)?.title), text: str((x as Record<string, unknown>)?.text) }))
    .filter((x) => keep(`${x.title} ${x.text}`.trim()))
    .map((x) => mark(x.title && !x.text.toLowerCase().startsWith(x.title.toLowerCase()) ? `${x.title}: ${x.text}` : x.text || x.title))
  const ordered = inCardOrder(steps)
  if (!ingredients.length && !ordered.length) throw new Error('No ingredients or steps could be found in the photos.')
  const notes = (s.notes ?? [])
    .map(str)
    // the card's "Bust out" list: equipment to "You'll need", the rest to "From your pantry"
    .filter((n) => {
      const items = bustOutItems(n)
      if (!items) return true
      for (const x of items) (isEquipment(x) ? kitchen : pantry).push(x.replace(/^[\s*•·-]+/, ''))
      return false
    })
    .filter((n) => !isBoilerplate(n))
    // the other column's amounts are worked out here (not the AI's version, often with gaps: "Zucchini: ?"); an allergen on its own, a gap
    .filter((n) => !/also on the card|\bfor n people\b/i.test(n) && !/^\(?contains:[^)]*\)?\.?$/i.test(n) && !/:\s*\?|\?\s*(?:oz|,|\))/i.test(n))
    // a heading with nothing under it ("Bust out"), or a gap left for later ("You'll need: …")
    .filter((n) => !/^(?:bust out|you['’]ll need|from your pantry|ingredients|notes?)\s*:?$/i.test(n) && !/:\s*(?:\.{3}|…)\s*$/.test(n))
    .map((n) => tidyIngredient(n).text)
    .filter(keep)
    .map(mark)
  // what was taken out of the ingredients goes in the notes (unless the AI already said so there)
  const said = notes.join(' ').toLowerCase()
  const needed = kitchen.filter((k) => !said.includes(k.toLowerCase()))
  if (needed.length) notes.unshift(`You’ll need: ${needed.join(', ')}`)
  const fromHome = pantry.filter((k) => !said.includes(k.toLowerCase()))
  if (fromHome.length) notes.push(`From your pantry: ${fromHome.join(', ')}`)
  if (allergens.size && !/\bcontains\b|allergen/i.test(said)) notes.push(`Contains: ${[...allergens].filter((a, i, all) => all.findIndex((b) => b.toLowerCase() === a.toLowerCase()) === i).join(', ')}`)
  if (columns.length) notes.push(`Amounts for the other number of people on the card: ${columns.join(', ')}`)
  const nutrition = (s.nutrition ?? [])
    .map((x) => (Array.isArray(x) ? ([str(x[0]), str(x[1])] as [string, string]) : (['', ''] as [string, string])))
    .filter(([k, v]) => k && v && readNumbers.has((/\d+(?:\.\d+)?/.exec(v)?.[0] ?? '').replace(',', '.')))
    // the same thing more than once ("Calories" for the meal and for each swap): the one on the card's times line, else the first
    .filter(([k, v], i, list) => {
      const same = list.filter(([k2]) => k2.toLowerCase() === k.toLowerCase())
      if (same.length < 2) return true
      const num = (x: string) => /\d+(?:\.\d+)?/.exec(x)?.[0] ?? ''
      const onTimes = (x: string) => new RegExp(`(?:prep|cook|total)[^\\n]*\\b${num(x)}\\b|\\b${num(x)}\\b[^\\n]*(?:prep|cook|total)`, 'i').test(all)
      const pick = same.find(([, v2]) => onTimes(v2)) ?? same[0]
      return pick[1] === v && list.findIndex(([k2, v2]) => k2 === k && v2 === v) === i
    })
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
  const name = titleCase(str(s.name) && grounded(str(s.name), readWords) >= 0.5 ? str(s.name) : texts[0].split('\n').find((l) => l.trim().length > 3)?.trim().slice(0, 80) || 'Recipe')
  const recipe: Recipe = {
    name,
    description: str(s.description) && grounded(str(s.description), readWords) >= 0.6 ? str(s.description) : undefined,
    servings: str(s.servings) || undefined,
    prep: time(s.prep),
    ...cookAndTotal(),
    ingredients,
    steps: [{ steps: ordered }],
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
