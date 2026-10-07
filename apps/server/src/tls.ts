import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import type { Config } from './config'

/**
 * HTTPS on a private address
 * ==========================
 *
 * Over WireGuard (or any VPN / home network) the server has a private
 * address like 10.8.0.1, which public certificate authorities such as
 * Let's Encrypt won't issue certificates for. So the server can be its own
 * small certificate authority:
 *
 *   reconnotes-server https-setup [address or name …]
 *
 * makes (once) a private CA in <data>/tls/ca.crt + ca.key, and a server
 * certificate for the addresses given – by default every address this
 * machine has, WireGuard's included. Install ca.crt on each device once
 * (the server offers it at http://<address>:8787/ca.crt) and browsers and the
 * app trust https://<address>:8443 like any website. Run it again to add an
 * address or renew (the certificate lasts 825 days, Apple's limit); devices
 * keep trusting the same CA.
 *
 * Or bring your own certificate: RECON_TLS_CERT and RECON_TLS_KEY.
 */

export function tlsDir(config: Config): string {
  return path.join(config.dataDir, 'tls')
}

/** The certificate and key to serve HTTPS with, if there are any. */
export function loadTls(config: Config): { cert: Buffer; key: Buffer; file: string } | null {
  const cert = config.tlsCert ?? path.join(tlsDir(config), 'server.crt')
  const key = config.tlsKey ?? path.join(tlsDir(config), 'server.key')
  if (!fs.existsSync(cert) || !fs.existsSync(key)) return null
  return { cert: fs.readFileSync(cert), key: fs.readFileSync(key), file: cert }
}

/** The private CA's certificate (to install on devices), if the server made one. */
export function caCertificate(config: Config): Buffer | null {
  const f = path.join(tlsDir(config), 'ca.crt')
  return fs.existsSync(f) ? fs.readFileSync(f) : null
}

/** Every address of this machine – WireGuard's first, then the other IPv4 ones – plus its name and localhost. */
export function defaultNames(): string[] {
  const all = Object.entries(os.networkInterfaces()).flatMap(([name, list]) => (list ?? []).map((a) => ({ name, ...a })))
  const rank = (a: (typeof all)[number]) => (a.internal ? 3 : /^wg|wireguard|tun/i.test(a.name) ? 0 : a.family === 'IPv4' ? 1 : 2)
  const ips = all
    .filter((a) => !a.address.startsWith('fe80'))
    .sort((a, b) => rank(a) - rank(b))
    .map((a) => a.address)
  return [...new Set([...ips, 'localhost', os.hostname()])]
}

/** The address to suggest: the first one that isn't this machine talking to itself. */
export function suggestedAddress(names: string[]): string {
  return names.find((n) => net.isIPv4(n) && !n.startsWith('127.')) ?? names.find((n) => n !== 'localhost') ?? names[0]
}

const openssl = (args: string[], cwd: string) => execFileSync('openssl', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })

/** Make the CA (first time) and a server certificate for these addresses / names. Returns the CA certificate's path. */
export function setupHttps(config: Config, names: string[]): { ca: string; cert: string; names: string[]; newCa: boolean } {
  try {
    openssl(['version'], os.tmpdir())
  } catch {
    throw new Error('openssl is needed: sudo apt install openssl')
  }
  const dir = tlsDir(config)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const list = [...new Set(names.map((n) => n.trim()).filter(Boolean))]
  if (!list.length) throw new Error('No address or name to make the certificate for.')
  for (const n of list) if (!net.isIP(n) && !/^[a-z0-9*]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9-]+)*$/i.test(n)) throw new Error(`“${n}” isn't an IP address or host name.`)

  let newCa = false
  if (!fs.existsSync(path.join(dir, 'ca.crt')) || !fs.existsSync(path.join(dir, 'ca.key'))) {
    openssl(
      [
        'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
        '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '3650',
        '-subj', `/CN=ReconNotes private CA (${os.hostname()})`,
        '-addext', 'basicConstraints=critical,CA:TRUE',
        '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
      ],
      dir,
    )
    newCa = true
  }
  const san = list.map((n) => (net.isIP(n) ? `IP:${n}` : `DNS:${n}`)).join(',')
  fs.writeFileSync(
    path.join(dir, 'server.ext'),
    `subjectAltName=${san}\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`,
  )
  openssl(['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'server.key.new', '-out', 'server.csr', '-subj', `/CN=${list[0]}`], dir)
  // 825 days: the longest Apple devices accept
  openssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.crt.new', '-days', '825', '-sha256', '-extfile', 'server.ext'], dir)
  fs.renameSync(path.join(dir, 'server.key.new'), path.join(dir, 'server.key'))
  fs.renameSync(path.join(dir, 'server.crt.new'), path.join(dir, 'server.crt'))
  for (const f of ['ca.key', 'server.key']) fs.chmodSync(path.join(dir, f), 0o600)
  fs.rmSync(path.join(dir, 'server.csr'), { force: true })
  // run with sudo: the files belong to whoever runs the server (the owner of the data folder)
  if (process.getuid?.() === 0) {
    const owner = fs.statSync(config.dataDir)
    if (owner.uid !== 0) for (const f of ['', ...fs.readdirSync(dir)]) fs.chownSync(path.join(dir, f), owner.uid, owner.gid)
  }
  return { ca: path.join(dir, 'ca.crt'), cert: path.join(dir, 'server.crt'), names: list, newCa }
}
