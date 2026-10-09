import type { Store } from './store'

/**
 * Recognising voices across recordings
 * ====================================
 *
 * The speaker-label service (deploy/diarize.py) sends what each voice in a
 * recording sounds like: a voice embedding, 192 numbers. When you name a voice
 * ("Speaker 2" → Jesse), its embedding is kept under that name. In the next
 * recording, each voice is compared with the names kept: one that sounds
 * clearly like someone you've named gets their name straight away.
 *
 * Measured with the TitaNet model the service uses: the same person in two
 * clips of a test recording scored 0.6–0.7, different people 0.1–0.35 – but in
 * a real meeting, everyone recorded on one phone in one room, different
 * people's voices scored as high as 0.84. So a name is given only at 0.7 or
 * more, and only when it's clearly (0.1) ahead of anyone else's.
 */

/** a recording's voices: speaker number → embedding */
export type Voices = Record<number, number[]>

interface Sample {
  att: string
  speaker: number
  vec: number[]
  at: number
}

const PRINTS = 'voiceprints'
/** the last few recordings a person was named in: their voice as it sounds lately */
const SAMPLES_PER_NAME = 12
export const MATCH = 0.7
const MARGIN = 0.1

const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0)
const unit = (v: number[]) => {
  const n = Math.sqrt(dot(v, v))
  return n > 0 ? v.map((x) => x / n) : v
}

export function setRecordingVoices(store: Store, attachmentId: string, voices: Voices | null) {
  store.setSetting(`voices:${attachmentId}`, voices && Object.keys(voices).length ? voices : null)
}
export function recordingVoices(store: Store, attachmentId: string): Voices | null {
  return store.getSetting<Voices | null>(`voices:${attachmentId}`) ?? null
}

const prints = (store: Store) => store.getSetting<Record<string, Sample[]>>(PRINTS) ?? {}

/**
 * You named (or renamed, or un-named) a voice in a recording: that's who it sounds like. A voice
 * named wrongly before is taken back from that name.
 */
export function learnVoice(store: Store, attachmentId: string, speaker: number, name: string): boolean {
  const all = prints(store)
  for (const n of Object.keys(all)) {
    all[n] = all[n].filter((s) => !(s.att === attachmentId && s.speaker === speaker))
    if (!all[n].length) delete all[n]
  }
  const vec = recordingVoices(store, attachmentId)?.[speaker]
  const who = name.trim()
  if (vec && who && !/^speaker \d+$/i.test(who)) {
    all[who] = [{ att: attachmentId, speaker, vec, at: Date.now() }, ...(all[who] ?? [])].slice(0, SAMPLES_PER_NAME)
  }
  store.setSetting(PRINTS, all)
  return Boolean(vec && who)
}

/** The people a recording's voices sound like: speaker number → name (each name once). */
export function recogniseVoices(store: Store, voices: Voices): Record<number, string> {
  const people = Object.entries(prints(store)).map(([name, samples]) => {
    // their voice: the average of how they've sounded
    const sum = samples[0].vec.map((_, i) => samples.reduce((s, x) => s + (x.vec[i] ?? 0), 0))
    return { name, vec: unit(sum) }
  })
  if (!people.length) return {}
  const pairs: { speaker: number; name: string; score: number }[] = []
  for (const [k, v] of Object.entries(voices)) {
    const scores = people.map((p) => ({ name: p.name, score: dot(unit(v), p.vec) })).sort((a, b) => b.score - a.score)
    const [best, next] = scores
    // clearly them: close enough, and nobody else nearly as close
    if (best.score >= MATCH && (!next || best.score - next.score >= MARGIN)) pairs.push({ speaker: Number(k), name: best.name, score: best.score })
  }
  // the most certain first; a name (and a voice) only once
  const out: Record<number, string> = {}
  const used = new Set<string>()
  for (const p of pairs.sort((a, b) => b.score - a.score)) {
    if (used.has(p.name) || out[p.speaker] !== undefined) continue
    out[p.speaker] = p.name
    used.add(p.name)
  }
  return out
}

/** The people whose voices are known, with how many recordings each was named in. */
export function knownVoices(store: Store): { name: string; recordings: number }[] {
  return Object.entries(prints(store))
    .map(([name, s]) => ({ name, recordings: s.length }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Forget someone's voice (it's no longer recognised; names already given stay). */
export function forgetVoice(store: Store, name: string) {
  const all = prints(store)
  delete all[name]
  store.setSetting(PRINTS, all)
}

/**
 * The names last seen for a recording's voices – yours, or given when recognised – so that
 * only a change you make is learned (a name the server gave isn't proof of itself).
 */
export function seenNames(store: Store, attachmentId: string): Record<string, string> {
  return store.getSetting<Record<string, string>>(`voiceNames:${attachmentId}`) ?? {}
}
export function setSeenNames(store: Store, attachmentId: string, names: Record<string, string>) {
  store.setSetting(`voiceNames:${attachmentId}`, names)
}
