import zlib from 'node:zlib'

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

interface Entry {
  name: string
  method: number
  compressedSize: number
  offset: number
}

function entries(zip: Buffer): Entry[] {
  // end of central directory: the last 22+ bytes, signature 0x06054b50
  let eocd = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip file')
  const count = zip.readUInt16LE(eocd + 10)
  let p = zip.readUInt32LE(eocd + 16)
  const out: Entry[] = []
  for (let n = 0; n < count && p + 46 <= zip.length; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) break
    const method = zip.readUInt16LE(p + 10)
    const compressedSize = zip.readUInt32LE(p + 20)
    const nameLen = zip.readUInt16LE(p + 28)
    const extraLen = zip.readUInt16LE(p + 30)
    const commentLen = zip.readUInt16LE(p + 32)
    const offset = zip.readUInt32LE(p + 42)
    out.push({ name: zip.toString('utf8', p + 46, p + 46 + nameLen), method, compressedSize, offset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

function read(zip: Buffer, e: Entry): string {
  const p = e.offset
  if (zip.readUInt32LE(p) !== 0x04034b50) return ''
  const start = p + 30 + zip.readUInt16LE(p + 26) + zip.readUInt16LE(p + 28)
  const data = zip.subarray(start, start + e.compressedSize)
  const raw = e.method === 0 ? data : e.method === 8 ? zlib.inflateRawSync(data) : Buffer.alloc(0)
  return raw.toString('utf8')
}

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
