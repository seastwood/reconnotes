/**
 * When a question is about
 * ========================
 *
 * "What did I work on yesterday?", "notes from last week", "my notes on
 * Monday", "what did I write on 10/5?" – the period the question means, in
 * the asker's own time zone, so "Ask your notes" can pick the notes written
 * or edited then.
 */

export interface TimeRange {
  from: number
  to: number
  /** "yesterday (Monday 5 October)" – for the AI */
  label: string
}

const DAY = 86_400_000
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const NUMBERS: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10, fourteen: 14, thirty: 30 }

/**
 * Local calendar helpers: `tzOffset` is the device's Date#getTimezoneOffset()
 * (minutes, UTC − local). "Local" times are shifted into UTC fields.
 */
function localTools(now: number, tzOffset: number) {
  const shift = -tzOffset * 60_000
  const local = (t: number) => new Date(t + shift)
  /** UTC instant at local midnight of the local day containing `t` */
  const startOfDay = (t: number) => {
    const d = local(t)
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - shift
  }
  const dayName = (t: number) => {
    const d = local(t)
    return `${WEEKDAYS[d.getUTCDay()][0].toUpperCase()}${WEEKDAYS[d.getUTCDay()].slice(1)} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()][0].toUpperCase()}${MONTHS[d.getUTCMonth()].slice(1)} ${d.getUTCFullYear()}`
  }
  const today = startOfDay(now)
  const weekday = local(now).getUTCDay()
  const dateAt = (y: number, m: number, d: number) => Date.UTC(y, m, d) - shift
  return { local, startOfDay, dayName, today, weekday, dateAt }
}

/** "Tuesday 6 October 2026" – today's date as the asker sees it. */
export function todayLabel(now: number, tzOffset = 0): string {
  return localTools(now, tzOffset).dayName(now)
}

/** "Mon 5 Oct" for a note's dates. */
export function shortDate(t: number, tzOffset = 0): string {
  const d = new Date(t - tzOffset * 60_000)
  return `${WEEKDAYS[d.getUTCDay()].slice(0, 3)} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCFullYear()}`.replace(/\b\w/g, (c) => c.toUpperCase())
}

export function timeRange(question: string, now = Date.now(), tzOffset = 0): TimeRange | null {
  const q = question.toLowerCase()
  const { local, dayName, today, weekday, dateAt } = localTools(now, tzOffset)
  const day = (start: number, label: string, days = 1): TimeRange => ({ from: start, to: start + days * DAY, label })
  const thisYear = local(now).getUTCFullYear()

  if (/\bday before yesterday\b/.test(q)) return day(today - 2 * DAY, `the day before yesterday (${dayName(today - 2 * DAY)})`)
  if (/\byesterday\b|\blast night\b/.test(q)) return day(today - DAY, `yesterday (${dayName(today - DAY)})`)
  if (/\btoday\b|\bthis (morning|afternoon|evening)\b|\btonight\b/.test(q)) return day(today, `today (${dayName(today)})`)

  // the past N days / last few days
  const past = q.match(/\b(?:past|last|previous)\s+(\d+|a|one|two|three|four|five|six|seven|ten|fourteen|thirty|few|couple of)\s+days?\b/)
  if (past) {
    const n = past[1] === 'few' ? 3 : past[1] === 'couple of' ? 2 : Number(past[1]) || NUMBERS[past[1]] || 1
    return { from: today - (n - 1) * DAY, to: today + DAY, label: `the last ${n} days (${dayName(today - (n - 1) * DAY)} to today)` }
  }
  // weeks start on Monday
  const monday = today - ((weekday + 6) % 7) * DAY
  if (/\bthis week\b/.test(q)) return { from: monday, to: today + DAY, label: `this week (since ${dayName(monday)})` }
  if (/\b(last|previous|past) week\b/.test(q)) return { from: monday - 7 * DAY, to: monday, label: `last week (${dayName(monday - 7 * DAY)} to ${dayName(monday - DAY)})` }
  const ld = local(now)
  if (/\bthis month\b/.test(q)) {
    const from = dateAt(ld.getUTCFullYear(), ld.getUTCMonth(), 1)
    return { from, to: today + DAY, label: `this month (since ${dayName(from)})` }
  }
  if (/\b(last|previous|past) month\b/.test(q)) {
    const from = dateAt(ld.getUTCFullYear(), ld.getUTCMonth() - 1, 1)
    const to = dateAt(ld.getUTCFullYear(), ld.getUTCMonth(), 1)
    return { from, to, label: `last month (${dayName(from)} to ${dayName(to - DAY)})` }
  }

  // a weekday: the most recent one ("last Monday" never means today)
  const wd = q.match(/\b(?:(last|this|past|on)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/)
  if (wd) {
    const target = WEEKDAYS.indexOf(wd[2])
    let back = (weekday - target + 7) % 7
    if (back === 0 && wd[1] === 'last') back = 7
    const start = today - back * DAY
    return day(start, `${back === 0 ? 'today' : wd[2]} (${dayName(start)})`)
  }

  // dates: 10/5, 10/5/26, 2026-10-05, Oct 5, 5 October
  const iso = q.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/)
  const slash = q.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/)
  const named =
    q.match(new RegExp(`\\b(${MONTHS.map((m) => m.slice(0, 3)).join('|')})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`)) ??
    q.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTHS.map((m) => m.slice(0, 3)).join('|')})[a-z]*\\b`))
  let ymd: [number, number, number] | null = null
  if (iso) ymd = [Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])]
  else if (slash) {
    // month/day (as written in the US); a two-digit year is 20xx
    const y = slash[3] ? (slash[3].length === 2 ? 2000 + Number(slash[3]) : Number(slash[3])) : thisYear
    ymd = [y, Number(slash[1]) - 1, Number(slash[2])]
  } else if (named) {
    const [a, b] = /^\d/.test(named[1]) ? [named[2], named[1]] : [named[1], named[2]]
    ymd = [thisYear, MONTHS.findIndex((m) => m.startsWith(a.slice(0, 3))), Number(b)]
  }
  if (ymd && ymd[1] >= 0 && ymd[1] < 12 && ymd[2] >= 1 && ymd[2] <= 31) {
    let start = dateAt(...ymd)
    // "Oct 5" said in January means last October
    if (!iso && !slash?.[3] && start > today + DAY) start = dateAt(ymd[0] - 1, ymd[1], ymd[2])
    return day(start, dayName(start))
  }
  return null
}
