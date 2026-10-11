import fs from 'node:fs'
import { newId } from '@reconnotes/core'
import type { Store } from './store'
import type { Ai } from './ai'
import { reportProgress } from './jobs'
import { rotatePicture, textRunsSideways, textUpsideDown, upAndDown } from './images'
import { tesseractLines } from './printReader'
import type { PhotoPage } from './photoRecipe'

/**
 * Photos turned the right way up, here
 * ====================================
 *
 * On the iPhone and iPad, photos are straightened before they're sent (Apple's text recognition says
 * which way the words run). In a browser nothing can tell, so the server does it for the photos it
 * reads itself: whether the text runs up or down the page (textRunsSideways), then which way round
 * – both from the letters' shapes: in print, far more letters reach up above a line than hang below
 * it (upAndDown); only when that can't tell are a few lines read each way round by the AI (which can
 * read upside-down print, so it's the fallback, not the judge). A level page upside down is turned
 * too. The turned photo becomes the page's picture (in the note too); the original is left as it
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
    const sideways = textRunsSideways(data, att.mime)
    let best: { data: Buffer; mime: string } | null = null
    if (sideways) {
      reportProgress(`Turning photo ${k + 1} the right way up…`)
      // which way round: from the letters (more reach up above a line than hang below it)…
      const cw = await rotatePicture(data, att.mime, 1)
      const c = cw ? upAndDown(cw.data, cw.mime) : null
      if (cw && c && c.up > c.down * 1.15) best = cw
      else if (c && c.down > c.up * 1.15) best = await rotatePicture(data, att.mime, 3)
      else {
        // …or, when they can't tell: which way round Tesseract reads with more certainty (where it's installed)…
        const ccw = await rotatePicture(data, att.mime, 3)
        const sure = async (x: { data: Buffer; mime: string } | null) => {
          const lines = x ? await tesseractLines(x.data, x.mime) : null
          return lines?.length ? lines.reduce((s, l) => s + l.conf * l.text.length, 0) / Math.max(1, lines.reduce((s, l) => s + l.text.length, 0)) : null
        }
        const [a, b] = [await sure(cw), await sure(ccw)]
        if (a !== null && b !== null && Math.abs(a - b) >= 5) best = a > b ? cw : ccw
      }
      if (sideways && !best) {
        // …or a few lines read each way round by the AI
        const cw = await rotatePicture(data, att.mime, 1)
        let score = -1
        for (const q of [1, 3]) {
          const turned = q === 1 ? cw : await rotatePicture(data, att.mime, q)
          if (!turned) continue
          const sc = readability(await ai.readSnippet(turned.data, turned.mime).catch(() => ''))
          if (sc > score) (score = sc), (best = turned)
        }
        if (score < 3) best = null
      }
    } else if (textUpsideDown(data, att.mime)) {
      // level, but upside down
      reportProgress(`Turning photo ${k + 1} the right way up…`)
      best = await rotatePicture(data, att.mime, 2)
    }
    if (!best) {
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
