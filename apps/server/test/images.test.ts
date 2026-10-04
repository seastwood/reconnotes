import { describe, expect, it } from 'vitest'
import { Resvg } from '@resvg/resvg-js'
import { fitForAi, imageSize } from '../src/images'

const png = (w: number, h: number) =>
  new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#e8e0c8"/><circle cx="${w / 2}" cy="${h / 2}" r="${h / 4}" fill="#123"/></svg>`)
    .render()
    .asPng()

describe('images for AI', () => {
  it('reads image dimensions from headers', () => {
    expect(imageSize(png(320, 200))).toEqual({ width: 320, height: 200 })
    // minimal JPEG: SOI, APP0 (len 4), SOF0 with height 300 / width 500
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0xf4, 0x03])
    expect(imageSize(jpeg)).toEqual({ width: 500, height: 300 })
    expect(imageSize(Buffer.from('not an image'))).toBeNull()
  })

  it('shrinks large photos and leaves small ones alone', () => {
    const small = png(800, 600)
    expect(fitForAi(small, 'image/png').data).toBe(small)
    const big = fitForAi(png(4000, 3000), 'image/png')
    expect(big.mime).toBe('image/png')
    expect(imageSize(big.data)).toEqual({ width: 1600, height: 1200 })
  })
})
