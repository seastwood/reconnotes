import { useRef, useState } from 'react'
import { Download, Upload } from 'lucide-react'
import { apiUrl, authHeaders } from '../lib/settings'
import { saveBlob } from '../lib/files'
import { IMPORT_KINDS, importFiles, importSummary } from '../lib/importFiles'

/**
 * Settings › Your notes: export everything as Markdown (with pictures, files
 * and drawings) – readable in any app – and import Markdown back.
 */
export function ExportImportSection() {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<'export' | 'import' | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const exportAll = async () => {
    setBusy('export')
    setMessage(null)
    try {
      const res = await fetch(apiUrl('/api/export'), { headers: authHeaders() })
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Server error ${res.status}`)
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'ReconNotes.zip'
      await saveBlob(await res.blob(), name)
      setMessage('✅ Exported. The zip has a Markdown file for every note, in its folders, with pictures, files and drawings.')
    } catch (e) {
      setMessage(`❌ ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const importAll = async (files: File[]) => {
    if (!files.length) return
    setBusy('import')
    setMessage(null)
    const r = await importFiles(files)
    setBusy(null)
    setMessage(importSummary(r))
  }

  return (
    <div>
      <p className="hint">
        Your notes are never locked in. Export everything as Markdown files in their folders – they open in any notes or text app. Import
        Markdown or a zip of it (from ReconNotes, Obsidian, Bear, Notion…) – folders, pictures, checklists and [[links]] come along – or documents
        ({IMPORT_KINDS}): each becomes a note you can edit, with its headings, lists, tables and pictures. Anything else is kept as a file.
      </p>
      <div className="row">
        <button onClick={() => void exportAll()} disabled={busy !== null}>
          <Download size={15} /> {busy === 'export' ? 'Exporting…' : 'Export everything'}
        </button>
        <button onClick={() => input.current?.click()} disabled={busy !== null}>
          <Upload size={15} /> {busy === 'import' ? 'Importing…' : 'Import notes or documents…'}
        </button>
        <input
          ref={input}
          type="file"
          hidden
          multiple
          onChange={(e) => {
            void importAll([...(e.target.files ?? [])])
            e.target.value = ''
          }}
        />
      </div>
      {message && <p className="status" style={{ whiteSpace: 'pre-line' }}>{message}</p>}
    </div>
  )
}
