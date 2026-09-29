import type { AssistantDependencies } from './assistant/routes.ts'
import type { Auth } from './auth.ts'
import type { ServerConfig } from './config.ts'
import type { ProjectStore } from './projects.ts'
import { Hono } from 'hono'
import { assistantRoutes } from './assistant/routes.ts'
import { projectRoutes } from './routes.ts'

/** What the web app may offer on its sign in page. */
export interface PublicConfig {
  email: boolean
  google: boolean
  github: boolean
  /** Whether signed in people can use the deck assistant. */
  assistant: boolean
}

export interface AppDependencies {
  config: ServerConfig
  auth: Auth
  projects: ProjectStore
  emailEnabled: boolean
  /** The deck assistant, when it is on. */
  assistant?: Omit<AssistantDependencies, 'auth' | 'projects'>
}

export function createApp({ config, auth, projects, emailEnabled, assistant }: AppDependencies) {
  const app = new Hono().basePath('/api')

  app.get('/health', c => c.json({ ok: true }))

  app.get('/config', c => c.json<PublicConfig>({
    email: emailEnabled,
    google: Boolean(config.google),
    github: Boolean(config.github),
    assistant: Boolean(assistant),
  }))

  app.on(['GET', 'POST'], '/auth/*', c => auth.handler(c.req.raw))

  app.route('/', projectRoutes(auth, projects))
  if (assistant)
    app.route('/', assistantRoutes({ ...assistant, auth, projects }))

  app.notFound(c => c.json({ error: 'Not found' }, 404))

  return app
}

export type App = ReturnType<typeof createApp>
