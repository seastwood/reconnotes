/**
 * What to look for in a note to land on an item there (a due item, a to-do): its first words, without
 * what the note doesn't show as text – a due date (!2026-10-12), a ▶ link, Markdown marks. The start
 * of the item is enough to find it, and stays found if its end is edited.
 */
export function findTextFor(text: string): string {
  const plain = text
    .replace(/\s*\[▶[^\]]*\]\(listen:[^)]*\)/g, '')
    .replace(/\s*!\d{4}-\d{2}-\d{2}/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  let out = ''
  for (const w of plain.split(' ')) {
    if (`${out} ${w}`.trim().length > 48) break
    out = `${out} ${w}`.trim()
  }
  return out || plain.slice(0, 48)
}
