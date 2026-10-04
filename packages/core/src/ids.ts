const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/**
 * Collision-resistant id: millisecond timestamp prefix (so ids sort roughly by
 * creation) followed by 12 random base36 characters.
 */
export function newId(): string {
  const bytes = new Uint8Array(12)
  globalThis.crypto.getRandomValues(bytes)
  let rand = ''
  for (const b of bytes) rand += ALPHABET[b % 36]
  return Date.now().toString(36) + rand
}
