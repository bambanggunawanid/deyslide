import type { Auth } from '../auth.ts'
import type { ServerConfig } from '../config.ts'
import type { McpDependencies } from './tools.ts'
import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from '@better-auth/oauth-provider'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { Hono } from 'hono'
import { tokenUser } from '../access-token.ts'
import { authIssuer, mcpUrl } from '../auth.ts'
import { createMcpServer } from './tools.ts'

export interface McpRouteDependencies extends McpDependencies {
  config: ServerConfig
  auth: Auth
}

/** Where MCP clients read which authorization server protects /mcp (RFC 9728). */
export function protectedResourceMetadataUrl(config: Pick<ServerConfig, 'publicUrl'>) {
  return `${config.publicUrl}/.well-known/oauth-protected-resource/mcp`
}

/**
 * The MCP endpoint and the discovery documents MCP clients read before
 * they sign in. These live at the site root, outside /api.
 */
export function mcpRoutes({ config, auth, ...tools }: McpRouteDependencies) {
  const app = new Hono()
  const resource = mcpUrl(config)
  const issuer = authIssuer(config)

  const resourceMetadata = () => Response.json({
    resource,
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
    resource_name: 'Deyslide',
    resource_documentation: `${config.publicUrl}/`,
  }, { headers: { 'cache-control': 'public, max-age=3600', 'access-control-allow-origin': '*' } })

  // RFC 9728 puts the resource's path after the well-known name. Some clients ask at the root.
  app.get('/.well-known/oauth-protected-resource/mcp', resourceMetadata)
  app.get('/.well-known/oauth-protected-resource', resourceMetadata)

  // RFC 8414 puts the issuer's path (/api/auth) after the well-known name. OpenID
  // Connect clients append the well-known name to the issuer instead.
  const serverMetadata = oauthProviderAuthServerMetadata(auth, { headers: { 'access-control-allow-origin': '*' } })
  const openIdMetadata = oauthProviderOpenIdConfigMetadata(auth, { headers: { 'access-control-allow-origin': '*' } })
  for (const path of ['/.well-known/oauth-authorization-server/api/auth', '/.well-known/oauth-authorization-server'])
    app.get(path, c => serverMetadata(c.req.raw))
  for (const path of ['/.well-known/openid-configuration/api/auth', '/.well-known/openid-configuration', '/api/auth/.well-known/openid-configuration'])
    app.get(path, c => openIdMetadata(c.req.raw))

  app.all('/mcp', async (c) => {
    const authorization = c.req.header('authorization')
    const userId = await tokenUser(auth, config, authorization, resource)
    if (!userId) {
      // Tells the client where to start signing in (RFC 6750 and RFC 9728).
      const challenge = [`Bearer resource_metadata="${protectedResourceMetadataUrl(config)}"`]
      if (authorization)
        challenge.push('error="invalid_token"', 'error_description="The access token is missing, expired or not for this server. Sign in again."')
      return c.json({ error: 'Sign in to Deyslide first' }, 401, { 'www-authenticate': challenge.join(', ') })
    }

    // Stateless: every request gets its own server bound to the signed in
    // person. A client that starts a session gets an id, which it sends
    // back on every later request, so the tools can tell its sessions apart.
    const body = c.req.method === 'POST' ? await c.req.raw.clone().json().catch(() => undefined) : undefined
    const starting = [body].flat().some(message => (message as { method?: unknown } | undefined)?.method === 'initialize')
    const session = starting ? crypto.randomUUID() : c.req.header('mcp-session-id')
    const server = createMcpServer(userId, tools, session)
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await server.connect(transport)
    try {
      const response = await transport.handleRequest(c.req.raw, body === undefined ? undefined : { parsedBody: body })
      if (!starting || !response.ok)
        return response
      const headers = new Headers(response.headers)
      headers.set('mcp-session-id', session!)
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
    }
    finally {
      void server.close()
    }
  })

  return app
}
