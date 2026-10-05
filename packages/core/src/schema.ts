import * as Y from 'yjs'

/**
 * Data model
 * ==========
 *
 * Everything that syncs is a Yjs document (a CRDT). Edits made on different
 * devices while offline are merged automatically when they reconnect: no edit
 * is ever thrown away, so two devices editing the same note produce a note
 * containing both sets of changes.
 *
 * There are two kinds of documents:
 *
 *  - `workspace`        – the folder tree and the list of notes (metadata only).
 *  - `note:<noteId>`    – the content of one note: rich text, drawings, and
 *                          machine-generated text (handwriting transcripts).
 *
 * Each folder / note entry inside the workspace is its own nested Y.Map so
 * that concurrent edits to different fields (rename on the iPhone, move on the
 * iPad) merge field-by-field instead of one overwriting the other.
 */

export const WORKSPACE_DOC = 'workspace'
export const NOTE_DOC_PREFIX = 'note:'

export const noteDocName = (noteId: string) => `${NOTE_DOC_PREFIX}${noteId}`
export const noteIdFromDocName = (name: string): string | null =>
  name.startsWith(NOTE_DOC_PREFIX) ? name.slice(NOTE_DOC_PREFIX.length) : null

/** Name of the XmlFragment holding the TipTap/ProseMirror document. */
export const CONTENT_FIELD = 'content'
/** Y.Map<drawingId, {height}> holding per-drawing settings. */
export const DRAWINGS_FIELD = 'drawings'
/** Y.Map<string, string> holding generated text: handwriting transcripts etc. */
export const TRANSCRIPTS_FIELD = 'transcripts'

export type SortMode = 'manual' | 'title' | 'created' | 'updated'

export interface FolderData {
  id: string
  name: string
  /** null for top-level folders */
  parentId: string | null
  /** fractional index used for manual ordering */
  order: string
  createdAt: number
  /** how the folder's children are sorted */
  sort: SortMode
  trashedAt: number | null
}

export interface NoteData {
  id: string
  title: string
  snippet: string
  folderId: string | null
  order: string
  createdAt: number
  updatedAt: number
  pinned: boolean
  trashedAt: number | null
  /** #tags found in the note (lower case, without #) */
  tags: string[]
  /** a template for new notes (listed under Templates, not with the notes) */
  template: boolean
}

export type FolderMap = Y.Map<unknown>
export type NoteMetaMap = Y.Map<unknown>

export function getFolders(doc: Y.Doc): Y.Map<FolderMap> {
  return doc.getMap<FolderMap>('folders')
}

export function getNotes(doc: Y.Doc): Y.Map<NoteMetaMap> {
  return doc.getMap<NoteMetaMap>('notes')
}

export function getSettings(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap('settings')
}

export function readFolder(m: FolderMap): FolderData {
  return {
    id: m.get('id') as string,
    name: (m.get('name') as string) ?? 'Untitled folder',
    parentId: (m.get('parentId') as string | null) ?? null,
    order: (m.get('order') as string) ?? 'a0',
    createdAt: (m.get('createdAt') as number) ?? 0,
    sort: (m.get('sort') as SortMode) ?? 'manual',
    trashedAt: (m.get('trashedAt') as number | null) ?? null,
  }
}

export function readNote(m: NoteMetaMap): NoteData {
  return {
    id: m.get('id') as string,
    title: (m.get('title') as string) ?? '',
    snippet: (m.get('snippet') as string) ?? '',
    folderId: (m.get('folderId') as string | null) ?? null,
    order: (m.get('order') as string) ?? 'a0',
    createdAt: (m.get('createdAt') as number) ?? 0,
    updatedAt: (m.get('updatedAt') as number) ?? 0,
    pinned: Boolean(m.get('pinned')),
    trashedAt: (m.get('trashedAt') as number | null) ?? null,
    tags: (m.get('tags') as string[] | undefined) ?? [],
    template: Boolean(m.get('template')),
  }
}

export function listFolders(doc: Y.Doc): FolderData[] {
  const out: FolderData[] = []
  getFolders(doc).forEach((m) => out.push(readFolder(m)))
  return out
}

export function listNotes(doc: Y.Doc): NoteData[] {
  const out: NoteData[] = []
  getNotes(doc).forEach((m) => out.push(readNote(m)))
  return out
}

// ---------------------------------------------------------------------------
// Note documents
// ---------------------------------------------------------------------------

export type Tool = 'pen' | 'marker' | 'highlighter' | 'pencil'

/**
 * One stroke of ink. Coordinates are in "drawing units": every drawing is
 * DRAWING_WIDTH units wide regardless of screen size, so ink lines up on an
 * iPhone, an iPad and a desktop browser alike.
 */
export interface Stroke {
  id: string
  tool: Tool
  color: string
  size: number
  /** flat list of x, y, pressure triples */
  pts: number[]
}

export const DRAWING_WIDTH = 1000
export const DEFAULT_DRAWING_HEIGHT = 500

export function getContent(doc: Y.Doc): Y.XmlFragment {
  return doc.getXmlFragment(CONTENT_FIELD)
}

/**
 * Ink for a drawing lives in a *top-level* Y.Array named `ink:<drawingId>`.
 * Top-level types are created implicitly by name, so two devices touching the
 * same drawing for the first time can never create competing copies (which
 * would happen with a lazily-created nested Y.Array and lose strokes).
 */
export function getStrokes(doc: Y.Doc, drawingId: string): Y.Array<Stroke> {
  return doc.getArray<Stroke>(`ink:${drawingId}`)
}

/** Per-drawing settings such as height (last writer wins, that's fine). */
export function getDrawingMeta(doc: Y.Doc): Y.Map<{ height: number }> {
  return doc.getMap<{ height: number }>(DRAWINGS_FIELD)
}

export function getDrawingHeight(doc: Y.Doc, drawingId: string): number {
  return getDrawingMeta(doc).get(drawingId)?.height ?? DEFAULT_DRAWING_HEIGHT
}

export function getTranscripts(doc: Y.Doc): Y.Map<string> {
  return doc.getMap<string>(TRANSCRIPTS_FIELD)
}
