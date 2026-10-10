import { encodeWordTimes, parseWordTimes } from '@reconnotes/core'
import type { Store } from './store'
import type { SyncEngine } from './sync'
import type { Vocabulary } from './vocabulary'
import { groupOfAttachment, setWordTimes, wordTimes } from './attachments'
import { heardPattern as pattern, replaceHeard } from './vocabulary'

export { replaceHeard }

/**
 * Correcting what speech-to-text misheard
 * =======================================
 *
 * You fix a word in a recording's transcript once ("Summet" → "Summit"): it's
 * fixed there – and in every other recording that has it, if you like – and
 * remembered, so new transcripts come out fixed too, and Whisper is told the
 * right spelling.
 */

/** The same fix in the word times (one word for one word: the times stay with it). */
function fixTimes(json: string | null, from: string, to: string): string | null {
  const words = parseWordTimes(json)
  if (!words || /\s/.test(from.trim()) || /\s/.test(to.trim())) return json
  const re = pattern(from)
  let changed = false
  const out = words.map((w) => {
    re.lastIndex = 0
    const fixed = w.word.replace(re, () => to)
    if (fixed !== w.word) changed = true
    return { ...w, word: fixed }
  })
  return changed ? encodeWordTimes(out) : json
}

/**
 * Fix `from` → `to` in a recording's transcript, or in every recording's (`everywhere`); learn it.
 * The number of recordings changed.
 */
export function fixTranscripts(
  store: Store,
  sync: SyncEngine,
  vocab: Vocabulary | null,
  opts: { attachmentId: string; from: string; to: string; everywhere: boolean },
): { recordings: number; places: number } {
  // "every recording": every recording in the same group (top-level folder) – not another group's
  const group = groupOfAttachment(store, sync, opts.attachmentId)
  const ids = opts.everywhere
    ? (store.db.prepare("SELECT id FROM attachments WHERE text IS NOT NULL AND text_status = 'done' AND (mime LIKE 'audio/%' OR mime LIKE 'video/%' OR id = ?)").all(opts.attachmentId) as { id: string }[])
        .map((r) => r.id)
        .filter((id) => id === opts.attachmentId || groupOfAttachment(store, sync, id) === group)
    : [opts.attachmentId]
  let recordings = 0
  let places = 0
  for (const id of ids) {
    const att = store.getAttachment(id)
    if (!att?.text) continue
    const r = replaceHeard(att.text, opts.from, opts.to)
    if (!r.count) continue
    store.setAttachmentText(id, r.text, 'done')
    const times = wordTimes(store, id)
    const fixed = fixTimes(times, opts.from, opts.to)
    if (fixed !== times) setWordTimes(store, id, parseWordTimes(fixed))
    sync.reindexNotesFor(id)
    recordings++
    places += r.count
  }
  vocab?.learn(opts.from.trim(), opts.to.trim(), true, group)
  return { recordings, places }
}
