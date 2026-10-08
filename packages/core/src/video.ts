/**
 * Videos in notes
 * ===============
 *
 * A video block holds the address of a video – YouTube, Vimeo, or a video
 * file on the web – and plays it right in the note. These helpers turn the
 * many forms of those addresses into what the player needs.
 */

export interface VideoInfo {
  provider: 'youtube' | 'vimeo' | 'file'
  /** the video's id (YouTube, Vimeo) */
  id?: string
  /** where to start, in seconds */
  start?: number
  /** the player to show in the note */
  embedUrl: string
  /** the video's own page (to open it elsewhere) */
  watchUrl: string
  /** a still to show before it plays (YouTube) */
  thumbnail?: string
}

/** "1h2m3s", "90", "1:30" → seconds */
function seconds(t: string | null): number | undefined {
  if (!t) return undefined
  if (/^\d+$/.test(t)) return Number(t)
  const hms = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t)
  if (hms && (hms[1] || hms[2] || hms[3])) return Number(hms[1] ?? 0) * 3600 + Number(hms[2] ?? 0) * 60 + Number(hms[3] ?? 0)
  const colon = /^(?:(\d+):)?(\d+):(\d+)$/.exec(t)
  if (colon) return Number(colon[1] ?? 0) * 3600 + Number(colon[2]) * 60 + Number(colon[3])
  return undefined
}

/** What kind of video an address is – or null when it isn't one. */
export function videoInfo(address: string): VideoInfo | null {
  let u: URL
  try {
    u = new URL(address.trim())
  } catch {
    return null
  }
  if (!/^https?:$/.test(u.protocol)) return null
  const host = u.hostname.replace(/^(www|m|music)\./, '')
  // YouTube: watch?v=, youtu.be/, /embed/, /shorts/, /live/, /v/
  let yt: string | null = null
  if (host === 'youtu.be') yt = u.pathname.slice(1).split('/')[0]
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    yt = u.searchParams.get('v') ?? /^\/(?:embed|shorts|live|v)\/([\w-]+)/.exec(u.pathname)?.[1] ?? null
  }
  if (yt && /^[\w-]{6,20}$/.test(yt)) {
    const start = seconds(u.searchParams.get('t') ?? u.searchParams.get('start') ?? (/(?:^|&)t=([^&]+)/.exec(u.hash.slice(1))?.[1] ?? null))
    return {
      provider: 'youtube',
      id: yt,
      start,
      embedUrl: `https://www.youtube-nocookie.com/embed/${yt}?rel=0&playsinline=1${start ? `&start=${start}` : ''}`,
      watchUrl: `https://www.youtube.com/watch?v=${yt}${start ? `&t=${start}s` : ''}`,
      thumbnail: `https://i.ytimg.com/vi/${yt}/hqdefault.jpg`,
    }
  }
  // Vimeo: vimeo.com/123, vimeo.com/channels/x/123, player.vimeo.com/video/123
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const id = /\/(?:video\/)?(\d{5,})(?:\/|$)/.exec(u.pathname)?.[1]
    if (id) {
      const hash = u.searchParams.get('h') ?? /^\/\d+\/(\w+)/.exec(u.pathname)?.[1]
      return { provider: 'vimeo', id, embedUrl: `https://player.vimeo.com/video/${id}?playsinline=1${hash ? `&h=${hash}` : ''}`, watchUrl: `https://vimeo.com/${id}` }
    }
  }
  // a video file
  if (/\.(mp4|m4v|mov|webm|ogv)$/i.test(u.pathname)) return { provider: 'file', embedUrl: u.href, watchUrl: u.href }
  return null
}
