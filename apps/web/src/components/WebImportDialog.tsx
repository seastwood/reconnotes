import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BookOpen, Camera, ChefHat, Globe, Loader2, PenLine, Plus, RotateCw, ScanLine, Signpost, X, type LucideIcon } from 'lucide-react'
import { isFinished, submitJob, useJobs, watchingJob } from '../lib/jobs'
import { safeLocalGet, safeLocalSet } from '../lib/store'
import { isSyncConfigured } from '../lib/settings'
import { addAttachment, flushUploads } from '../lib/attachments'
import { preferServerOcr, recognizeImageOnDevice, useDeviceOcr } from '../lib/deviceOcr'
import { scanDocument, scannerAvailable } from '../lib/scanner'
import { rotateImage, uprightPhoto } from '../lib/rotate'

export type ImportTab = 'web' | 'photos'
export type PhotoKind = 'recipe' | 'handwriting' | 'printed' | 'directions'

/** What photos of pages can be, and what each becomes. */
const PHOTO_KINDS: { kind: PhotoKind; icon: LucideIcon; label: string; examples: string; becomes: string }[] = [
  {
    kind: 'recipe',
    icon: ChefHat,
    label: 'Recipe',
    examples: 'A meal-kit card, a cookbook page',
    becomes: 'Set out like a recipe from a website: servings and times, the ingredients to tick off, the steps numbered – and cook mode. The first photo is the recipe’s picture.',
  },
  {
    kind: 'handwriting',
    icon: PenLine,
    label: 'Handwriting',
    examples: 'Notes, a notebook, a letter',
    becomes: 'Your writing read and laid out – headings, lists and checkboxes where you wrote them.',
  },
  {
    kind: 'printed',
    icon: BookOpen,
    label: 'Printed page',
    examples: 'A book, a magazine, a manual',
    becomes: 'The text as printed, its lines joined back into paragraphs – page numbers and running headers left out.',
  },
  {
    kind: 'directions',
    icon: Signpost,
    label: 'Directions',
    examples: 'A trail guide, a route, instructions',
    becomes: 'The directions as numbered steps, in order across the pages – every distance, landmark and warning kept.',
  },
]

/**
 * Import a web page: a guide, manual or article becomes a note – its text,
 * headings, lists, tables, code, links and every picture – or, with "the
 * rest of the guide", one note per page in a folder of its own. A PDF is
 * one note too, unless it's asked to be split at its chapters. The server
 * does the work (as a job), so it carries on if this is closed.
 *
 * Or photos of pages (the second tab), as what they are: a recipe, handwriting,
 * a printed page, directions – each set out its own way.
 */
export function WebImportDialog({
  folderId,
  onClose,
  onOpen,
  initialUrl = '',
  startOn,
}: {
  folderId: string | null
  onClose: () => void
  onOpen: (noteId: string) => void
  initialUrl?: string
  /** open on this tab (and, for photos, this kind) instead of the one used last */
  startOn?: { tab: ImportTab; kind?: PhotoKind }
}) {
  // the tab and the kind of photos: as last time, unless asked for
  const [tab, setTabState] = useState<ImportTab>(() => startOn?.tab ?? (initialUrl ? 'web' : safeLocalGet<ImportTab>('reconnotes.importTab', 'web')))
  const setTab = (t: ImportTab) => (setTabState(t), safeLocalSet('reconnotes.importTab', t))
  const [kind, setKindState] = useState<PhotoKind>(() => startOn?.kind ?? safeLocalGet<PhotoKind>('reconnotes.importPhotoKind', 'recipe'))
  const setKind = (k: PhotoKind) => (setKindState(k), safeLocalSet('reconnotes.importPhotoKind', k))
  const kindInfo = PHOTO_KINDS.find((k) => k.kind === kind) ?? PHOTO_KINDS[0]
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

  // a recipe on paper (a meal-kit card's front and back, cookbook pages): photos of it, in page order
  // each photo as it'll be sent: turned the right way up (automatically where this device can read it,
  // or with its ↻ button), and what was read in it that way round
  const MAX_PHOTOS = kind === 'recipe' ? 12 : 30
  type Photo = { key: number; name: string; blob: Blob; url: string; text?: string; turning?: boolean }
  const [photos, setPhotos] = useState<Photo[]>([])
  const nextKey = useRef(0)
  const photoInput = useRef<HTMLInputElement>(null)
  const update = (key: number, patch: Partial<Photo>) => setPhotos((all) => all.map((p) => (p.key === key ? { ...p, ...patch } : p)))
  const addPhotos = (files: File[]) => {
    const added: Photo[] = files
      .filter((f) => f.type.startsWith('image/'))
      .map((f) => ({ key: nextKey.current++, name: f.name, blob: f, url: URL.createObjectURL(f), turning: true }))
    setPhotos((p) => [...p, ...added].slice(0, MAX_PHOTOS))
    // the right way up: read every way round on this device (where it can), the best kept
    for (const p of added)
      void uprightPhoto(p.blob)
        .then((up) => update(p.key, up ? { blob: up.blob, url: up.quarters ? URL.createObjectURL(up.blob) : p.url, text: up.text, turning: false } : { turning: false }))
        .catch(() => update(p.key, { turning: false }))
  }
  const turn = async (p: Photo) => {
    update(p.key, { turning: true })
    try {
      const blob = await rotateImage(p.blob, 1)
      update(p.key, { blob, url: URL.createObjectURL(blob), text: undefined, turning: false })
    } catch {
      update(p.key, { turning: false })
    }
  }
  // the previews let go when the dialog closes
  const previews = useRef<string[]>([])
  previews.current = photos.map((p) => p.url)
  useEffect(() => () => previews.current.forEach((u) => URL.revokeObjectURL(u)), [])
  const [reading, setReading] = useState(false)
  const startPhotos = async () => {
    setError(null)
    setReading(true)
    try {
      const pages: { attachmentId: string; text?: string }[] = []
      for (const p of photos) {
        // (turned: a new picture, named for its kind)
        const name = p.blob instanceof File ? p.name : p.name.replace(/\.\w+$/, '') + (p.blob.type === 'image/png' ? '.png' : '.jpg')
        const attachmentId = await addAttachment(p.blob, name)
        // read on this device where it can (Apple's text recognition: quick, and very good at print) – already, when it was turned upright
        // (handwriting, when your server's readers are set to go first: read there)
        const device = useDeviceOcr() && !(kind === 'handwriting' && preferServerOcr())
        const text = device ? (p.text ?? (await recognizeImageOnDevice(p.blob).catch(() => ''))) : ''
        pages.push({ attachmentId, ...(text.trim() ? { text } : {}) })
      }
      await flushUploads()
      const j =
        kind === 'recipe'
          ? await submitJob({ kind: 'recipe-photos', title: 'Recipe from photos', input: { photos: pages, folderId } })
          : await submitJob({ kind: 'photo-pages', title: `${kindInfo.label} from photos`, input: { photos: pages, kind, folderId } })
      setJobId(j.id)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setReading(false)
    }
  }

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
  const result =
    job?.status === 'done'
      ? (job.result as { noteId?: string; pages?: number; pictures?: number; notes?: string[]; title?: string; left?: string[]; unsure?: number; asRead?: boolean } | null)
      : null
  const fromPhotos = job?.kind === 'recipe-photos' || job?.kind === 'photo-pages'
  const busy = Boolean(job && !isFinished(job))

  return createPortal(
    <div className="dialog-backdrop" onClick={onClose}>
      <form
        className="dialog web-import-dialog"
        role="dialog"
        aria-label="Import"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          if (!jobId && tab === 'web') void start()
        }}
      >
        <h2>
          {tab === 'web' ? <Globe size={18} /> : <Camera size={18} />} Import
        </h2>
        {!isSyncConfigured() ? (
          <p className="hint">Importing is done by your ReconNotes server – connect one in Settings.</p>
        ) : !jobId ? (
          <>
            <div className="import-tabs" role="tablist" aria-label="What to import">
              <button type="button" role="tab" aria-selected={tab === 'web'} className={tab === 'web' ? 'on' : ''} onClick={() => setTab('web')}>
                <Globe size={15} /> Web page or PDF
              </button>
              <button type="button" role="tab" aria-selected={tab === 'photos'} className={tab === 'photos' ? 'on' : ''} onClick={() => setTab('photos')}>
                <Camera size={15} /> Photos of pages
              </button>
            </div>
            {tab === 'web' ? (
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
            <div className="photo-kinds" role="radiogroup" aria-label="What’s in the photos?">
              {PHOTO_KINDS.map(({ kind: k, icon: Icon, label, examples }) => (
                <button key={k} type="button" role="radio" aria-checked={kind === k} className={`photo-kind${kind === k ? ' on' : ''}`} onClick={() => setKind(k)}>
                  <Icon size={20} aria-hidden />
                  <strong>{label}</strong>
                  <span>{examples}</span>
                </button>
              ))}
            </div>
            <p className="hint">{kindInfo.becomes}</p>
            <input
              ref={photoInput}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                addPhotos(Array.from(e.target.files ?? []))
                e.target.value = ''
              }}
            />
            {photos.length === 0 ? (
              <div className="photo-pick">
                <button type="button" onClick={() => photoInput.current?.click()}>
                  <Camera size={16} /> Choose photos
                </button>
                {scannerAvailable() && (
                  <button type="button" onClick={() => void scanDocument().then(addPhotos).catch(() => {})}>
                    <ScanLine size={16} /> Scan pages
                  </button>
                )}
              </div>
            ) : (
              <>
                <div className="photo-pages">
                  {photos.map((p, i) => (
                    <figure key={p.key}>
                      <img src={p.url} alt={`Page ${i + 1}`} />
                      <figcaption>{p.turning ? 'Straightening…' : `Page ${i + 1}`}</figcaption>
                      <button type="button" className="icon photo-remove" aria-label={`Remove page ${i + 1}`} onClick={() => setPhotos((all) => all.filter((x) => x.key !== p.key))}>
                        <X size={14} />
                      </button>
                      <button type="button" className="icon photo-turn" aria-label={`Turn page ${i + 1} a quarter`} title="Turn it the right way up" disabled={p.turning} onClick={() => void turn(p)}>
                        {p.turning ? <Loader2 size={14} className="spin" /> : <RotateCw size={14} />}
                      </button>
                    </figure>
                  ))}
                  {photos.length < MAX_PHOTOS && (
                    <button type="button" className="photo-add" onClick={() => photoInput.current?.click()} aria-label="Add more photos">
                      <Plus size={22} />
                    </button>
                  )}
                </div>
                <p className="hint">
                  In page order, the right way up (↻ turns one). Nothing is made up: the words are kept as they were read
                  {kind === 'recipe' ? ', and an amount the AI isn’t sure of is marked to check' : ' – if the AI’s layout changes them, the text is kept as read'}. The photos are kept in the note.
                </p>
              </>
            )}
            {error && <p className="error-text">{error}</p>}
            <div className="row">
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="primary" disabled={!photos.length || reading || photos.some((p) => p.turning)} onClick={() => void startPhotos()}>
                {reading ? <Loader2 size={15} className="spin" /> : <kindInfo.icon size={15} />} {kind === 'recipe' ? 'Make the recipe' : 'Make the note'}
              </button>
            </div>
            </>
            )}
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
            {result && fromPhotos && (
              <>
                <p>
                  ✅ {result.title ?? (job?.kind === 'recipe-photos' ? 'The recipe' : 'The note')} – {job?.kind === 'recipe-photos' ? 'set out' : 'made'} from {photos.length || 'the'} photo
                  {photos.length === 1 ? '' : 's'}.
                </p>
                {result.asRead && <p className="hint">Kept as it was read: the AI’s layout changed some of the words, so it wasn’t used.</p>}
                {!!result.unsure && (
                  <p className="hint">
                    {result.unsure} amount{result.unsure === 1 ? '' : 's'} weren’t found in what was read: they’re underlined with dots – check them against the photos.
                  </p>
                )}
                {!!result.left?.length && (
                  <ul className="hint web-import-notes">
                    <li>Left out – not found in what was read:</li>
                    {result.left.slice(0, 8).map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
            {result && !fromPhotos && (
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
