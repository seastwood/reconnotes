import { getStroke } from 'perfect-freehand'
import type { Stroke, Tool } from './schema'

/**
 * Shared ink rendering. The web canvas and the server (which rasterises
 * drawings for handwriting recognition) both turn strokes into the same
 * filled outline paths, so what the AI reads matches what you see.
 */

interface ToolStyle {
  sizeMul: number
  thinning: number
  opacity: number
  simulatePressure: boolean
}

export const TOOL_STYLES: Record<Tool, ToolStyle> = {
  pen: { sizeMul: 1, thinning: 0.6, opacity: 1, simulatePressure: false },
  pencil: { sizeMul: 0.8, thinning: 0.75, opacity: 0.8, simulatePressure: false },
  marker: { sizeMul: 2.2, thinning: 0.15, opacity: 1, simulatePressure: false },
  highlighter: { sizeMul: 5, thinning: 0, opacity: 0.35, simulatePressure: false },
}

export function strokeOutline(s: Stroke): number[][] {
  const style = TOOL_STYLES[s.tool] ?? TOOL_STYLES.pen
  const pts: number[][] = []
  // Mouse / touch input reports a constant pressure; let perfect-freehand
  // simulate pressure from velocity in that case so lines still look natural.
  let constant = true
  for (let i = 0; i < s.pts.length; i += 3) {
    pts.push([s.pts[i], s.pts[i + 1], s.pts[i + 2]])
    if (i > 0 && s.pts[i + 2] !== s.pts[2]) constant = false
  }
  return getStroke(pts, {
    size: s.size * style.sizeMul,
    thinning: style.thinning,
    smoothing: 0.5,
    streamline: 0.45,
    simulatePressure: style.simulatePressure || (constant && s.tool !== 'highlighter'),
    last: true,
    start: { cap: true },
    end: { cap: true },
  })
}

/** SVG path data for a stroke outline. */
export function strokePath(s: Stroke): string {
  const pts = strokeOutline(s)
  if (!pts.length) return ''
  const avg = (a: number, b: number) => ((a + b) / 2).toFixed(1)
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)} Q`
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i]
    const [x1, y1] = pts[(i + 1) % pts.length]
    d += `${x0.toFixed(1)},${y0.toFixed(1)} ${avg(x0, x1)},${avg(y0, y1)} `
  }
  return d + 'Z'
}

export function strokeOpacity(s: Stroke): number {
  return (TOOL_STYLES[s.tool] ?? TOOL_STYLES.pen).opacity
}

/** Render a whole drawing to a standalone SVG string (white background). */
export function drawingToSvg(strokes: Stroke[], width: number, height: number, scale = 1): string {
  const paths = strokes
    .map((s) => {
      const d = strokePath(s)
      if (!d) return ''
      const op = strokeOpacity(s)
      return `<path d="${d}" fill="${escapeAttr(s.color)}"${op < 1 ? ` fill-opacity="${op}"` : ''}/>`
    })
    .join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width * scale)}" height="${Math.round(height * scale)}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" fill="#ffffff"/>${paths}</svg>`
  )
}

function escapeAttr(v: string) {
  return /^#[0-9a-fA-F]{3,8}$|^[a-z]+$/.test(v) ? v : '#000000'
}
