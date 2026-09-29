import type { MediaStorage } from '../../apps/server/src/media/storage'

/** Media storage in memory. Links point at a fake host; scenarios "upload" with `put`. */
export class FakeMediaStorage implements MediaStorage {
  readonly files = new Map<string, Uint8Array>()
  readonly links: { kind: 'upload' | 'download', key: string, type?: string, size?: number, expiresSeconds: number }[] = []

  async uploadUrl(key: string, type: string, size: number, expiresSeconds: number) {
    this.links.push({ kind: 'upload', key, type, size, expiresSeconds })
    return `https://storage.test/${key}?upload`
  }

  async downloadUrl(key: string, expiresSeconds: number) {
    this.links.push({ kind: 'download', key, expiresSeconds })
    return `https://storage.test/${key}?download`
  }

  /** What a browser does with an upload link. */
  put(key: string, bytes: Uint8Array) {
    this.files.set(key, bytes)
  }

  async size(key: string) {
    return this.files.get(key)?.byteLength
  }

  async head(key: string, count: number) {
    return (this.files.get(key) ?? new Uint8Array()).subarray(0, count)
  }

  async delete(key: string) {
    this.files.delete(key)
  }
}

const PNG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]

/** Bytes that start like a real file of the kind, padded to `size`. */
export function sampleFile(kind: 'png' | 'pdf', size: number) {
  const bytes = new Uint8Array(size)
  bytes.set(kind === 'png' ? PNG : [...'%PDF-1.7'].map(char => char.charCodeAt(0)))
  return bytes
}
