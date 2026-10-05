import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'

/**
 * Find in note (⌘F)
 * =================
 *
 * Highlights every match of the query in the note and keeps track of the
 * "current" one for next/previous. Besides typed text it also searches the
 * text recognised from handwriting, pictures and recordings (transcripts);
 * such a match highlights the whole drawing / picture / recording.
 */

export interface FindMatch {
  from: number
  to: number
  /** a match in a drawing's, picture's or recording's recognised text */
  block: boolean
}

export interface FindState {
  query: string
  matches: FindMatch[]
  /** index into matches, -1 when there are none */
  current: number
}

export const findKey = new PluginKey<FindState>('find')

type Meta = { query?: string; current?: number }

export interface FindOptions {
  /** recognised text for a drawing / image / audio node, if any */
  transcriptOf: (node: PMNode) => string | null
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    find: {
      setFindQuery: (query: string) => ReturnType
      findNext: () => ReturnType
      findPrevious: () => ReturnType
      clearFind: () => ReturnType
      /** replace the current match (typed text only) and move to the next */
      replaceMatch: (text: string) => ReturnType
      /** replace every typed-text match, as one undo step */
      replaceAllMatches: (text: string) => ReturnType
    }
  }
}

const norm = (s: string) => s.toLocaleLowerCase()

function findMatches(doc: PMNode, query: string, transcriptOf: FindOptions['transcriptOf']): FindMatch[] {
  const q = norm(query.trim())
  if (!q) return []
  const out: FindMatch[] = []
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      // the block's text, with each character's position in the document
      let text = ''
      const at: number[] = []
      node.forEach((child, offset) => {
        const start = pos + 1 + offset
        if (child.isText) {
          const t = child.text ?? ''
          for (let i = 0; i < t.length; i++) at.push(start + i)
          text += t
        } else {
          at.push(start)
          text += child.type.name === 'hardBreak' ? '\n' : '￼'
        }
      })
      const hay = norm(text)
      for (let i = hay.indexOf(q); i >= 0; i = hay.indexOf(q, i + Math.max(1, q.length))) {
        out.push({ from: at[i], to: at[i + q.length - 1] + 1, block: false })
      }
      return false
    }
    if (node.isAtom) {
      const t = transcriptOf(node)
      if (t && norm(t).includes(q)) out.push({ from: pos, to: pos + node.nodeSize, block: true })
      return false
    }
    return true
  })
  return out
}

function decorations(doc: PMNode, s: FindState): DecorationSet {
  if (!s.matches.length) return DecorationSet.empty
  return DecorationSet.create(
    doc,
    s.matches.map((m, i) => {
      const cls = `find-match${i === s.current ? ' current' : ''}`
      return m.block ? Decoration.node(m.from, m.to, { class: `${cls} find-block` }) : Decoration.inline(m.from, m.to, { class: cls })
    }),
  )
}

/** Index of the first match at or after `pos` (wrapping to 0). */
function firstFrom(matches: FindMatch[], pos: number) {
  const i = matches.findIndex((m) => m.from >= pos)
  return matches.length ? (i < 0 ? 0 : i) : -1
}

export const FindInNote = Extension.create<FindOptions>({
  name: 'find',

  addOptions() {
    return { transcriptOf: () => null }
  },

  addCommands() {
    const step = (dir: 1 | -1) => ({ state, dispatch }: { state: EditorState; dispatch?: (tr: Transaction) => void }) => {
      const s = findKey.getState(state)
      if (!s || !s.matches.length) return false
      if (dispatch) dispatch(state.tr.setMeta(findKey, { current: (s.current + dir + s.matches.length) % s.matches.length } satisfies Meta))
      return true
    }
    return {
      setFindQuery:
        (query: string) =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(findKey, { query } satisfies Meta))
          return true
        },
      findNext: () => step(1),
      findPrevious: () => step(-1),
      clearFind:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(findKey, { query: '' } satisfies Meta))
          return true
        },
      replaceMatch:
        (text: string) =>
        ({ state, dispatch }) => {
          const s = findKey.getState(state)
          const m = s?.matches[s.current]
          if (!m || m.block) return false
          if (dispatch) dispatch(state.tr.insertText(text, m.from, m.to))
          return true
        },
      replaceAllMatches:
        (text: string) =>
        ({ state, dispatch }) => {
          const s = findKey.getState(state)
          const matches = (s?.matches ?? []).filter((m) => !m.block)
          if (!matches.length) return false
          if (dispatch) {
            const tr = state.tr
            // from the end, so earlier positions stay valid
            for (const m of [...matches].reverse()) tr.insertText(text, m.from, m.to)
            dispatch(tr)
          }
          return true
        },
    }
  },

  addProseMirrorPlugins() {
    const transcriptOf = this.options.transcriptOf
    return [
      new Plugin<FindState>({
        key: findKey,
        state: {
          init: () => ({ query: '', matches: [], current: -1 }),
          apply(tr, prev, _old, state) {
            const meta = tr.getMeta(findKey) as Meta | undefined
            if (meta?.query !== undefined) {
              const matches = findMatches(state.doc, meta.query, transcriptOf)
              // start from the match nearest the cursor, like other editors
              return { query: meta.query, matches, current: firstFrom(matches, state.selection.from) }
            }
            if (meta?.current !== undefined) return { ...prev, current: meta.current }
            if (tr.docChanged && prev.query) {
              const matches = findMatches(state.doc, prev.query, transcriptOf)
              const was = prev.matches[prev.current]
              const current = was ? firstFrom(matches, tr.mapping.map(was.from)) : firstFrom(matches, 0)
              return { ...prev, matches, current }
            }
            return prev
          },
        },
        props: {
          decorations(state) {
            const s = findKey.getState(state)
            return s ? decorations(state.doc, s) : DecorationSet.empty
          },
        },
      }),
    ]
  },
})

/** Scroll the current match into the middle of the note, without moving the cursor. */
export function revealCurrentMatch(view: EditorView) {
  const s = findKey.getState(view.state)
  const m = s?.matches[s.current]
  if (!m) return
  const scroller = view.dom.closest('.editor-scroll') as HTMLElement | null
  let top: number
  let bottom: number
  if (m.block) {
    const el = view.nodeDOM(m.from) as HTMLElement | null
    if (!el?.getBoundingClientRect) return
    const r = el.getBoundingClientRect()
    top = r.top
    bottom = Math.min(r.bottom, r.top + 200)
  } else {
    const a = view.coordsAtPos(m.from)
    const b = view.coordsAtPos(m.to)
    top = a.top
    bottom = b.bottom
  }
  if (!scroller) return
  const box = scroller.getBoundingClientRect()
  // already comfortably visible: don't move
  if (top >= box.top + 60 && bottom <= box.bottom - 80) return
  scroller.scrollTo({ top: scroller.scrollTop + (top - box.top) - box.height / 3, behavior: 'smooth' })
}
