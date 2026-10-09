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
    .split('\n')
    .filter((l) => !/^\s*(#+\s*Notes|Attendees:)\s*$/i.test(l))
    .join('\n')
    .trim()
}

/** "[TBD]", "by TBD", "(deadline: not specified)", "– N/A"… with what led into it */
const PLACEHOLDER =
  /\s*(?:[-–—,:]\s*)?(?:\b(?:by|on|at|due|deadline|when|owner|who)\s*:?\s*)?(?:[[(]\s*(?:TBD|TBC|TBA|unknown|unspecified|not specified|not stated|not mentioned|N\/A|none|undisclosed(?: person)?|unnamed(?: person)?|unknown person|someone|person not (?:named|specified))\s*[\])]|\b(?:TBD|TBC|TBA)\b|\((?:deadline|owner|date|time)\s*:?\s*(?:not specified|not stated|not mentioned|unknown|unspecified|N\/A)\))/gi

export function groundMeetingNotes(text: string, transcript: string, notes: string): string {
  const source = `${transcript}\n${notes}`
  const have = new Set(words(source))
  const found = (w: string) => have.has(w) || [...have].some((h) => h.length >= 4 && w.length >= 4 && h.slice(0, 5) === w.slice(0, 5))
  const grounded = (line: string) => {
    const body = line.replace(/^\s*[-*]\s+(\[[ xX]\]\s+)?/, '')
    // names: capitalised words (not the first) that were never said or written
    const names = body
      .split(/\s+/)
      .slice(1)
      .map((w) => w.replace(/[^\p{L}]/gu, ''))
      .filter((w) => /^\p{Lu}\p{Ll}+$/u.test(w))
    if (names.some((n) => !found(n.toLowerCase()) && !/^(I|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/.test(n))) return false
    // numbers (dates, amounts) that weren't in it
    if ((body.match(/\d+/g) ?? []).some((n) => !source.includes(n))) return false
    const content = words(body).filter((w) => w.length >= 4 && !STOP.has(w) && !GENERIC.has(w) && !/^\d+$/.test(w))
    if (!content.length) return true
    const hits = content.filter(found).length
    return hits > 0 && hits / content.length >= 1 / 3
  }

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
    const kept = s.lines.filter((l) => l.trim() && (!/^\s*[-*]\s/.test(l) || /no action items/i.test(l) || grounded(l)))
    const isActions = /action/i.test(s.heading)
    const isSummary = /summary/i.test(s.heading)
    const bullets = kept.filter((l) => /^\s*[-*]\s/.test(l) && !/no action items/i.test(l))
    if (isSummary && !bullets.length) {
      const said = transcript.replace(/\s+/g, ' ').trim()
      if (!said) continue
      out.push(s.heading, `- “${said.length > 300 ? `${said.slice(0, 297).replace(/\s+\S*$/, '')}…` : said}”`, '')
    } else if (isActions && !bullets.length) out.push(s.heading, 'No action items.', '')
    else if (bullets.length) out.push(s.heading, ...kept, '')
  }
  return out.join('\n').trim()
}
