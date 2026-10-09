/**
 * "Listen" links on meeting notes
 * ===============================
 *
 * Each bullet the AI wrote (a summary point, a decision, a to-do) gets a small
 * ▶ link to the moment in the recording where it was talked about. The notes
 * are worded differently from what was said, so the place is found by the
 * words they share: the stretch of the transcript (about half a minute of
 * speech) with the most of the bullet's telling words – rare ones counting
 * more than common ones. A bullet that matches nowhere well gets no link.
 * Needs the word times Whisper (or Apple, on the phone) gives.
 */

export interface TimedWord {
  word: string
  start: number
  end: number
}

/** the link's address: listen:<recording>@<seconds> */
export const listenHref = (attachmentId: string, seconds: number) => `listen:${attachmentId}@${Math.max(0, Math.round(seconds))}`

export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const STOP = new Set(
  `a about above after again all also am an and any are as at be because been before being below between both but by can could did do does doing done down during each few for from further get gets getting go going gonna got had has have having he her here hers him his how i if in into is it its just know let like make me more most my need needs no nor not now of off on once only or other our out over own really right said same say says see she should so some still such sure take than that the their them then there these they thing things think this those through to too under until up us very want was we well were what when where which while who why will with would yeah yes you your okay ok um uh oh`.split(' '),
)

/** a word's plain form: lower case, no punctuation, simple endings off (orders → order, booking → book) */
export function stem(w: string): string {
  let s = w.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (s.length > 5 && s.endsWith('ing')) s = s.slice(0, -3)
  else if (s.length > 4 && s.endsWith('ed')) s = s.slice(0, -2)
  else if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1)
  return s
}
const telling = (w: string) => w.length >= 3 && !STOP.has(w)

/**
 * For each line, the time (seconds) where what it says was talked about – or null.
 * Lines that aren't bullets (headings, blank) get null.
 */
export function listenTimes(lines: string[], words: TimedWord[]): (number | null)[] {
  if (words.length < 8) return lines.map(() => null)
  const stems = words.map((w) => stem(w.word))
  const WINDOW = 70 // words: about half a minute of speech
  const STEP = 10
  const windows: { from: number; to: number; set: Set<string> }[] = []
  for (let from = 0; from < stems.length; from += STEP) {
    const to = Math.min(stems.length, from + WINDOW)
    windows.push({ from, to, set: new Set(stems.slice(from, to).filter(telling)) })
    if (to === stems.length) break
  }
  // how rare each word is across the meeting: a name said once tells more than "meeting"
  const df = new Map<string, number>()
  for (const w of windows) for (const s of w.set) df.set(s, (df.get(s) ?? 0) + 1)
  const idf = (s: string) => Math.log((windows.length + 1) / ((df.get(s) ?? 0) + 0.5))

  /** where in a stretch those words come closest together (a word shared with another point said earlier doesn't count) */
  const densest = (from: number, to: number, hit: string[]): number => {
    const SPAN = 20
    let bestAt = from
    let bestScore = -1
    for (let i = from; i < to; i++) {
      if (!hit.includes(stems[i])) continue
      const near = new Set(stems.slice(i, Math.min(to, i + SPAN)).filter((s) => hit.includes(s)))
      const score = [...near].reduce((a, s) => a + idf(s), 0)
      if (score > bestScore + 1e-9) (bestScore = score), (bestAt = i)
    }
    return words[bestAt].start
  }

  return lines.map((line) => {
    const m = line.match(/^\s*(?:[-*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/)
    if (!m) return null
    const want = [...new Set(m[1].replace(/!\d{4}-\d{2}-\d{2}/g, '').split(/\s+/).map(stem).filter(telling))].filter((s) => df.has(s))
    if (want.length < 2) return null
    const total = want.reduce((a, s) => a + idf(s), 0)
    let best: { score: number; hits: number; at: number } | null = null
    for (const w of windows) {
      const hit = want.filter((s) => w.set.has(s))
      if (hit.length < 2) continue
      const score = hit.reduce((a, s) => a + idf(s), 0)
      if (!best || score > best.score + 1e-9) best = { score, hits: hit.length, at: densest(w.from, w.to, hit) }
    }
    // enough of what the bullet says, said together
    if (!best || best.score < total * 0.4) return null
    return Math.max(0, best.at - 2)
  })
}

/**
 * The notes with a ▶ link at the end of each bullet that was found in the
 * recording (before a due date, which stays last).
 */
export function addListenLinks(markdown: string, words: TimedWord[], attachmentId: string): { markdown: string; links: number } {
  const lines = markdown.split('\n')
  const times = listenTimes(lines, words)
  let links = 0
  const out = lines.map((line, i) => {
    const t = times[i]
    if (t === null || /no action items|^\s*[-*]\s*$|\]\(listen:/i.test(line)) return line
    links++
    const link = ` [▶ ${clock(t)}](${listenHref(attachmentId, t)})`
    const due = line.match(/^(.*?)(\s+!\d{4}-\d{2}-\d{2})\s*$/)
    return due ? `${due[1]}${link}${due[2]}` : `${line.replace(/\s+$/, '')}${link}`
  })
  return { markdown: out.join('\n'), links }
}
