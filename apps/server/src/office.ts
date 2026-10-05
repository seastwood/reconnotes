import { readZip, type ZipEntry } from './zip'

/**
 * Text from office documents, for search: Word/Excel/PowerPoint (.docx,
 * .xlsx, .pptx) and OpenDocument (.odt, .ods, .odp). They're zip files of
 * XML, so this reads the zip directly (no dependencies) and keeps the text.
 */

const OFFICE_EXT = /\.(docx|xlsx|pptx|odt|ods|odp)$/i
const OFFICE_MIME = /officedocument|opendocument/

export function isOfficeFile(mime: string, name: string): boolean {
  return OFFICE_MIME.test(mime) || OFFICE_EXT.test(name)
}

type Entry = ZipEntry

const read = (_zip: Buffer, e: Entry) => e.data().toString('utf8')
const entries = readZip

const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')

/** XML → text: paragraph/row ends become line breaks, tabs stay tabs. */
function xmlText(xml: string, para: RegExp): string {
  return decode(
    xml
      .replace(para, '\n')
      .replace(/<(w:tab|text:tab)\b[^>]*\/>/g, '\t')
      .replace(/<[^>]+>/g, ''),
  )
}

const byNumber = (a: Entry, b: Entry) => Number(/(\d+)\.xml$/.exec(a.name)?.[1] ?? 0) - Number(/(\d+)\.xml$/.exec(b.name)?.[1] ?? 0)

export function officeText(data: Buffer, name: string): string {
  const all = entries(data)
  const pick = (re: RegExp) => all.filter((e) => re.test(e.name)).sort(byNumber)
  const parts: string[] = []
  const ext = /\.(\w+)$/.exec(name)?.[1]?.toLowerCase() ?? ''
  if (ext === 'docx' || pick(/^word\/document\.xml$/).length) {
    for (const e of pick(/^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/)) parts.push(xmlText(read(data, e), /<\/w:p>/g))
  } else if (ext === 'xlsx' || pick(/^xl\/workbook\.xml$/).length) {
    // cell text lives in sharedStrings; numbers and inline strings in each sheet
    for (const e of pick(/^xl\/sharedStrings\.xml$/)) parts.push(xmlText(read(data, e), /<\/si>/g))
    for (const e of pick(/^xl\/worksheets\/sheet\d+\.xml$/)) {
      const xml = read(data, e)
      const inline = [...xml.matchAll(/<is>([\s\S]*?)<\/is>/g)].map((m) => xmlText(m[1], /<\/t>/g))
      const numbers = [...xml.matchAll(/<c [^>]*?(?:t="n"[^>]*)?>\s*<v>([^<]+)<\/v>/g)].filter((m) => !/t="s"/.test(m[0])).map((m) => m[1])
      parts.push([...inline, numbers.join(' ')].join('\n'))
    }
  } else if (ext === 'pptx' || pick(/^ppt\/presentation\.xml$/).length) {
    for (const e of pick(/^ppt\/(slides\/slide|notesSlides\/notesSlide)\d+\.xml$/)) parts.push(xmlText(read(data, e), /<\/a:p>/g))
  } else {
    for (const e of pick(/^content\.xml$/)) parts.push(xmlText(read(data, e), /<\/(text:p|text:h|table:table-row)>/g))
  }
  return parts
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 200_000)
}
