import { useEffect, useState } from 'react'
import { CheckCircle2, CloudUpload, Loader2, XCircle } from 'lucide-react'
import { api } from '../lib/api'

interface Offsite {
  kind: 'off' | 'folder' | 's3'
  folder: string
  s3: { endpoint: string; region: string; bucket: string; prefix: string; accessKeyId: string; secretAccessKey: string }
  passphrase: string
  keep: number
  hasSecret: boolean
  hasPassphrase: boolean
  status: { at: number; ok: boolean; message: string } | null
}

/**
 * Settings › Backups › Offsite copy: after each backup, a copy on another
 * disk (NAS, USB) or in S3-compatible storage (Backblaze B2, Wasabi, R2…),
 * optionally encrypted with a passphrase.
 */
export function OffsiteSection() {
  const [s, setS] = useState<Offsite | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    void api<Offsite>('GET', '/api/offsite').then(setS).catch(() => {})
  }, [])
  if (!s) return null
  const set = (patch: Partial<Offsite>) => setS({ ...s, ...patch })
  const set3 = (patch: Partial<Offsite['s3']>) => setS({ ...s, s3: { ...s.s3, ...patch } })

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what)
    setResult(null)
    try {
      await fn()
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }
  const save = () => run('save', async () => setS(await api<Offsite>('PUT', '/api/offsite', s)))
  const test = () =>
    run('test', async () => {
      const r = await api<{ ok: boolean; error?: string }>('POST', '/api/offsite/test', s)
      setResult(r.ok ? { ok: true, text: 'It works – ReconNotes can write there.' } : { ok: false, text: r.error ?? 'It didn’t work.' })
    })
  const copyNow = () =>
    run('copy', async () => {
      const saved = await api<Offsite>('PUT', '/api/offsite', s)
      const r = await api<{ ok: boolean; message: string }>('POST', '/api/offsite/run')
      setS({ ...saved, status: { ...r, at: Date.now() } })
    })

  return (
    <div className="offsite">
      <h4>
        <CloudUpload size={16} /> Offsite copy
      </h4>
      <p className="hint">After each backup, a copy somewhere else – so a dead disk (or a fire) doesn’t take your notes with it. Attachments are sent once.</p>
      <div className="segmented" role="tablist">
        {(['off', 'folder', 's3'] as const).map((k) => (
          <button key={k} className={s.kind === k ? 'on' : ''} onClick={() => set({ kind: k })} role="tab" aria-selected={s.kind === k}>
            {k === 'off' ? 'Off' : k === 'folder' ? 'Another disk' : 'Cloud (S3)'}
          </button>
        ))}
      </div>
      {s.kind === 'folder' && (
        <label>
          Folder on the server
          <input value={s.folder} placeholder="/mnt/nas/reconnotes" onChange={(e) => set({ folder: e.target.value })} />
          <span className="hint">A NAS share or USB drive mounted on the server (the server needs permission to write there).</span>
        </label>
      )}
      {s.kind === 's3' && (
        <>
          <label>
            Endpoint
            <input value={s.s3.endpoint} placeholder="https://s3.us-west-004.backblazeb2.com" onChange={(e) => set3({ endpoint: e.target.value })} />
          </label>
          <div className="row">
            <label>
              Bucket
              <input value={s.s3.bucket} onChange={(e) => set3({ bucket: e.target.value })} />
            </label>
            <label>
              Region
              <input value={s.s3.region} placeholder="us-east-1 (R2: auto)" onChange={(e) => set3({ region: e.target.value })} />
            </label>
          </div>
          <label>
            Folder in the bucket
            <input value={s.s3.prefix} placeholder="reconnotes" onChange={(e) => set3({ prefix: e.target.value })} />
          </label>
          <label>
            Access key ID
            <input value={s.s3.accessKeyId} autoComplete="off" onChange={(e) => set3({ accessKeyId: e.target.value })} />
          </label>
          <label>
            Secret access key
            <input type="password" value={s.s3.secretAccessKey} placeholder={s.hasSecret ? '•••••••• (saved – type to replace)' : ''} autoComplete="off" onChange={(e) => set3({ secretAccessKey: e.target.value })} />
          </label>
          <p className="hint">Backblaze B2, Wasabi, Cloudflare R2, MinIO and AWS S3 all work. Use a key that can only write to this bucket.</p>
        </>
      )}
      {s.kind !== 'off' && (
        <>
          <label>
            Encryption passphrase {s.hasPassphrase && <span className="muted">(set)</span>}
            <input type="password" value={s.passphrase} placeholder={s.hasPassphrase ? '•••••••• (saved – type to change)' : 'Optional – recommended for the cloud'} autoComplete="new-password" onChange={(e) => set({ passphrase: e.target.value })} />
            <span className="hint">
              Encrypts the copy (AES-256). Keep it safe: without it the copy can’t be opened. To open one: <code>RECON_BACKUP_PASSPHRASE=… reconnotes-server decrypt &lt;folder&gt;</code>
            </span>
          </label>
          <label>
            Copies to keep
            <input type="number" min={1} max={365} value={s.keep} onChange={(e) => set({ keep: Number(e.target.value) || 1 })} />
          </label>
        </>
      )}
      <div className="row">
        <button className="primary" onClick={() => void save()} disabled={busy !== null}>
          {busy === 'save' && <Loader2 size={15} className="spin" />} Save
        </button>
        {s.kind !== 'off' && (
          <>
            <button onClick={() => void test()} disabled={busy !== null}>
              {busy === 'test' && <Loader2 size={15} className="spin" />} Test
            </button>
            <button onClick={() => void copyNow()} disabled={busy !== null}>
              {busy === 'copy' && <Loader2 size={15} className="spin" />} Copy the latest backup now
            </button>
          </>
        )}
      </div>
      {result && <p className={result.ok ? 'status' : 'error-text'}>{result.text}</p>}
      {s.status && s.kind !== 'off' && (
        <p className={s.status.ok ? 'hint' : 'error-text'}>
          {s.status.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />} Last copy {new Date(s.status.at).toLocaleString()}: {s.status.message}
        </p>
      )}
    </div>
  )
}
