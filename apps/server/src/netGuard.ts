import dns from 'node:dns/promises'
import net from 'node:net'

/**
 * Your own network, kept out of web imports
 * =========================================
 *
 * A page being imported could name "pictures" at addresses inside your network
 * (http://192.168.1.1/…, the router; http://localhost:…, the server itself) –
 * and the server, which sits inside it, would ask for them. Imports from the
 * internet may only reach the internet: these addresses are refused – unless
 * the page you're importing is on your own network itself.
 */

/** An address in a private, local or reserved range (IPv4 or IPv6). */
export function isPrivateIp(ip: string): boolean {
  const v4 = net.isIPv4(ip) ? ip : /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1]
  if (v4) {
    const [a, b] = v4.split('.').map(Number)
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT (and Tailscale)
      (a === 169 && b === 254) || // link-local
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224 // multicast, reserved
    )
  }
  const v6 = ip.toLowerCase()
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6)
}

/** Whether a host (a name or an address) is on your own network – every address it has. */
export async function isPrivateHost(host: string): Promise<boolean> {
  const h = host.replace(/^\[|\]$/g, '')
  if (/^localhost$|\.localhost$|\.local$|\.lan$|\.home\.arpa$|\.internal$/i.test(h)) return true
  if (net.isIP(h)) return isPrivateIp(h)
  try {
    const all = await dns.lookup(h, { all: true })
    return all.some((a) => isPrivateIp(a.address))
  } catch {
    // can't be looked up: the fetch will say so
    return false
  }
}

/** Refuse an address on your own network (when the import isn't from it). */
export async function guardAddress(url: string, allowPrivate: boolean): Promise<void> {
  if (allowPrivate) return
  const u = new URL(url)
  if (await isPrivateHost(u.hostname)) throw new Error(`${u.host} is on your own network – a page from the internet can’t make the server reach it`)
}
