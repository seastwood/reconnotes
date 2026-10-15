import { apiUrl, authHeaders } from './settings'

export interface ImportOutcome {
  notes: number
  noteIds: string[]
  /** files that couldn't be read as notes (kept as files instead) */
  skipped: string[]
  errors: string[]
}

/**
 * Import files as notes – Markdown, a zip of it, or a document (Word, Excel, PowerPoint,
 * Pages, PDF, RTF, HTML, CSV, text…), in `folderId` (or not in a folder). The server reads them.
 */
export async function importFiles(files: File[], folderId: string | null = null): Promise<ImportOutcome> {
  const out: ImportOutcome = { notes: 0, noteIds: [], skipped: [], errors: [] }
  for (const f of files) {
    try {
      const res = await fetch(apiUrl(`/api/import${folderId ? `?folderId=${encodeURIComponent(folderId)}` : ''}`), {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': f.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(f.name) },
        body: f,
      })
      const body = (await res.json().catch(() => ({}))) as { notes?: number; noteIds?: string[]; skipped?: string[]; error?: string }
      if (!res.ok) throw new Error(body.error ?? `Server error ${res.status}`)
      out.notes += body.notes ?? 0
      out.noteIds.push(...(body.noteIds ?? []))
      out.skipped.push(...(body.skipped ?? []))
    } catch (e) {
      out.errors.push(`${f.name}: ${(e as Error).message}`)
    }
  }
  return out
}

/** What happened, in a line or two. */
export function importSummary(r: ImportOutcome): string {
  return (
    [
      r.notes ? `✅ Imported ${r.notes} note${r.notes === 1 ? '' : 's'}.` : '',
      r.skipped.length
        ? `⚠️ Kept as file${r.skipped.length === 1 ? '' : 's'} (couldn’t be read as a note): ${r.skipped.join(', ')}. Installing LibreOffice on your ReconNotes server lets it read older Office files and Pages, Numbers and Keynote.`
        : '',
      ...r.errors.map((e) => `❌ ${e}`),
    ]
      .filter(Boolean)
      .join('\n') || 'Nothing to import.'
  )
}

/** Every kind of file the import reads as a note (any other file is kept as a file). */
export const IMPORT_KINDS = 'Word, Excel, PowerPoint, Pages, Numbers, Keynote, OpenDocument, PDF, RTF, HTML, CSV, Markdown and text'
