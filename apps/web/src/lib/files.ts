import * as Y from 'yjs'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { createNote, getContent, noteDocName, updateNote } from '@reconnotes/core'
import { addAttachment, attachmentBlob } from './attachments'
import { sync } from './sync'

/**
 * Files of any kind: kept as attachments (synced and backed up like
 * pictures), shown as cards in notes, and openable – Quick Look in the iOS
 * app (PDF, Word, Excel, Pages, Numbers, Keynote, text…), a new tab on the web.
 */

interface FilePreviewPlugin {
  open(options: { data: string; name: string }): Promise<void>
  share(options: { data: string; name: string }): Promise<void>
}
const FilePreview = registerPlugin<FilePreviewPlugin>('FilePreview')
const native = () => Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('FilePreview')

export function formatSize(bytes: number): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

/** "PDF", "Word", "Spreadsheet"… from the name and type. */
export function fileKind(name: string, mime: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (mime === 'application/pdf' || ext === 'pdf') return 'PDF'
  if (/docx?|odt|rtf|pages/.test(ext)) return 'Document'
  if (/xlsx?|ods|csv|numbers/.test(ext)) return 'Spreadsheet'
  if (/pptx?|odp|key/.test(ext)) return 'Presentation'
  if (/zip|rar|7z|tar|gz/.test(ext)) return 'Archive'
  if (mime.startsWith('image/')) return 'Picture'
  if (mime.startsWith('audio/')) return 'Audio'
  if (mime.startsWith('video/')) return 'Video'
  if (mime.startsWith('text/') || /txt|md|json|xml|log/.test(ext)) return 'Text'
  return ext ? ext.toUpperCase() : 'File'
}

async function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

async function blobOf(attachmentId: string): Promise<Blob> {
  const blob = await attachmentBlob(attachmentId)
  if (!blob) throw new Error('This file hasn’t been downloaded to this device yet – try again when online.')
  return blob
}

/** Show the file: Quick Look in the iOS app, a new tab on the web. */
export async function openFile(attachmentId: string, name: string, mime: string) {
  const blob = await blobOf(attachmentId)
  if (native()) return FilePreview.open({ data: await base64(blob), name: name || 'File' })
  const url = URL.createObjectURL(new File([blob], name || 'file', { type: mime || blob.type }))
  const w = window.open(url, '_blank')
  if (!w) {
    // pop-up blocked: download instead
    const a = document.createElement('a')
    a.href = url
    a.download = name || 'file'
    a.click()
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** Share / save the file: the share sheet in the iOS app, a download on the web. */
export async function shareFile(attachmentId: string, name: string) {
  return saveBlob(await blobOf(attachmentId), name)
}

/** Save any data as a file: the share sheet (Save to Files, AirDrop…) in the iOS app, a download on the web. */
export async function saveBlob(blob: Blob, name: string) {
  if (native()) return FilePreview.share({ data: await base64(blob), name: name || 'File' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name || 'file'
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** Add files straight into a folder: each becomes an item (a note holding the file). Returns the new ids. */
export async function addFilesToFolder(files: File[], folderId: string | null): Promise<string[]> {
  const ids: string[] = []
  for (const f of files) {
    const attachmentId = await addAttachment(f, f.name)
    const mime = f.type || 'application/octet-stream'
    const id = createNote(sync.workspace.doc, { folderId, title: f.name })
    updateNote(sync.workspace.doc, id, { file: { name: f.name, mime, size: f.size } })
    const title = new Y.XmlElement('paragraph')
    title.insert(0, [new Y.XmlText(f.name)])
    const kind = mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio' : 'file'
    const el = new Y.XmlElement(kind)
    el.setAttribute('attachmentId', attachmentId)
    if (kind === 'image') el.setAttribute('alt', f.name.replace(/\.[^.]+$/, ''))
    else el.setAttribute('name', f.name)
    if (kind === 'file') {
      el.setAttribute('mime', mime)
      el.setAttribute('size', f.size as unknown as string)
    }
    const { handle, close } = sync.open(noteDocName(id))
    try {
      await handle.loaded
      getContent(handle.doc).insert(0, [title, el, new Y.XmlElement('paragraph')])
    } finally {
      close()
    }
    ids.push(id)
  }
  return ids
}
