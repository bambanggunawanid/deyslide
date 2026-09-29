import type { ServerConfig } from '../../apps/server/src/config'
import type { Email, Mailer } from '../../apps/server/src/mailer'
import { PGlite } from '@electric-sql/pglite'
import { Kysely } from 'kysely'
import { PGliteDialect } from 'kysely-pglite-dialect'
import { readConfig } from '../../apps/server/src/config'
import { createServer } from '../../apps/server/src/server'

export const TEST_ORIGIN = 'http://deyslide.test'

/** Keeps every email so a scenario can open the links in it. */
export class MemoryMailer implements Mailer {
  readonly sent: Email[] = []

  async send(email: Email) {
    this.sent.push(email)
  }

  last(to: string): Email {
    const email = this.sent.findLast(item => item.to === to)
    if (!email)
      throw new Error(`No email was sent to ${to}`)
    return email
  }

  /** The first link in the plain text part. */
  static link(email: Email): string {
    const url = email.text.match(/https?:\/\/\S+/)?.[0]
    if (!url)
      throw new Error(`No link in "${email.subject}"`)
    return url
  }
}

export interface TestServerOptions {
  email?: boolean
  env?: Record<string, string>
}

let template: Promise<PGlite> | undefined

/**
 * Starting PGlite takes seconds and cloning it takes a fraction of that,
 * so each test worker migrates one database and clones it per scenario.
 */
function migratedTemplate() {
  template ??= (async () => {
    const pglite = new PGlite()
    const db = new Kysely<any>({ dialect: new PGliteDialect(pglite) })
    await createServer({ config: readConfig({ PUBLIC_URL: TEST_ORIGIN }), db, mailer: new MemoryMailer() })
    return pglite
  })()
  return template
}

/**
 * Starts the template database. Call it from `beforeAll` with a generous
 * timeout, so the first scenario step does not pay for it.
 */
export const DATABASE_WARM_UP_MS = 60_000
export async function warmUpDatabase() {
  await migratedTemplate()
}

/** A full API on an in-memory Postgres (PGlite), with an empty database. */
export async function createTestServer({ email = true, env = {} }: TestServerOptions = {}) {
  const config: ServerConfig = readConfig({ PUBLIC_URL: TEST_ORIGIN, ...env })
  // clone() returns a full PGlite, typed only as its interface.
  const pglite = await (await migratedTemplate()).clone() as PGlite
  const db = new Kysely<any>({ dialect: new PGliteDialect(pglite) })
  const mailer = email ? new MemoryMailer() : undefined
  const { app } = await createServer({ config, db, mailer })
  return { app, db, mailer, config }
}

export type TestServer = Awaited<ReturnType<typeof createTestServer>>

/**
 * A browser for the API: keeps cookies, sends the Origin header like a
 * browser would, and does not follow redirects so scenarios can check them.
 */
export class TestBrowser {
  private readonly cookies = new Map<string, string>()

  constructor(private readonly server: TestServer) {}

  async request(path: string, init: { method?: string, json?: unknown } = {}) {
    const url = path.startsWith('http') ? path : `${TEST_ORIGIN}${path}`
    const headers = new Headers({ origin: TEST_ORIGIN })
    if (this.cookies.size)
      headers.set('cookie', [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '))
    if (init.json !== undefined)
      headers.set('content-type', 'application/json')
    const response = await this.server.app.request(url, {
      method: init.method ?? (init.json === undefined ? 'GET' : 'POST'),
      headers,
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
      redirect: 'manual',
    })
    for (const cookie of response.headers.getSetCookie()) {
      const [pair, ...attributes] = cookie.split(';')
      const [name, ...value] = pair.split('=')
      const expired = attributes.some(attribute => /max-age=0\b/i.test(attribute.trim()))
      if (expired || value.join('=') === '')
        this.cookies.delete(name.trim())
      else
        this.cookies.set(name.trim(), value.join('='))
    }
    return response
  }

  /** The signed in user's email, or undefined. */
  async signedInEmail(): Promise<string | undefined> {
    const response = await this.request('/api/auth/get-session')
    const session = await response.json() as { user?: { email: string } } | null
    return session?.user?.email
  }
}
