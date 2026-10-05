import { Capacitor, registerPlugin } from '@capacitor/core'
import type { Editor } from '@tiptap/core'
import { getTranscripts, noteDocName, wordsKey } from '@reconnotes/core'
import { recognizeImageOnDevice, recognizeImageWords, useDeviceOcr } from './deviceOcr'
import { sync } from './sync'
import { insertFiles } from '../editor/nodes'

interface DocumentScannerPlugin {
  scan(): Promise<{ pages: string[]; title?: string }>
}
const DocumentScanner = registerPlugin<DocumentScannerPlugin>('DocumentScanner')

/** Apple's document scanner is there (iPhone/iPad app). */
export function scannerAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('DocumentScanner')
}

/** Scan pages with the camera: cropped, straightened JPEGs (none if cancelled). */
export async function scanDocument(): Promise<File[]> {
  const { pages, title } = await DocumentScanner.scan()
  const name = (title || 'Scan').replace(/[\\/:*?"<>|]/g, '-')
  return pages.map((b64, i) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    return new File([bytes], pages.length > 1 ? `${name} – page ${i + 1}.jpg` : `${name}.jpg`, { type: 'image/jpeg' })
  })
}

/**
 * Scan pages into a note. Each page becomes a picture; on the device its
 * text is read right away (Apple Vision), so the scan is searchable – words
 * highlighted – even with no server.
 */
export async function scanIntoNote(editor: Editor, noteId: string) {
  const files = await scanDocument()
  if (!files.length) return
  const ids = await insertFiles(editor, files)
  if (!useDeviceOcr()) return
  const { handle, close } = sync.open(noteDocName(noteId))
  try {
    await handle.loaded
    for (let i = 0; i < ids.length; i++) {
      try {
        const text = (await recognizeImageOnDevice(files[i])).trim()
        const words = await recognizeImageWords(files[i])
        const tr = getTranscripts(handle.doc)
        handle.doc.transact(() => {
          if (text && !tr.get(`att:${ids[i]}`)) tr.set(`att:${ids[i]}`, text)
          tr.set(wordsKey(ids[i]), JSON.stringify(words))
        })
      } catch {
        /* the server can still read it */
      }
    }
  } finally {
    close()
  }
}
