import type { Auth } from './auth.ts'
import type { ServerConfig } from './config.ts'
import { Hono } from 'hono'

/** What the web app may offer on its sign in page. */
export interface PublicConfig {
  email: boolean
  google: boolean
  github: boolean
}

export interface AppDependencies {
  config: ServerConfig
  auth: Auth
  emailEnabled: boolean
}

export function createApp({ config, auth, emailEnabled }: AppDependencies) {
  const app = new Hono().basePath('/api')

  app.get('/health', c => c.json({ ok: true }))

  app.get('/config', c => c.json<PublicConfig>({
    email: emailEnabled,
    google: Boolean(config.google),
    github: Boolean(config.github),
  }))

  app.on(['GET', 'POST'], '/auth/*', c => auth.handler(c.req.raw))

  app.notFound(c => c.json({ error: 'Not found' }, 404))

  return app
}

export type App = ReturnType<typeof createApp>
