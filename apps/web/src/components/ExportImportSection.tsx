import { useRef, useState } from 'react'
import { Download, Upload } from 'lucide-react'
import { apiUrl, authHeaders } from '../lib/settings'
import { saveBlob } from '../lib/files'

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

  const importFiles = async (files: File[]) => {
    if (!files.length) return
    setBusy('import')
    setMessage(null)
    let notes = 0
    const errors: string[] = []
    for (const f of files) {
      try {
        const res = await fetch(apiUrl('/api/import'), {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': f.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(f.name) },
          body: f,
        })
        const body = (await res.json().catch(() => ({}))) as { notes?: number; error?: string }
        if (!res.ok) throw new Error(body.error ?? `Server error ${res.status}`)
        notes += body.notes ?? 0
      } catch (e) {
        errors.push(`${f.name}: ${(e as Error).message}`)
      }
    }
    setBusy(null)
    setMessage(
      [notes ? `✅ Imported ${notes} note${notes === 1 ? '' : 's'}.` : '', ...errors.map((e) => `❌ ${e}`)].filter(Boolean).join('\n') ||
        'Nothing to import.',
    )
  }

  return (
    <div>
      <p className="hint">
        Your notes are never locked in. Export everything as Markdown files in their folders – they open in any notes or text app – or import
        Markdown files or a zip of them (from ReconNotes, Obsidian, Bear, Notion…). Folders, pictures, checklists and [[links]] come along.
      </p>
      <div className="row">
        <button onClick={() => void exportAll()} disabled={busy !== null}>
          <Download size={15} /> {busy === 'export' ? 'Exporting…' : 'Export everything'}
        </button>
        <button onClick={() => input.current?.click()} disabled={busy !== null}>
          <Upload size={15} /> {busy === 'import' ? 'Importing…' : 'Import Markdown or zip…'}
        </button>
        <input
          ref={input}
          type="file"
          hidden
          multiple
          accept=".md,.markdown,.txt,.zip,text/markdown,text/plain,application/zip"
          onChange={(e) => {
            void importFiles([...(e.target.files ?? [])])
            e.target.value = ''
          }}
        />
      </div>
      {message && <p className="status" style={{ whiteSpace: 'pre-line' }}>{message}</p>}
    </div>
  )
}
