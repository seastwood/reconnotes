import { stem, telling } from './listen'
import { STOP } from './ask'

/**
 * Keeping meeting notes to what was said
 * ======================================
 *
 * Small local models fill a template with plausible inventions ("John –
 * review the project status report") when the recording is short or unclear.
 * So what comes back is checked against the transcript and the notes: a line
 * whose words, names or numbers aren't in them is left out. A summary that
 * loses everything falls back to what was actually said.
 */

/** words that describe a meeting rather than its content ("discussed", "agreed") */
const GENERIC = new Set(
  'about across agreed asked asks brought confirmed considered decided decision decisions discuss discussed discussion explained follow following item items meeting mentioned noted outlined point points raised regarding said says shared someone suggested talked topic topics update whether which while needed needs'.split(' '),
)

const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []

/** The template's own lines (the meeting heading, "Attendees:" with nobody, "## Notes") aren't notes. */
export function meetingNotesText(markdown: string): string {
  return markdown
    .replace(/^#+ Meeting.*$/m, '')
    // ▶ links into the recording (from earlier notes): not something you wrote
    .replace(/\s*\[▶[^\]]*\]\(listen:[^)]*\)/g, '')
    .split('\n')
    .filter((l) => !/^\s*(#+\s*Notes|Attendees:)\s*$/i.test(l))
    .join('\n')
    .trim()
}

/** "[TBD]", "by TBD", "(deadline: not specified)", "– N/A"… with what led into it */
const PLACEHOLDER =
  /\s*(?:[-–—,:]\s*)?(?:\b(?:by|on|at|due|deadline|when|owner|who)\s*:?\s*)?(?:[[(]\s*(?:TBD|TBC|TBA|unknown|unspecified|not specified|not stated|not mentioned|N\/A|none|undisclosed(?: person)?|unnamed(?: person)?|unknown person|someone|person not (?:named|specified)|unassigned|no owner|owner unknown|anyone|no date|no deadline|date unknown)\s*[\])]|\b(?:TBD|TBC|TBA)\b|\((?:deadline|owner|date|time)\s*:?\s*(?:not specified|not stated|not mentioned|unknown|unspecified|N\/A)\))/gi

/**
 * `fallback`: Summary bullets to use if none of the model's own survive (each part's topics);
 * `dropped`: collects the lines left out, so the job can show what was taken away and why.
 */
/** an "open question" that only says nothing was assigned or decided */
const FILLER =
  /^(?:no (?:formal |explicit |specific |clear )?(?:action items?|tasks?|owners?)\b[^.;]*?(?:assigned|given|set)\b|no (?:task|action item) assigned|no actionable|no decisions?(?: made)?\s*(?:[.;]|$)|[^.]*small talk (?:omitted|excluded))/i

export function groundMeetingNotes(
  text: string,
  transcript: string,
  notes: string,
  opts: { fallback?: string[]; dropped?: string[]; meant?: Set<string> } = {},
): string {
  const source = `${transcript}\n${notes}`
  const have = new Set(words(source))
  const found = (w: string) => have.has(w) || [...have].some((h) => h.length >= 4 && w.length >= 4 && h.slice(0, 5) === w.slice(0, 5))
  const grounded = (line: string) => {
    // a bullet's bold topic label ("**Tractor Purchase**:") names the topic in the notes' own words –
    // not names someone said: the rest of the line is what's checked
    const body = line.replace(/^\s*[-*]\s+(\[[ xX]\]\s+)?/, '').replace(/^\*\*[^*]{1,80}\*\*\s*:?\s*/, '')
    // names: capitalised words in the middle of a sentence that were never said or written – not
    // a sentence's first word ("Initially, … Later, …"), which is capitalised whatever it is
    const tokens = body.split(/\s+/)
    const names = tokens
      .filter((_, i) => i > 0 && !/[.!?;:"“”'‘’(\-–—]$/.test(tokens[i - 1]) && !/^["“'‘(]/.test(tokens[i]))
      .map((w) => w.replace(/[^\p{L}]/gu, ''))
      .filter((w) => /^\p{Lu}\p{Ll}+$/u.test(w) && !STOP.has(w.toLowerCase()) && !GENERIC.has(w.toLowerCase()))
    if (names.some((n) => !found(n.toLowerCase()) && !/^(I|Speaker|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/.test(n))) return false
    // numbers (dates, amounts) that weren't in it
    if ((body.match(/\d+/g) ?? []).some((n) => !source.includes(n))) return false
    // what was said, in other words (found by meaning): no names or numbers made up, so it stays –
    // unless it starts with someone nobody mentioned ("Margaret approved…"; the first word isn't
    // checked above, since it's capitalised whatever it is: here a name is told by what follows it)
    if (opts.meant?.has(line.trim())) {
      const first = tokens[0]?.replace(/[^\p{L}]/gu, '') ?? ''
      const leadsName =
        /^\p{Lu}\p{Ll}+$/u.test(first) &&
        !found(first.toLowerCase()) &&
        !STOP.has(first.toLowerCase()) &&
        !GENERIC.has(first.toLowerCase()) &&
        /^(?:\p{Lu}\p{Ll}+|will|to|and|agreed|approved|asked|said|suggested|wants|needs|is|was|has|had|can|should|would|–|-|:|,)$/u.test(tokens[1]?.replace(/[.,:;]$/, '') ?? '')
      if (!leadsName) return true
    }
    const content = words(body).filter((w) => w.length >= 4 && !STOP.has(w) && !GENERIC.has(w) && !/^\d+$/.test(w))
    if (!content.length) return true
    const hits = content.filter(found).length
    return hits > 0 && hits / content.length >= 1 / 3
  }

  text = normalizeMeetingNotes(text)
  // placeholders for what wasn't said ("by [TBD]", "(deadline: not specified)") – left out instead
  text = text
    .split('\n')
    .map((l) => l.replace(PLACEHOLDER, '').replace(/\s+([.,;:])/g, '$1').replace(/\s+$/, ''))
    .join('\n')
  // a model that carries on past its answer repeats the prompt: cut it there
  const cut = text.search(/^\s*(Notes taken during the meeting|Transcript of the recording)\b/im)
  const lines = (cut >= 0 ? text.slice(0, cut) : text).split('\n')
  const sections: { heading: string; lines: string[] }[] = []
  for (const l of lines) {
    if (/^#{1,6}\s/.test(l)) sections.push({ heading: l.trim(), lines: [] })
    else if (sections.length) sections[sections.length - 1].lines.push(l)
  }
  const out: string[] = []
  for (const s of sections) {
    const isOpen = /open questions?/i.test(s.heading)
    const kept = s.lines.filter((l) => {
      // "No task assigned", "no decisions" under Open questions: a note about the meeting, not a question
      if (isOpen && FILLER.test(l.replace(/^\s*[-*]\s+/, '').replace(/^\*\*[^*]{1,80}\*\*\s*:?\s*/, ''))) {
        opts.dropped?.push(`${s.heading.replace(/^#+\s*/, '')}: ${l.trim()}`)
        return false
      }
      const keep = l.trim() && (!/^\s*[-*]\s/.test(l) || /no action items/i.test(l) || grounded(l))
      if (!keep && l.trim()) opts.dropped?.push(`${s.heading.replace(/^#+\s*/, '')}: ${l.trim()}`)
      return keep
    })
    const isActions = /action/i.test(s.heading)
    const isSummary = /summary/i.test(s.heading)
    const bullets = kept.filter((l) => /^\s*[-*]\s/.test(l) && !/no action items/i.test(l))
    if (isSummary && !bullets.length && opts.fallback?.length) {
      // what each part of the meeting found – the model's own reading, just not put together
      out.push(s.heading, ...opts.fallback, '')
    } else if (isSummary && !bullets.length) {
      // (without the "Speaker 1:" labels the transcript has per turn)
      const said = transcript.replace(/^[^\n:]{1,40}:\s/gm, '').replace(/\s+/g, ' ').trim()
      if (!said) continue
      out.push(s.heading, `- “${said.length > 300 ? `${said.slice(0, 297).replace(/\s+\S*$/, '')}…` : said}”`, '')
    } else if (isActions && !bullets.length) out.push(s.heading, 'No action items.', '')
    else if (bullets.length) out.push(s.heading, ...kept, '')
  }
  return out.join('\n').trim()
}

/**
 * The topics each part's notes found ("- Topic: …" with its "Said: …"), in order.
 */
export function partTopics(partNotes: string[]): { topic: string; said: string }[] {
  const out: { topic: string; said: string }[] = []
  for (const part of partNotes) {
    let cur: { topic: string; said: string } | null = null
    for (const line of part.split('\n')) {
      // "- Topic: …" as asked – or a heading for it ("#### **Topic: …**"), as models also write it
      const t = line.match(/^\s*(?:[-*]|#{1,6})\s*(?:\*\*)?Topic(?:\*\*)?\s*:?\s*(?:\*\*)?\s*(.+?)\s*(?:\*\*)?\s*$/i)
      if (t) {
        cur = { topic: t[1].replace(/\*\*/g, '').replace(/\s*\((?:cont(?:inued|'d)?\.?)\)/i, '').trim(), said: '' }
        out.push(cur)
        continue
      }
      const said = line.match(/^\s*[-*]\s*(?:\*\*)?(?:Said|Details)(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.+)$/i)
      if (said && cur && !cur.said) cur.said = said[1].replace(/\*\*/g, '').trim()
    }
  }
  return out.filter((t) => t.topic && t.said)
}

/**
 * A small model putting a long meeting together drops topics (what came up in the middle
 * mostly). Every topic the parts found that the Summary doesn't mention is added to it, as the
 * part's notes said it – the Summary is the record of what was discussed.
 */
export function coverTopics(markdown: string, topics: { topic: string; said: string }[]): string {
  const lines = markdown.split('\n')
  const start = lines.findIndex((l) => /^#{1,6}\s+summary\b/i.test(l))
  if (start < 0 || !topics.length) return markdown
  let end = lines.findIndex((l, i) => i > start && /^#{1,6}\s/.test(l))
  if (end < 0) end = lines.length
  const bullets = lines.slice(start + 1, end).filter((l) => /^\s*[-*]\s/.test(l))
  const stems = (s: string) => new Set(s.split(/\s+/).map(stem).filter(telling))
  const said = bullets.map(stems)
  // a topic can be summed up under Decisions instead – not under Open questions or Action items,
  // which say what's left to do, not what was discussed
  const dec = lines.findIndex((l) => /^#{1,6}\s+decisions?\b/i.test(l))
  const decEnd = dec < 0 ? -1 : lines.findIndex((l, i) => i > dec && /^#{1,6}\s/.test(l))
  const rest = stems(dec < 0 ? '' : lines.slice(dec + 1, decEnd < 0 ? lines.length : decEnd).join(' '))
  const missing: string[] = []
  const seen = new Set<string>()
  for (const t of topics) {
    const key = [...stems(t.topic)].sort().join(' ')
    if (seen.has(key)) continue
    seen.add(key)
    const name = [...stems(t.topic)]
    const what = [...stems(t.said)]
    const has = (set: Set<string>) => {
      const byName = name.filter((w) => set.has(w)).length
      const byWhat = what.filter((w) => set.has(w)).length
      return (name.length && byName >= Math.min(2, name.length)) || byWhat >= Math.max(2, Math.ceil(what.length / 3))
    }
    if (said.some(has) || (has(rest) && name.length > 1 && name.every((w) => rest.has(w)))) continue
    missing.push(topicBullet(t))
  }
  if (!missing.length) return markdown
  // after the last bullet of the Summary
  let at = end
  while (at > start + 1 && !lines[at - 1].trim()) at--
  lines.splice(at, 0, ...missing)
  return lines.join('\n')
}

/** A part's topic as a Summary bullet: "- **Gate project**: what was said". */
export const topicBullet = (t: { topic: string; said: string }) => `- **${t.topic.replace(/[.:]\s*$/, '')}**: ${t.said}`

/** the notes' own sections (a heading that's none of these is a topic inside one) */
const SECTION = /^(summary|decisions?|open questions?|action items?|next steps|tasks|to-?dos?)\b/i

/**
 * The notes in the one shape the rest expects: "## Section" headings with "- " bullets under
 * them. Small models vary it – a numbered list, plain lines, a heading per topic under Summary,
 * to-dos without a checkbox – and a Summary written any of those ways would otherwise read as
 * empty and be thrown away.
 */
export function normalizeMeetingNotes(text: string): string {
  const out: string[] = []
  let section = ''
  let topic: { at: number; name: string; parts: string[] } | null = null
  const flush = () => {
    if (topic) out.splice(topic.at, 0, `- **${topic.name}**${topic.parts.length ? `: ${topic.parts.join('; ')}` : ''}`)
    topic = null
  }
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    const h = line.match(/^#{1,6}\s+(.+?)\s*#*$/) ?? line.match(/^\*\*([^*]+?)\*\*:?$/)
    if (h && SECTION.test(h[1].replace(/[*:]/g, '').trim())) {
      flush()
      section = h[1].replace(/[*:]/g, '').trim()
      out.push(`## ${section}`)
      continue
    }
    if (h && section && /^#/.test(line)) {
      // a topic's own heading inside a section: its points become one bullet
      flush()
      topic = { at: out.length, name: h[1].replace(/\*\*/g, '').replace(/:$/, '').replace(/\s*\((?:cont(?:inued|'d)?\.?)\)/i, '').trim(), parts: [] }
      continue
    }
    if (!line.trim()) {
      if (!topic) out.push('')
      continue
    }
    // "**Topic (Continued)**:" – a part's carry-over, not something to show; and the parts' own labels
    // copied into the notes ("**Topic: Crate loading**", "… Outcome: Open.")
    const tidy = line
      .replace(/\s*\((?:cont(?:inued|'d)?\.?)\)(?=\s*\**\s*:)/i, '')
      .replace(/^(\s*(?:[-*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?\*\*)Topic:\s*/i, '$1')
      .replace(/\s*\bOutcome:\s*Open\.?\s*$/i, '')
      .replace(/\bOutcome:\s*/gi, '')
      .replace(/(\*\*[^*]{1,80}\*\*)\s+[–—-]\s+/, '$1: ')
    // a numbered item, or a plain line, is a bullet
    let item = tidy.replace(/^(\s*)\d+[.)]\s+/, '$1- ')
    if (!/^\s*[-*]\s/.test(item) && section) item = `- ${item.trim()}`
    // to-dos are checkboxes
    if (/^action|^tasks|^to-?dos|^next steps/i.test(section)) item = item.replace(/^(\s*)[-*]\s+(?!\[[ xX]\])/, '$1- [ ] ')
    if (topic && /^\s*[-*]\s/.test(item)) topic.parts.push(item.replace(/^\s*[-*]\s+(\[[ xX]\]\s+)?/, '').replace(/[.;]\s*$/, ''))
    else out.push(item)
  }
  flush()
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export { attendeeNames } from '@reconnotes/core'
