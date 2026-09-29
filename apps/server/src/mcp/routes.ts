import type { Auth } from '../auth.ts'
import type { ServerConfig } from '../config.ts'
import type { McpDependencies } from './tools.ts'
import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from '@better-auth/oauth-provider'
import { verifyJwsAccessToken } from 'better-auth/oauth2'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { Hono } from 'hono'
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
  // Tokens carry Better Auth's base URL as issuer. It equals `issuer` on https and loopback hosts.
  const tokenIssuer = `${config.publicUrl}/api/auth`

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

  /** The person an access token was issued to, when it is valid for this MCP endpoint. */
  async function tokenUser(authorization: string | undefined) {
    const token = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1]
    if (!token)
      return undefined
    try {
      const payload = await verifyJwsAccessToken(token, {
        jwksFetch: async () => (await auth.api.getJwks()),
        jwksCacheKey: auth,
        verifyOptions: { issuer: tokenIssuer, audience: resource },
      })
      return typeof payload.sub === 'string' && payload.sub ? payload.sub : undefined
    }
    catch {
      return undefined
    }
  }

  app.all('/mcp', async (c) => {
    const authorization = c.req.header('authorization')
    const userId = await tokenUser(authorization)
    if (!userId) {
      // Tells the client where to start signing in (RFC 6750 and RFC 9728).
      const challenge = [`Bearer resource_metadata="${protectedResourceMetadataUrl(config)}"`]
      if (authorization)
        challenge.push('error="invalid_token"', 'error_description="The access token is missing, expired or not for this server. Sign in again."')
      return c.json({ error: 'Sign in to Deyslide first' }, 401, { 'www-authenticate': challenge.join(', ') })
    }

    // Stateless: every request gets its own server bound to the signed in person.
    const server = createMcpServer(userId, tools)
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await server.connect(transport)
    try {
      return await transport.handleRequest(c.req.raw)
    }
    finally {
      void server.close()
    }
  })

  return app
}
