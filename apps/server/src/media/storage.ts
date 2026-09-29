import { AwsClient } from 'aws4fetch'

/**
 * Where uploaded files live. Cloudflare R2 in production, memory in tests.
 * People upload and download straight to and from storage with signed
 * links, so large files never pass through the API.
 */
export interface MediaStorage {
  /** A link that accepts one PUT of exactly this type and size. */
  uploadUrl: (key: string, type: string, size: number, expiresSeconds: number) => Promise<string>
  /** A link that downloads the file. */
  downloadUrl: (key: string, expiresSeconds: number) => Promise<string>
  /** The stored file's size, or undefined when nothing is stored under the key. */
  size: (key: string) => Promise<number | undefined>
  /** The file's first bytes, for checking its type. */
  head: (key: string, count: number) => Promise<Uint8Array>
  delete: (key: string) => Promise<void>
}

export interface R2Settings {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  /** The S3 endpoint. Defaults to the account's R2 endpoint. */
  endpoint?: string
}

export class StorageError extends Error {}

/** Cloudflare R2 through its S3 API, signed with SigV4. */
export class R2MediaStorage implements MediaStorage {
  private readonly client: AwsClient
  private readonly base: string

  constructor({ accountId, accessKeyId, secretAccessKey, bucket, endpoint }: R2Settings) {
    this.client = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' })
    this.base = `${(endpoint ?? `https://${accountId}.r2.cloudflarestorage.com`).replace(/\/$/, '')}/${encodeURIComponent(bucket)}`
  }

  private url(key: string, expiresSeconds?: number) {
    const url = new URL(`${this.base}/${key.split('/').map(encodeURIComponent).join('/')}`)
    if (expiresSeconds)
      url.searchParams.set('X-Amz-Expires', String(expiresSeconds))
    return url
  }

  async uploadUrl(key: string, type: string, size: number, expiresSeconds: number) {
    // Signing the type and size makes R2 refuse any other file on this link.
    const signed = await this.client.sign(this.url(key, expiresSeconds).href, {
      method: 'PUT',
      headers: { 'content-type': type, 'content-length': String(size) },
      aws: { signQuery: true, allHeaders: true },
    })
    return signed.url
  }

  async downloadUrl(key: string, expiresSeconds: number) {
    const signed = await this.client.sign(this.url(key, expiresSeconds).href, { method: 'GET', aws: { signQuery: true } })
    return signed.url
  }

  async size(key: string) {
    const response = await this.client.fetch(this.url(key).href, { method: 'HEAD' })
    if (response.status === 404)
      return undefined
    if (!response.ok)
      throw new StorageError(`R2 answered ${response.status} to HEAD`)
    return Number(response.headers.get('content-length'))
  }

  async head(key: string, count: number) {
    const response = await this.client.fetch(this.url(key).href, { headers: { range: `bytes=0-${count - 1}` } })
    if (!response.ok)
      throw new StorageError(`R2 answered ${response.status} to GET`)
    return new Uint8Array(await response.arrayBuffer()).subarray(0, count)
  }

  async delete(key: string) {
    const response = await this.client.fetch(this.url(key).href, { method: 'DELETE' })
    if (!response.ok && response.status !== 404)
      throw new StorageError(`R2 answered ${response.status} to DELETE`)
  }
}
