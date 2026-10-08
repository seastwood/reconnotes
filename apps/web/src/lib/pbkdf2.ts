/**
 * PBKDF2-HMAC-SHA256 in plain JavaScript, for when the browser's own
 * (crypto.subtle) isn't there: browsers only offer it on secure pages, so a
 * server reached at http://<address> wouldn't let a locked folder open.
 * Same result as crypto.subtle; a few hundred milliseconds slower.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])
const IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
const W = new Uint32Array(64)

/** One SHA-256 block (16 words) into the state. */
function compress(state: Uint32Array, block: Uint32Array) {
  for (let i = 0; i < 16; i++) W[i] = block[i]
  for (let i = 16; i < 64; i++) {
    const a = W[i - 15], b = W[i - 2]
    const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3)
    const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10)
    W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0
  }
  let a = state[0], b = state[1], c = state[2], d = state[3], e = state[4], f = state[5], g = state[6], h = state[7]
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
    const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
    const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0
    h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0
  }
  state[0] += a; state[1] += b; state[2] += c; state[3] += d; state[4] += e; state[5] += f; state[6] += g; state[7] += h
}

/** SHA-256 of bytes, starting from `start` (a state) after `prefixBlocks` 64-byte blocks already in it. */
function sha256(data: Uint8Array, start: Uint32Array = new Uint32Array(IV), prefixBlocks = 0): Uint32Array {
  const state = new Uint32Array(start)
  const total = data.length + 9
  const padded = new Uint8Array(Math.ceil(total / 64) * 64)
  padded.set(data)
  padded[data.length] = 0x80
  const bits = (data.length + prefixBlocks * 64) * 8
  const dv = new DataView(padded.buffer)
  dv.setUint32(padded.length - 8, Math.floor(bits / 2 ** 32))
  dv.setUint32(padded.length - 4, bits >>> 0)
  const block = new Uint32Array(16)
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) block[i] = dv.getUint32(off + i * 4)
    compress(state, block)
  }
  return state
}

const toBytes = (words: Uint32Array) => {
  const out = new Uint8Array(words.length * 4)
  const dv = new DataView(out.buffer)
  words.forEach((w, i) => dv.setUint32(i * 4, w))
  return out
}

export function pbkdf2Sha256(password: Uint8Array, salt: Uint8Array, iterations: number): Uint8Array {
  // HMAC key: hashed if longer than a block, padded to a block
  let key = password.length > 64 ? toBytes(sha256(password)) : password
  const padKey = (x: number) => {
    const b = new Uint8Array(64)
    b.set(key)
    for (let i = 0; i < 64; i++) b[i] ^= x
    const w = new Uint32Array(16)
    const dv = new DataView(b.buffer)
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(i * 4)
    const s = new Uint32Array(IV)
    compress(s, w)
    return s
  }
  key = key.slice()
  // the states after the inner and outer pads: each HMAC then costs two blocks
  const inner = padKey(0x36)
  const outer = padKey(0x5c)
  const hmac = (msg: Uint8Array) => sha256(toBytes(sha256(msg, inner, 1)), outer, 1)
  // one 32-byte block of output (all that's needed here)
  const first = new Uint8Array(salt.length + 4)
  first.set(salt)
  first[salt.length + 3] = 1
  let u = hmac(first)
  const result = new Uint32Array(u)
  // the 32-byte messages after the first: padded once, reused
  const block = new Uint32Array(16)
  block[8] = 0x80000000
  block[15] = (64 + 32) * 8
  const st = new Uint32Array(8)
  for (let n = 1; n < iterations; n++) {
    block.set(u)
    st.set(inner)
    compress(st, block)
    block.set(st)
    const o = new Uint32Array(outer)
    compress(o, block)
    u = o
    for (let i = 0; i < 8; i++) result[i] ^= u[i]
  }
  return toBytes(result)
}
