import { generateJSON, getSchema, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TaskList } from '@tiptap/extension-task-list'
import { TaskItem } from '@tiptap/extension-task-item'
import { TableKit } from '@tiptap/extension-table'
import { prosemirrorJSONToYXmlFragment } from '@tiptap/y-tiptap'
import * as Y from 'yjs'
import { createNote, getContent, getNotes, noteDocName, readNote } from '@reconnotes/core'
import { DrawingNode } from '../drawing/DrawingNode'
import { AudioNode, FileNode, ImageNode } from '../editor/nodes'
import { DueDate } from '../editor/dueDate'
import { NoteLink } from '../editor/noteLink'
import { markdownToHtml } from './ai'
import { sync } from './sync'

/**
 * Open a Markdown file as a note: headings, lists, checklists, tables,
 * links and [[links to other notes]] become the real thing. Used for files
 * added to a folder, shared to the app, opened from the Files app, or
 * attached to a note ("Open as note").
 */

export const isMarkdownFile = (name: string, mime = '') => /\.(md|markdown|mdown|mkd)$/i.test(name) || /^text\/(x-)?markdown$/.test(mime)

/** The note's node types, without an editor on screen (made on first use: these modules import each other). */
const makeExtensions = () => [
  StarterKit.configure({ undoRedo: false, link: { openOnClick: false } }),
  TaskList,
  TaskItem.configure({ nested: true }),
  TableKit,
  DrawingNode,
  ImageNode,
  DueDate,
  NoteLink,
  AudioNode,
  FileNode,
]
let extensions: ReturnType<typeof makeExtensions> | null = null
let schema: ReturnType<typeof getSchema> | null = null

/** "[[Title]]" text → links to the notes with those titles. */
function linkNotes(node: JSONContent, titles: Map<string, string>): JSONContent[] {
  if (node.type === 'text' && node.text?.includes('[[')) {
    const out: JSONContent[] = []
    let last = 0
    for (const m of node.text.matchAll(/\[\[([^\]|#\n]+)(?:\|([^\]\n]+))?\]\]/g)) {
      const id = titles.get(m[1].trim().toLowerCase())
      if (!id) continue
      if (m.index! > last) out.push({ ...node, text: node.text.slice(last, m.index) })
      out.push({ type: 'noteLink', attrs: { noteId: id, title: (m[2] ?? m[1]).trim() } })
      last = m.index! + m[0].length
    }
    if (!out.length) return [node]
    if (last < node.text.length) out.push({ ...node, text: node.text.slice(last) })
    return out
  }
  if (node.type === 'codeBlock' || !node.content) return [node]
  return [{ ...node, content: node.content.flatMap((c) => linkNotes(c, titles)) }]
}

/** Markdown text → a new note in `folderId`. Returns its id. */
export async function noteFromMarkdown(markdown: string, fileName: string, folderId: string | null): Promise<string> {
  extensions ??= makeExtensions()
  schema ??= getSchema(extensions)
  const md = markdown
    .replace(/^﻿/, '')
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '') // front matter
    // pictures in the file can't come along: keep a link (web) or the description
    .replace(/!\[([^\]]*)\]\((https?:[^)\s]+)[^)]*\)/g, (_m, alt: string, url: string) => `[${alt || 'Picture'}](${url})`)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) => (alt ? `[${alt}]` : ''))
  const json = generateJSON(markdownToHtml(md), extensions) as JSONContent
  const titles = new Map<string, string>()
  getNotes(sync.workspace.doc).forEach((m, id) => {
    const n = readNote(m)
    if (!n.trashedAt && n.title) titles.set(n.title.trim().toLowerCase(), id)
  })
  const doc = linkNotes(json, titles)[0]
  // the first line is the note's title: start with the file name unless the text already does
  const name = fileName.replace(/\.[^.]+$/, '').trim() || 'Untitled'
  const first = doc.content?.[0]
  const firstText = (first?.content ?? []).map((c) => c.text ?? '').join('').trim()
  if (firstText.toLowerCase() !== name.toLowerCase()) doc.content = [{ type: 'paragraph', content: [{ type: 'text', text: name }] }, ...(doc.content ?? [])]
  if (!doc.content?.length) doc.content = [{ type: 'paragraph' }]

  const id = createNote(sync.workspace.doc, { folderId, title: firstText || name })
  const { handle, close } = sync.open(noteDocName(id))
  try {
    await handle.loaded
    prosemirrorJSONToYXmlFragment(schema, doc, getContent(handle.doc) as Y.XmlFragment)
  } finally {
    close()
  }
  return id
}
