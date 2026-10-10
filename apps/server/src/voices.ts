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
  /** the group (top-level folder) the recording was in: voices are only recognised within it */
  group?: string
}

/** a recording's group (its note's top-level folder; '' outside any): for samples kept before groups */
export type GroupOf = (attachmentId: string) => string
const groupOfSample = (s: Sample, groupOf: GroupOf) => s.group ?? groupOf(s.att)

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
export function learnVoice(store: Store, attachmentId: string, speaker: number, name: string, group = ''): boolean {
  const all = prints(store)
  for (const n of Object.keys(all)) {
    all[n] = all[n].filter((s) => !(s.att === attachmentId && s.speaker === speaker))
    if (!all[n].length) delete all[n]
  }
  const vec = recordingVoices(store, attachmentId)?.[speaker]
  const who = name.trim()
  if (vec && who && !/^speaker \d+$/i.test(who)) {
    const mine = (all[who] ?? []).filter((x) => (x.group ?? '') === group || x.group === undefined)
    const others = (all[who] ?? []).filter((x) => !mine.includes(x))
    all[who] = [{ att: attachmentId, speaker, vec, at: Date.now(), group }, ...mine].slice(0, SAMPLES_PER_NAME).concat(others)
  }
  store.setSetting(PRINTS, all)
  return Boolean(vec && who)
}

/**
 * The people a recording's voices sound like: speaker number → name (each name once) – only people
 * named in the same group (a work folder's voices are never looked for in a robotics folder).
 */
export function recogniseVoices(store: Store, voices: Voices, group = '', groupOf: GroupOf = () => ''): Record<number, string> {
  const people = Object.entries(prints(store)).flatMap(([name, all]) => {
    const samples = all.filter((x) => groupOfSample(x, groupOf) === group)
    if (!samples.length) return []
    // their voice: the average of how they've sounded
    const sum = samples[0].vec.map((_, i) => samples.reduce((s, x) => s + (x.vec[i] ?? 0), 0))
    return [{ name, vec: unit(sum) }]
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

/** The people whose voices are known – per group – with how many recordings each was named in. */
export function knownVoices(store: Store, groupOf: GroupOf = () => '', only?: string): { name: string; group: string; recordings: number }[] {
  const out: { name: string; group: string; recordings: number }[] = []
  for (const [name, samples] of Object.entries(prints(store))) {
    const by = new Map<string, number>()
    for (const x of samples) by.set(groupOfSample(x, groupOf), (by.get(groupOfSample(x, groupOf)) ?? 0) + 1)
    for (const [group, recordings] of by) if (only === undefined || group === only) out.push({ name, group, recordings })
  }
  return out.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name))
}

/** Forget someone's voice in a group (it's no longer recognised there; names already given stay). */
export function forgetVoice(store: Store, name: string, group?: string, groupOf: GroupOf = () => '') {
  const all = prints(store)
  if (group === undefined) delete all[name]
  else {
    all[name] = (all[name] ?? []).filter((x) => groupOfSample(x, groupOf) !== group)
    if (!all[name].length) delete all[name]
  }
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
