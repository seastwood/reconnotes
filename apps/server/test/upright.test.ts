import { Resvg } from '@resvg/resvg-js'
import { describe, expect, it } from 'vitest'
import { imageSize, rotatePicture, textRunsSideways } from '../src/images'

/** A stand-in for a printed page: lines of letter-sized blocks in words (or the same, on its side). */
function page(sideways: boolean): Buffer {
  const rects: string[] = []
  for (let line = 0; line < 14; line++)
    for (let word = 0; word < 6; word++)
      for (let letter = 0; letter < 4 + ((line + word) % 3); letter++) {
        const along = 30 + word * 95 + letter * 13
        const across = 30 + line * 34
        const [x, y, w, h] = sideways ? [across, along, 14, 10] : [along, across, 10, 14]
        rects.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#222"/>`)
      }
  const [W, H] = sideways ? [560, 640] : [640, 560]
  return new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#fff"/>${rects.join('')}</svg>`).render().asPng()
}

describe('which way up a photo of a page is (on the server)', () => {
  it('tells text running across from text running up or down', () => {
    expect(textRunsSideways(page(false), 'image/png')).toBe(false)
    expect(textRunsSideways(page(true), 'image/png')).toBe(true)
  })
  it('a blank picture: can’t tell', () => {
    const blank = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="100%" height="100%" fill="#fff"/></svg>').render().asPng()
    expect(textRunsSideways(blank, 'image/png')).toBeNull()
  })
  it('turns a picture a quarter at a time', async () => {
    const turned = await rotatePicture(page(true), 'image/png', 1)
    expect(turned).not.toBeNull()
    expect(imageSize(turned!.data)).toEqual({ width: 640, height: 560 })
    expect(textRunsSideways(turned!.data, turned!.mime)).toBe(false)
  })
})
