import type { AssistantDependencies } from './assistant/routes.ts'
import type { Auth } from './auth.ts'
import type { ServerConfig } from './config.ts'
import type { MediaStore } from './media/store.ts'
import type { McpDependencies } from './mcp/tools.ts'
import type { ProjectStore } from './projects.ts'
import type { SharingStore } from './sharing.ts'
import { Hono } from 'hono'
import { assistantRoutes } from './assistant/routes.ts'
import { mcpRoutes } from './mcp/routes.ts'
import { mediaRoutes } from './media/routes.ts'
import { projectRoutes } from './routes.ts'
import { sharingRoutes } from './sharing-routes.ts'

/** What the web app may offer on its sign in page. */
export interface PublicConfig {
  email: boolean
  google: boolean
  github: boolean
  /** Whether signed in people can use the deck assistant. */
  assistant: boolean
  /** Whether signed in people can upload media. */
  media: boolean
}

export interface AppDependencies {
  config: ServerConfig
  auth: Auth
  projects: ProjectStore
  sharing: SharingStore
  emailEnabled: boolean
  /** The deck assistant, when it is on. */
  assistant?: Omit<AssistantDependencies, 'auth' | 'projects'>
  /** The MCP server for Claude Code and other agents. */
  mcp: McpDependencies
  /** Media uploads, when storage is set up. */
  media?: MediaStore
}

export function createApp({ config, auth, projects, sharing, emailEnabled, assistant, mcp, media }: AppDependencies) {
  const app = new Hono().basePath('/api')

  app.get('/health', c => c.json({ ok: true }))

  app.get('/config', c => c.json<PublicConfig>({
    email: emailEnabled,
    google: Boolean(config.google),
    github: Boolean(config.github),
    assistant: Boolean(assistant),
    media: Boolean(media),
  }))

  app.on(['GET', 'POST'], '/auth/*', c => auth.handler(c.req.raw))

  app.route('/', projectRoutes(auth, projects, media))
  app.route('/', sharingRoutes(auth, projects, sharing))
  if (assistant)
    app.route('/', assistantRoutes({ ...assistant, auth, projects }))
  if (media)
    app.route('/', mediaRoutes(auth, media))

  // The MCP endpoint and its discovery documents live at the site root. They
  // come first, since one of them sits under /api/auth.
  const root = new Hono()
  root.route('/', mcpRoutes({ ...mcp, config, auth }))
  root.route('/', app)
  root.notFound(c => c.json({ error: 'Not found' }, 404))

  return root
}

export type App = ReturnType<typeof createApp>
