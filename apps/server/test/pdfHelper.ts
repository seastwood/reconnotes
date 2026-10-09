/** A small real PDF (Helvetica), page by page: lines of [size, text, bold?]. */
export function makePdf(pages: [number, string, boolean?][][]): Buffer {
  const objs: string[] = []
  const add = (s: string) => (objs.push(s), objs.length)
  const catalog = add('') // filled in below
  const pagesObj = add('')
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const bold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>')
  const kids: number[] = []
  for (const lines of pages) {
    let y = 760
    const ops = lines
      .map(([size, text, b]) => {
        // a drawing (lines and shapes, with a label in it), `size` points tall
        if (text === '@drawing') {
          y -= size + 10
          return `0.3 0.5 0.9 rg 120 ${y} 300 ${size - 10} re f 0 0 0 RG 3 w 110 ${y - 5} 320 ${size} re S\nBT /F1 9 Tf 240 ${y + size / 2} Td (ROBOT PERIMETER) Tj ET`
        }
        y -= size * 1.5 + (size > 13 ? 10 : 0)
        const t = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
        return `BT /${b ? 'F2' : 'F1'} ${size} Tf 72 ${y} Td (${t}) Tj ET`
      })
      .join('\n')
    const content = add(`<< /Length ${Buffer.byteLength(ops)} >>\nstream\n${ops}\nendstream`)
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R /F2 ${bold} 0 R >> >> /Contents ${content} 0 R >>`))
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out))
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = Buffer.byteLength(out)
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

/** A game manual: a running header and page numbers on each page, chapters, sections, rules. */
export function manualPdf(): Buffer {
  const head: [number, string][] = [[8, '2026 GAME MANUAL']]
  return makePdf([
    [...head, [24, '1 Introduction'], [11, 'Welcome to the game. Teams build robots to play'], [11, 'matches on a field.'], [11, '- Read every rule'], [11, '- Ask questions in the Q&A'], [8, 'Page 1']],
    [...head, [24, '6 Game Rules'], [16, '6.1 Fouls'], [11, 'G301 Robots may not damage the field. Violation: major foul.'], [11, 'G302 Robots may not extend more than 48 cm beyond their frame peri-'], [11, 'meter. Violation: minor foul. This rule continues on the next'], [8, 'Page 2']],
    [...head, [11, 'page with more detail about extension.'], [16, '6.2 Scoring'], [11, 'A coral on level 4 is worth 5 points. See G302 for limits.'], [11, 'G303 Robots may not pin an opponent.'], [8, 'Page 3']],
    [...head, [24, '9 Robot Rules'], [11, 'R101 Robots must fit within a 120 cm frame perimeter.'], [8, 'Page 4']],
  ])
}

/** A manual page with a drawn figure under its caption. */
export function figurePdf(): Buffer {
  return makePdf([
    [
      [24, '8 Robot Rules'],
      [11, 'R401 BUMPERS all around. Gaps of less than 1 1/4 in. are permitted.'],
      [9, 'Figure 8-3 BUMPER coverage requirements'],
      [120, '@drawing'],
      [11, 'R402 BUMPER construction. BUMPERS must consist of the following.'],
    ],
  ])
}
