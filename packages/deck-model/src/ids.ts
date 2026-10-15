const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'
const LENGTH = 10

/**
 * A new slide (`s`) or element (`e`) id: the prefix, a dash and 10 random
 * URL safe characters, so ids made on different devices never collide.
 */
export function newId(prefix: 's' | 'e'): string {
  const bytes = crypto.getRandomValues(new Uint8Array(LENGTH))
  let id = `${prefix}-`
  for (const byte of bytes)
    id += ALPHABET[byte & 63]
  return id
}
