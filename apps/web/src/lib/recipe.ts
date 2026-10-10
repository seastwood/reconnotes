import type { Editor } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import * as Y from 'yjs'
import { getContent, getNotes, noteDocName, readNote } from '@reconnotes/core'
import { noteFromMarkdown } from './markdownNotes'
import { sync } from './sync'
import { workspaceDoc } from './workspace'

/**
 * Recipe notes
 * ============
 *
 * A note with an "Ingredients" heading (an imported recipe card, or one you
 * wrote): its servings scaled, its ingredients added to the shopping list,
 * and its steps cooked one at a time.
 */

const heading = (n: PMNode, re: RegExp) => n.type.name === 'heading' && re.test(n.textContent.trim())
const INGREDIENTS = /^ingredients\b/i
const STEPS = /^(steps|instructions|directions|method|preparation)\b/i

/** The list right under a heading (up to the next heading): its items' text, and where each item's text starts. */
function listUnder(doc: PMNode, re: RegExp): { text: string; pos: number; checked?: boolean }[] {
  const out: { text: string; pos: number; checked?: boolean }[] = []
  let inside = false
  doc.forEach((node, offset) => {
    if (node.type.name === 'heading') {
      inside = heading(node, re) || (inside && node.attrs.level > 2)
      return
    }
    if (!inside || !/^(bulletList|orderedList|taskList)$/.test(node.type.name)) return
    node.descendants((child, p) => {
      if (!/^(listItem|taskItem)$/.test(child.type.name)) return true
      const para = child.firstChild
      if (para?.isTextblock) out.push({ text: para.textContent.trim(), pos: offset + 1 + p + 2, checked: child.attrs.checked })
      return false
    })
  })
  return out.filter((x) => x.text)
}

export const isRecipeNote = (editor: Editor) => {
  let found = false
  editor.state.doc.forEach((n) => (found ||= heading(n, INGREDIENTS)))
  return found
}
export const ingredientsOf = (editor: Editor) => listUnder(editor.state.doc, INGREDIENTS)
export const stepsOf = (editor: Editor) => listUnder(editor.state.doc, STEPS)

// --- amounts -------------------------------------------------------------------

const FRACTIONS: Record<string, number> = { '½': 1 / 2, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 1 / 4, '¾': 3 / 4, '⅛': 1 / 8, '⅜': 3 / 8, '⅝': 5 / 8, '⅞': 7 / 8 }
const F = '[½⅓⅔¼¾⅛⅜⅝⅞]'
const ONE = `(?:\\d+\\s+\\d+/\\d+|\\d+\\s*${F}|\\d+/\\d+|\\d+(?:\\.\\d+)?|${F})`
/** the amount a line starts with: "2", "1 ½", "2½", "1/2", "1.5", "1-2", "2 to 3" */
const LEADING = new RegExp(`^(${ONE})(?:(\\s*(?:-|–|to)\\s*)(${ONE}))?`)

export function parseAmount(s: string): number {
  const t = s.trim()
  let m = /^(\d+)\s+(\d+)\/(\d+)$/.exec(t)
  if (m) return Number(m[1]) + Number(m[2]) / Number(m[3])
  m = new RegExp(`^(\\d+)\\s*(${F})$`).exec(t)
  if (m) return Number(m[1]) + FRACTIONS[m[2]]
  m = /^(\d+)\/(\d+)$/.exec(t)
  if (m) return Number(m[1]) / Number(m[2])
  if (FRACTIONS[t] !== undefined) return FRACTIONS[t]
  return Number(t)
}

/** 1.5 → "1½", 0.333 → "⅓", 2.4 → "2.4" */
export function formatAmount(n: number): string {
  const whole = Math.floor(n + 1e-9)
  const rest = n - whole
  if (rest < 0.03) return String(whole)
  if (rest > 0.97) return String(whole + 1)
  for (const [ch, v] of Object.entries(FRACTIONS)) if (Math.abs(rest - v) < 0.03) return `${whole || ''}${ch}`
  return String(Math.round(n * 100) / 100)
}

/** A line's leading amount, times `factor` ("1 (19 ounce) can beans": the 1 – not the can's size). */
export function scaleLine(line: string, factor: number): string {
  const m = LEADING.exec(line)
  if (!m) return line
  const top = parseAmount(m[3] ?? m[1]) * factor
  const a = formatAmount(parseAmount(m[1]) * factor)
  const b = m[3] ? `${m[2]}${formatAmount(top)}` : ''
  // its unit agrees with the new amount: 1 pound, 2 pounds
  const rest = line
    .slice(m[0].length)
    .replace(/^(\s+)(pound|cup|tablespoon|teaspoon|can|clove|ounce|quart|pint|slice|stick|package|stalk|bunch|head|sprig|piece)(e?s)?\b/i, (_w, sp: string, unit: string, pl?: string) =>
      top > 1 + 1e-9 ? `${sp}${unit}${pl ?? (/(ch|sh)$/i.test(unit) ? 'es' : 's')}` : `${sp}${unit}`,
    )
  return `${a}${b}${rest}`
}

/** The servings the note says ("Servings: 8 servings", "Serves 4"), and where that number is. */
function servingsAt(doc: PMNode): { n: number; pos: number; len: number } | null {
  let out: { n: number; pos: number; len: number } | null = null
  doc.descendants((node, pos) => {
    if (out || !node.isTextblock) return !out
    const m = /\b(?:servings|serves|yield|makes)\b\W*?(\d+)/i.exec(node.textContent)
    if (m) {
      // the number's place in the text: through its text nodes
      let at = m.index + m[0].length - m[1].length
      node.forEach((child, off) => {
        if (out || !child.isText) return
        if (at < child.text!.length + 0) out = { n: Number(m[1]), pos: pos + 1 + off + at, len: m[1].length }
        else at -= child.text!.length
      })
    }
    return false
  })
  return out
}

export const servingsOf = (editor: Editor) => servingsAt(editor.state.doc)?.n ?? null

/** The recipe for `to` servings (from `from`): every ingredient's amount, and the servings line. One undo. */
export function scaleRecipe(editor: Editor, from: number, to: number) {
  const factor = to / from
  const { state } = editor
  const tr = state.tr
  // last first: positions before the change stay right
  const edits: { from: number; to: number; text: string }[] = []
  for (const item of listUnder(state.doc, INGREDIENTS)) {
    const node = state.doc.nodeAt(item.pos - 1)
    const lead = node?.firstChild
    if (!lead?.isText) continue
    if (!LEADING.test(lead.text!)) continue
    // the amount and the unit after it (which agrees with the new amount): the start of the line, rewritten
    const was = lead.text!
    const now = scaleLine(was, factor)
    let same = 0
    while (same < was.length && same < now.length && was[was.length - 1 - same] === now[now.length - 1 - same]) same++
    edits.push({ from: item.pos, to: item.pos + was.length - same, text: now.slice(0, now.length - same) })
  }
  const s = servingsAt(state.doc)
  if (s) edits.push({ from: s.pos, to: s.pos + s.len, text: String(to) })
  for (const e of edits.sort((a, b) => b.from - a.from)) tr.insertText(e.text, e.from, e.to)
  editor.view.dispatch(tr)
}

// --- the shopping list -----------------------------------------------------------

/** Unchecked ingredients onto the "Shopping list" note (made the first time). Returns its id and how many. */
export async function addToShoppingList(editor: Editor, recipeTitle: string): Promise<{ noteId: string; added: number }> {
  const items = ingredientsOf(editor).filter((i) => !i.checked)
  const notes = getNotes(workspaceDoc)
  let id: string | null = null
  notes.forEach((m, k) => {
    const n = readNote(m)
    if (!id && !n.trashedAt && /^shopping list$/i.test(n.title.trim())) id = k
  })
  const heading = `For ${recipeTitle || 'a recipe'}`
  if (!id) {
    const md = `# Shopping list\n\n**${heading}**\n\n${items.map((i) => `- [ ] ${i.text.replace(/([\\[\]*_])/g, '\\$1')}`).join('\n')}`
    return { noteId: await noteFromMarkdown(md, 'Shopping list.md', null), added: items.length }
  }
  const { handle, close } = sync.open(noteDocName(id))
  try {
    await handle.loaded
    handle.doc.transact(() => {
      const label = new Y.XmlElement('paragraph')
      label.insert(0, [new Y.XmlText(`${heading}:`)])
      const list = new Y.XmlElement('taskList')
      list.insert(
        0,
        items.map((i) => {
          const item = new Y.XmlElement('taskItem')
          item.setAttribute('checked', 'false')
          const p = new Y.XmlElement('paragraph')
          p.insert(0, [new Y.XmlText(i.text)])
          item.insert(0, [p])
          return item
        }),
      )
      const frag = getContent(handle.doc)
      frag.insert(frag.length, [label, list])
    })
  } finally {
    close()
  }
  return { noteId: id, added: items.length }
}
