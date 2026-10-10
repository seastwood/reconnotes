import fs from 'node:fs'
import { newId } from '@reconnotes/core'
import type { Store } from './store'
import type { Ai } from './ai'
import { reportProgress } from './jobs'
import { rotatePicture, textRunsSideways } from './images'
import type { PhotoPage } from './photoRecipe'

/**
 * Photos turned the right way up, here
 * ====================================
 *
 * On the iPhone and iPad, photos are straightened before they're sent (Apple's text recognition says
 * which way the words run). In a browser nothing can tell, so the server does it for the photos it
 * reads itself: whether the text runs up or down the page (textRunsSideways, from the letters'
 * shapes), then which way round it reads – a few lines read each way, the one that reads as words
 * kept. The turned photo becomes the page's picture (in the note too); the original is left as it
 * was. A photo already the right way up, or that can't be told, is read as it is.
 */

/** How much a reading looks like real text: its words of three letters or more, with a vowel. */
export const readability = (text: string) => (text.match(/\b[A-Za-z]{3,}\b/g) ?? []).filter((w) => /[aeiouy]/i.test(w)).length

export async function uprightPages(store: Store, ai: Ai, pages: PhotoPage[]): Promise<PhotoPage[]> {
  const out: PhotoPage[] = []
  for (const [k, p] of pages.entries()) {
    // read on the phone: already turned the right way up there
    if ((p.text ?? '').trim().length >= 20) {
      out.push(p)
      continue
    }
    const att = store.getAttachment(p.attachmentId)
    if (!att || !store.hasBlob(att.id) || !/^image\//.test(att.mime)) {
      out.push(p)
      continue
    }
    const data = fs.readFileSync(store.blobPath(att.id))
    if (!textRunsSideways(data, att.mime)) {
      out.push(p)
      continue
    }
    reportProgress(`Turning photo ${k + 1} the right way up…`)
    let best: { data: Buffer; mime: string; score: number } | null = null
    for (const q of [1, 3]) {
      const turned = await rotatePicture(data, att.mime, q)
      if (!turned) continue
      const score = readability(await ai.readSnippet(turned.data, turned.mime).catch(() => ''))
      if (!best || score > best.score) best = { ...turned, score }
    }
    if (!best || best.score < 3) {
      out.push(p)
      continue
    }
    const id = newId()
    const name = att.name.replace(/\.\w+$/, '') + (best.mime === 'image/png' ? '.png' : '.jpg')
    store.putAttachment({ id, mime: best.mime, name, size: best.data.length, created_at: Date.now() }, best.data, 'skipped')
    out.push({ ...p, attachmentId: id })
  }
  return out
}
