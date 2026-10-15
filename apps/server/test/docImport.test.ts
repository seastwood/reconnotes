import { describe, expect, it } from 'vitest'
import { convertDocuments, parseCsv } from '../src/docImport'
import { writeZip } from '../src/zip'

process.env.RECON_SOFFICE = 'off'
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const zip = (files: Record<string, string>) => writeZip(Object.entries(files).map(([name, s]) => ({ name, data: Buffer.from(s) })))
const md = async (path: string, data: Buffer) => {
  const r = await convertDocuments([{ path, data }])
  return { text: r.files.find((f) => f.path.endsWith('.md'))?.data.toString() ?? '', files: r.files.map((f) => f.path), skipped: r.skipped }
}

describe('documents as notes', () => {
  it('reads a Word file: headings, bold, nested lists, links and tables', async () => {
    const p = (inner: string, pr = '') => `<w:p>${pr ? `<w:pPr>${pr}</w:pPr>` : ''}${inner}</w:p>`
    const run = (t: string, rpr = '') => `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${t}</w:t></w:r>`
    const item = (t: string, lvl: number, num = 1) => p(run(t), `<w:numPr><w:ilvl w:val="${lvl}"/><w:numId w:val="${num}"/></w:numPr>`)
    const docx = zip({
      'word/document.xml': `<w:document ${W}><w:body>
        ${p(run('Packing list'), '<w:pStyle w:val="Heading1"/>')}
        ${p(run('Leave ') + run('Friday', '<w:b/>') + run(' – see ') + `<w:hyperlink r:id="rId9">${run('map')}</w:hyperlink>`)}
        ${item('Tent', 0)}${item('Poles', 1)}${item('Stove', 0)}
        ${item('Drive', 0, 2)}${item('Camp', 0, 2)}
        <w:tbl><w:tr><w:tc>${p(run('Day'))}</w:tc><w:tc>${p(run('Miles'))}</w:tc></w:tr><w:tr><w:tc>${p(run('Fri'))}</w:tc><w:tc>${p(run('120'))}</w:tc></w:tr></w:tbl>
      </w:body></w:document>`,
      'word/_rels/document.xml.rels': `<Relationships><Relationship Id="rId9" Type="hyperlink" Target="https://example.com/map" TargetMode="External"/></Relationships>`,
      'word/styles.xml': `<w:styles ${W}><w:style w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`,
      'word/numbering.xml': `<w:numbering ${W}>
        <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
        <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
        <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`,
    })
    const { text, files } = await md('Trip.docx', docx)
    expect(files).toEqual(['Trip.md'])
    expect(text).toContain('# Packing list')
    expect(text).toContain('Leave **Friday** – see [map](<https://example.com/map>)')
    expect(text).toMatch(/- Tent\n+ {2}- Poles\n+- Stove/)
    expect(text).toMatch(/1\. Drive\n2\. Camp/)
    expect(text).toContain('| Day | Miles |')
    expect(text).toContain('| Fri | 120 |')
  })

  it('reads a spreadsheet: shared strings, numbers and dates', async () => {
    const xlsx = zip({
      'xl/workbook.xml': '<workbook><sheets><sheet name="Costs" r:id="rId1" xmlns:r="r"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/sharedStrings.xml': '<sst><si><t>When</t></si><si><t>Cost</t></si><si><t>Gas</t></si></sst>',
      'xl/styles.xml': '<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
      'xl/worksheets/sheet1.xml': `<worksheet><sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>
        <row r="2"><c r="A2" s="1"><v>46296</v></c><c r="B2" t="s"><v>2</v></c><c r="C2"><v>45.100000000000001</v></c></row>
      </sheetData></worksheet>`,
    })
    const { text } = await md('Costs.xlsx', xlsx)
    expect(text).toContain('| When |   | Cost |')
    expect(text).toContain('| 2026-10-01 | Gas | 45.1 |')
  })

  it('reads CSV, code and plain text; leaves files a Markdown note links to', async () => {
    expect(parseCsv('a,b\n"x, y",2\n')).toEqual([
      ['a', 'b'],
      ['x, y', '2'],
    ])
    expect((await md('run.py', Buffer.from('print("hi")\n'))).text).toBe('```python\nprint("hi")\n```\n')
    const r = await convertDocuments([
      { path: 'Note.md', data: Buffer.from('See [spec](spec.pdf)') },
      { path: 'spec.pdf', data: Buffer.from('%PDF-1.4') },
    ])
    expect(r.files.map((f) => f.path)).toEqual(['Note.md', 'spec.pdf'])
    expect(r.converted).toBe(0)
  })

  it('reads RTF without LibreOffice', async () => {
    const { text } = await md('Letter.rtf', Buffer.from('{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}\\f0 Dear {\\b Sam},\\par Caf\\\'e9 at 8\\u8211? ok\\par}'))
    expect(text).toContain('Dear **Sam**,')
    expect(text).toContain('Café at 8– ok')
  })
})
