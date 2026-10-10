import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Globe, Loader2 } from 'lucide-react'
import { isFinished, submitJob, useJobs, watchingJob } from '../lib/jobs'
import { safeLocalGet, safeLocalSet } from '../lib/store'
import { isSyncConfigured } from '../lib/settings'
import { addAttachment, flushUploads } from '../lib/attachments'

/**
 * Import a web page: a guide, manual or article becomes a note – its text,
 * headings, lists, tables, code, links and every picture – or, with "the
 * rest of the guide", one note per page in a folder of its own. A PDF is
 * one note too, unless it's asked to be split at its chapters. The server
 * does the work (as a job), so it carries on if this is closed.
 */
export function WebImportDialog({ folderId, onClose, onOpen, initialUrl = '' }: { folderId: string | null; onClose: () => void; onOpen: (noteId: string) => void; initialUrl?: string }) {
  const [url, setUrl] = useState(initialUrl)
  const [follow, setFollow] = useState(false)
  const [maxPages, setMaxPages] = useState(50)
  /** a PDF: a note per chapter (in a folder) instead of one note */
  const [splitPdf, setSplitPdf] = useState(false)
  // remembered from last time: tidy with AI, and a recipe page's article under its card
  const [tidy, setTidyState] = useState(() => safeLocalGet<boolean>('reconnotes.importTidy', false))
  const setTidy = (v: boolean) => (setTidyState(v), safeLocalSet('reconnotes.importTidy', v))
  const [recipeArticle, setRecipeArticleState] = useState(() => safeLocalGet<boolean>('reconnotes.importRecipeArticle', true))
  const setRecipeArticle = (v: boolean) => (setRecipeArticleState(v), safeLocalSet('reconnotes.importRecipeArticle', v))
  const [jobId, setJobId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const job = useJobs((s) => s.jobs.find((j) => j.id === jobId))

  // while it's on screen, no "finished" toast for it
  useEffect(() => {
    if (!jobId) return
    watchingJob(jobId, true)
    return () => watchingJob(jobId, false)
  }, [jobId])

  /** a PDF manual from this device: uploaded, then split into notes like a guide */
  const startPdf = async (file: File) => {
    setError(null)
    try {
      const attachmentId = await addAttachment(file, file.name)
      await flushUploads()
      const j = await submitJob({ kind: 'web-import', title: file.name, input: { pdfAttachmentId: attachmentId, folderId, splitPdf } })
      setJobId(j.id)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const pdfInput = useRef<HTMLInputElement>(null)

  const start = async () => {
    setError(null)
    let u = url.trim()
    if (!u) return
    if (!/^https?:\/\//i.test(u)) u = `https://${u}`
    try {
      new URL(u)
    } catch {
      return setError('That doesn’t look like a web address.')
    }
    try {
      const j = await submitJob({ kind: 'web-import', title: u.replace(/^https?:\/\//, '').slice(0, 120), input: { url: u, follow, maxPages: follow ? maxPages : 1, folderId, splitPdf, tidy, recipeArticle } })
      setJobId(j.id)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  /** which pages "the guide" means: those under this address */
  const scope = (() => {
    try {
      const u = new URL(/^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`)
      const dir = u.pathname.endsWith('/') ? u.pathname : u.pathname.replace(/[^/]*$/, '')
      return url.trim() ? `${u.host}${dir}` : ''
    } catch {
      return ''
    }
  })()
  const result = job?.status === 'done' ? (job.result as { noteId?: string; pages?: number; pictures?: number; notes?: string[] } | null) : null
  const busy = Boolean(job && !isFinished(job))

  return createPortal(
    <div className="dialog-backdrop" onClick={onClose}>
      <form
        className="dialog web-import-dialog"
        role="dialog"
        aria-label="Import a web page"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          if (!jobId) void start()
        }}
      >
        <h2>
          <Globe size={18} /> Import a web page or PDF
        </h2>
        {!isSyncConfigured() ? (
          <p className="hint">Importing web pages is done by your ReconNotes server – connect one in Settings.</p>
        ) : !jobId ? (
          <>
            <p className="hint">
              A guide, manual or article becomes a note, as it was on the page: headings, lists, tables, code, links and every picture (downloaded,
              so it stays even if the site changes). The site’s menus, banners and footers are left out. Later, “Check for updates” in its menu brings
              it up to date.
            </p>
            <label>
              Link to the page
              <input
                type="url"
                inputMode="url"
                name="page-url"
                // not "Address": Safari would offer to fill in a street address
                autoComplete="url"
                autoFocus
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="go"
                placeholder="https://docs.example.com/guide/"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </label>
            <label className="check">
              <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Import every page of this guide
            </label>
            <p className="hint">
              {follow ? (
                <>
                  For manuals split into chapters on separate pages. Each page becomes its own note, in a new folder
                  {scope ? (
                    <>
                      {' '}
                      – only pages under <code>{scope}</code>
                    </>
                  ) : null}
                  . Up to{' '}
                  <input className="pages-input" type="number" min={1} max={300} value={maxPages} onChange={(e) => setMaxPages(Math.max(1, Math.min(300, Number(e.target.value) || 1)))} /> pages.
                </>
              ) : (
                'Just this page. Tick the box if the guide continues on other pages.'
              )}
            </p>
            {error && <p className="error-text">{error}</p>}
            <p className="hint">
              A manual that’s a PDF? Paste its link, or{' '}
              <button type="button" className="text" onClick={() => pdfInput.current?.click()}>
                choose a PDF from this device
              </button>{' '}
              – it becomes a note, with the original PDF kept in it.
              <input
                ref={pdfInput}
                type="file"
                accept="application/pdf,.pdf"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ''
                  if (f) void startPdf(f)
                }}
              />
            </p>
            <label className="check">
              <input type="checkbox" checked={splitPdf} onChange={(e) => setSplitPdf(e.target.checked)} /> Split a PDF into a note per chapter
            </label>
            {splitPdf && <p className="hint">Each chapter becomes its own note, in a new folder with a contents note – handy for very long manuals.</p>}
            <label className="check">
              <input type="checkbox" checked={tidy} onChange={(e) => setTidy(e.target.checked)} /> Tidy with AI
            </label>
            {tidy && (
              <p className="hint">
                Takes out the website’s leftovers – share buttons, ratings, ads, newsletter boxes, “you’ll also love” lists. It never rewrites anything, and never
                removes steps, ingredients or amounts; the untidied version stays in the note’s history.
              </p>
            )}
            <label className="check">
              <input type="checkbox" checked={recipeArticle} onChange={(e) => setRecipeArticle(e.target.checked)} /> Recipes: keep the rest of the page too
            </label>
            <p className="hint">
              A recipe is set out neatly at the top of the note – servings and times, the ingredients as a checklist, the steps numbered.
              {recipeArticle ? ' Below it: everything else the page says (tips, variations…).' : ' Only that – the rest of the page is left out.'}
            </p>
            <div className="row">
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={!url.trim()}>
                Import
              </button>
            </div>
          </>
        ) : (
          <>
            {busy && (
              <p className="hint">
                <Loader2 size={14} className="spin" /> {job?.progress ?? 'Waiting its turn in Jobs…'}
              </p>
            )}
            {busy && <p className="hint">You can close this – it carries on in Jobs, and you’ll be told when it’s done.</p>}
            {job?.status === 'failed' && <p className="error-text">{job.error ?? 'Couldn’t import it.'}</p>}
            {result && (
              <>
                <p>
                  ✅ Imported {result.pages ?? 1} page{result.pages === 1 ? '' : 's'}
                  {result.pictures ? ` with ${result.pictures} picture${result.pictures === 1 ? '' : 's'}` : ''}.
                </p>
                {!!result.notes?.length && (
                  <ul className="hint web-import-notes">
                    {result.notes.slice(0, 8).map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
            <div className="row">
              {job?.status === 'failed' && (
                <button type="button" onClick={() => setJobId(null)}>
                  Try again
                </button>
              )}
              <button type="button" className={result ? undefined : 'primary'} onClick={onClose}>
                {busy ? 'Close' : 'Done'}
              </button>
              {result?.noteId && (
                <button
                  type="button"
                  className="primary"
                  onClick={() => {
                    onOpen(result.noteId!)
                    onClose()
                  }}
                >
                  Open
                </button>
              )}
            </div>
          </>
        )}
      </form>
    </div>,
    document.body,
  )
}
