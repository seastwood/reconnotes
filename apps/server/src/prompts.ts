import type { Store } from './store'

/**
 * Prompts you can change
 * ======================
 *
 * The instructions given to the AI for each kind of job: the parts of the
 * meeting-notes prompt that decide what the notes say (what counts as a
 * decision, what each section holds), and your own standing instructions for
 * each kind of job ("Write in British English", "Our team is FRC 1234").
 * Each can be changed in Settings › Prompts and reset to its default. The
 * notes' headings and layout aren't among them: the checks after the AI
 * writes (decisions only for what was agreed, open questions that ask
 * something) rely on them.
 */

export interface PromptDef {
  key: string
  /** the kind of job it's for, as shown */
  group: string
  label: string
  help: string
  default: string
}

export const PROMPTS: PromptDef[] = [
  {
    key: 'meeting.reasoning',
    group: 'Meeting notes',
    label: 'How to tell what was decided',
    help: 'Given to every part of a meeting and to the final notes. What separates a suggestion from a decision, a task from talk.',
    default: `- A suggestion ("we could…", "what if…", "another thought is…", "maybe…") is not a decision. A decision is what people agreed on and the talk moved on from ("yep", "done", "let's do that", "you got it", or it was simply acted on).
- People change their minds: when a later idea replaces an earlier one, only the last one agreed on is the decision. The earlier ideas belong in the Summary ("first suggested X; settled on Y"), never in Decisions or Action items.
- A task taken back later ("load the crate… actually, no, don't load it up") is not a task.
- Small talk is not part of the meeting: lunch, food, jokes, banter, who's coming in late. Leave it out of every section.
- When something wasn't settled, or someone is to find something out, it's an open question (with who looks into it, if said).`,
  },
  {
    key: 'meeting.summary',
    group: 'Meeting notes',
    label: 'Summary – what each bullet holds',
    help: 'The instruction under the Summary heading.',
    default: `**A short name for the topic**: one bullet per topic discussed, in the order it came up, each with the details that were said (numbers, names, dates, places, reasons) – and, where ideas changed during the discussion, how it went (what was suggested first, what it ended up as). Plain sentences: no "Topic:", "Outcome:" or "Who:" labels. Two different subjects are two bullets – never one bullet joining unrelated things ("Air freshener & compost").`,
  },
  {
    key: 'meeting.decisions',
    group: 'Meeting notes',
    label: 'Decisions – what counts',
    help: 'The instruction under the Decisions heading.',
    default: `each thing that was actually settled: the final outcome only (leave this section out if nothing was settled)`,
  },
  {
    key: 'meeting.open',
    group: 'Meeting notes',
    label: 'Open questions – what counts',
    help: 'The instruction under the Open questions heading. (A line that asks nothing is left out afterwards whatever this says.)',
    default: `each real question left open: what's still to be decided or found out, said as that ("Where does the water meter box go – the middle of the lot, or 8 ft off the fence?"). Most topics have none: a topic that was only talked about isn't an open question, and "unresolved", "no decision made" or "no task assigned" isn't one either. Leave this section out if there are none.`,
  },
  {
    key: 'meeting.actions',
    group: 'Meeting notes',
    label: 'Action items – what counts',
    help: 'The instruction under the Action items heading.',
    default: `each task someone took on or was given, written as a task in your own words (who, if said – then what to do, and when, if said), never a quote of what was said. A task is also what someone said they or "we" will do: "I'll get a quote for the trade-in", "let's make space for the dumpster Tuesday", "we're servicing the sweeper this morning". Not every topic is a task: something only talked about ("the toilet's acting up") isn't one unless someone said it would be done. One task per item: three things to do are three items.`,
  },
  ...(
    [
      ['meeting', 'Meeting notes', 'Added to every part of a meeting and to the final notes. E.g. "Write in plain, short sentences" or "We are FRC team 1234; the robot is called Bolt".'],
      ['handwriting', 'Handwriting to text', 'Added when handwriting is read. E.g. "My handwritten 4s look like 9s".'],
      ['pictures', 'Pictures and PDFs', 'Added when the text in a picture or PDF is read for search.'],
      ['summarise', 'Summarise', 'Added to "Summarise" on a note.'],
      ['todos', 'Extract to-dos', 'Added to "Extract to-dos" on a note.'],
      ['clean', 'Clean up wording', 'Added to "Clean up" and to tidying converted handwriting.'],
      ['ask', 'Ask your notes', 'Added to every question you ask. E.g. "Answer in bullet points".'],
    ] as const
  ).map(([kind, group, help]) => ({ key: `extra.${kind}`, group, label: 'Your standing instructions', help, default: '' })),
]

const KEY = 'prompts'
let store: Store | null = null
export function usePromptStore(s: Store) {
  store = s
}

const saved = () => store?.getSetting<Record<string, string>>(KEY) ?? {}

/** The prompt as it is now: yours if you changed it, else the default. */
export function promptText(key: string): string {
  const def = PROMPTS.find((p) => p.key === key)
  const mine = saved()[key]
  return mine !== undefined ? mine : (def?.default ?? '')
}

/** Every prompt, with its default and whether you changed it. */
export function listPrompts() {
  const mine = saved()
  return PROMPTS.map((p) => ({ ...p, value: mine[p.key] ?? p.default, changed: mine[p.key] !== undefined && mine[p.key] !== p.default }))
}

/** Change a prompt (null, or its default: back to the default). */
export function setPrompt(key: string, value: string | null) {
  const def = PROMPTS.find((p) => p.key === key)
  if (!def || !store) throw new Error('no such prompt')
  const mine = { ...saved() }
  const text = value === null ? null : value.replace(/\r\n/g, '\n').slice(0, 8000)
  if (text === null || text.trim() === def.default.trim()) delete mine[key]
  else mine[key] = text
  store.setSetting(KEY, mine)
}

/** Your standing instructions for a kind of job, ready to add to its prompt ('' when none). */
export function standing(kind: 'meeting' | 'handwriting' | 'pictures' | 'summarise' | 'todos' | 'clean' | 'ask'): string {
  const t = promptText(`extra.${kind}`).trim()
  return t ? `\n\nStanding instructions from the user (always follow them): ${t}` : ''
}
