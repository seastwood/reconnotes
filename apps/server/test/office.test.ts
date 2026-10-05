import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { isOfficeFile, officeText } from '../src/office'

/** A minimal zip (deflated entries), like Word/Excel/PowerPoint write. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text)
    const data = zlib.deflateRawSync(raw)
    const n = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(n.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(n.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, n, data)
    centrals.push(central, n)
    offset += 30 + n.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

describe('office documents', () => {
  it('recognises office files by type or name', () => {
    expect(isOfficeFile('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'x')).toBe(true)
    expect(isOfficeFile('application/octet-stream', 'Budget.xlsx')).toBe(true)
    expect(isOfficeFile('application/pdf', 'a.pdf')).toBe(false)
  })

  it('reads Word, Excel and PowerPoint text', () => {
    const docx = zip({
      '[Content_Types].xml': '<Types/>',
      'word/document.xml':
        '<w:document><w:body><w:p><w:r><w:t>Robot build plan</w:t></w:r></w:p><w:p><w:r><w:t>Order bumpers &amp; bins</w:t></w:r></w:p></w:body></w:document>',
    })
    expect(officeText(docx, 'Plan.docx')).toBe('Robot build plan\nOrder bumpers & bins')

    const xlsx = zip({
      'xl/workbook.xml': '<workbook/>',
      'xl/sharedStrings.xml': '<sst><si><t>Part</t></si><si><t>Bumper kit</t></si></sst>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42.5</v></c></row></sheetData></worksheet>',
    })
    const sheet = officeText(xlsx, 'Parts.xlsx')
    expect(sheet).toContain('Bumper kit')
    expect(sheet).toContain('42.5')

    const pptx = zip({
      'ppt/presentation.xml': '<p:presentation/>',
      'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>Second slide</a:t></a:r></a:p></p:sld>',
      'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>Kickoff</a:t></a:r></a:p></p:sld>',
    })
    expect(officeText(pptx, 'Deck.pptx')).toBe('Kickoff\n\nSecond slide')
  })
})
