import type { Kysely } from 'kysely'
import type { ServerConfig } from './config.ts'
import type { Mailer } from './mailer.ts'
import { oauthProvider } from '@better-auth/oauth-provider'
import { betterAuth } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { getMigrations } from 'better-auth/db/migration'
import { jwt } from 'better-auth/plugins/jwt'
import { magicLink } from 'better-auth/plugins/magic-link'
import { magicLinkEmail, resetPasswordEmail, verificationEmail } from './emails.ts'

export interface AuthDependencies {
  config: ServerConfig
  db: Kysely<any>
  /** Without a mailer, sign in that needs email (password and magic link) is off. */
  mailer?: Mailer
  /** Runs after every sign in by someone whose email address is confirmed, for example to turn invites into access. */
  onConfirmedSignIn?: (user: { id: string, email: string }) => Promise<void>
}

export const MAGIC_LINK_SECONDS = 10 * 60
export const RESET_PASSWORD_SECONDS = 60 * 60
/** How long an access token lasts, for Claude Code, other MCP clients and the Deyslide apps. They refresh it on their own. */
export const MCP_ACCESS_TOKEN_SECONDS = 60 * 60
/** How long an MCP client or a Deyslide app stays signed in without being used. */
export const MCP_REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60
/** How long a refresh token that was just used still gives the same answer. */
export const REFRESH_TOKEN_REUSE_SECONDS = 10

/** The MCP endpoint. Access tokens name it as their audience. */
export function mcpUrl(config: Pick<ServerConfig, 'publicUrl'>) {
  return `${config.publicUrl}/mcp`
}

/** The API, as an OAuth resource. Access tokens for the Deyslide apps name it as their audience. */
export function apiUrl(config: Pick<ServerConfig, 'publicUrl'>) {
  return `${config.publicUrl}/api`
}

/** Where the Android app gets the answer to a sign in: its own scheme, the app identifier. */
const ANDROID_APP_REDIRECT = 'id.bambanggunawan.deyslide:/oauth/callback'

/** Where the desktop app gets the answer to a sign in: a loopback address on any port. */
const DESKTOP_APP_REDIRECT = /^http:\/\/127\.0\.0\.1(?::\d{1,5})?\/callback$/

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * The OAuth issuer: Better Auth's base URL, on https unless the host is
 * loopback, the same rule the OAuth provider applies to the tokens it signs.
 */
export function authIssuer(config: Pick<ServerConfig, 'publicUrl'>) {
  const url = new URL(`${config.publicUrl}/api/auth`)
  if (url.protocol !== 'https:' && !LOOPBACK_HOSTS.has(url.hostname))
    url.protocol = 'https:'
  return url.href.replace(/\/$/, '')
}

/** A redirect URI only an app on the person's own computer can receive: loopback http or an app's own scheme. */
function isNativeRedirect(uri: unknown) {
  try {
    const url = new URL(String(uri))
    if (url.protocol === 'https:')
      return false
    return url.protocol === 'http:' ? LOOPBACK_HOSTS.has(url.hostname) : true
  }
  catch {
    return false
  }
}

/**
 * MCP clients such as Claude Code register without an application type and
 * with a loopback redirect URI. The OAuth provider would treat them as web
 * apps, which may not use loopback addresses, so they register as native.
 */
function withNativeType<T extends { application_type?: string, redirect_uris?: unknown }>(body: T): T {
  const uris = body.redirect_uris
  if (body.application_type || !Array.isArray(uris) || uris.length === 0 || !uris.every(isNativeRedirect))
    return body
  return { ...body, application_type: 'native' }
}

/** The addresses the Deyslide apps get answers at. Both stay on the person's own device. */
function isAppRedirect(uri: unknown) {
  return uri === ANDROID_APP_REDIRECT || (typeof uri === 'string' && DESKTOP_APP_REDIRECT.test(uri))
}

function refuseClientMetadata(description: string): never {
  throw new APIError('BAD_REQUEST', { error: 'invalid_client_metadata', error_description: description })
}

const NOT_AN_APP = 'Only the Deyslide apps may use the API resource: a native client whose redirect URIs are http://127.0.0.1/callback or id.bambanggunawan.deyslide:/oauth/callback.'

/** Whether an authorization request names at least one resource. */
function namesResource(params: Record<string, unknown>) {
  return [params.resource].flat().some(resource => typeof resource === 'string' && resource !== '')
}

/**
 * Keeps the API resource, which reaches the whole account, for the Deyslide
 * apps. Anyone may register a client and choose its name, so the redirect
 * URIs decide: a page on the web cannot receive an answer meant for an app
 * on the person's own device.
 */
function oauthClientRules(config: Pick<ServerConfig, 'publicUrl'>) {
  const api = apiUrl(config)
  return createAuthMiddleware(async (ctx) => {
    /** Whether the client registered with the API resource. */
    async function reachesApi(clientId: string) {
      const links = await ctx.context.adapter.findMany({
        model: 'oauthClientResource',
        where: [{ field: 'clientId', value: clientId }, { field: 'resourceId', value: api }],
        limit: 1,
      })
      return links.length > 0
    }

    if (ctx.path === '/oauth2/register' && ctx.body) {
      const body = withNativeType(ctx.body as { application_type?: string, redirect_uris?: unknown, resources?: unknown })
      const resources = Array.isArray(body.resources) ? body.resources : []
      if (resources.includes(api)) {
        const uris = body.redirect_uris
        if (body.application_type !== 'native' || !Array.isArray(uris) || uris.length === 0 || !uris.every(isAppRedirect))
          refuseClientMetadata(NOT_AN_APP)
      }
      if (body !== ctx.body)
        return { context: { body } }
    }

    // The owner of a client may change it later. A client with the API
    // resource must keep answering at the apps' addresses.
    if (ctx.path === '/oauth2/update-client' && ctx.body) {
      const { client_id: clientId, update } = ctx.body as { client_id?: unknown, update?: { application_type?: unknown, redirect_uris?: unknown } }
      if (typeof clientId !== 'string' || !update || (update.application_type === undefined && update.redirect_uris === undefined))
        return
      if (!await reachesApi(clientId))
        return
      const uris = update.redirect_uris
      if ((update.application_type !== undefined && update.application_type !== 'native') || (uris !== undefined && (!Array.isArray(uris) || !uris.every(isAppRedirect))))
        refuseClientMetadata(NOT_AN_APP)
    }

    // When a client linked to the API leaves the resource out, the request
    // is taken as asking for the API. Otherwise the consent page would show
    // the short MCP list while the token endpoint still hands out an API
    // token later, since the provider checks a resource sent there only
    // against those approved here. The request comes as a query, or as a
    // form when posted.
    if (ctx.path === '/oauth2/authorize') {
      const named: { query?: Record<string, unknown>, body?: Record<string, unknown> } = {}
      for (const part of ['query', 'body'] as const) {
        const params = ctx[part] as Record<string, unknown> | undefined
        if (params && typeof params.client_id === 'string' && !namesResource(params) && await reachesApi(params.client_id))
          named[part] = { ...params, resource: api }
      }
      if (named.query || named.body)
        return { context: named }
    }
  })
}

export function createAuth({ config, db, mailer, onConfirmedSignIn }: AuthDependencies) {
  const socialProviders = {
    ...(config.google && { google: config.google }),
    ...(config.github && { github: config.github }),
  }

  return betterAuth({
    appName: 'Deyslide',
    baseURL: config.publicUrl,
    basePath: '/api/auth',
    secret: config.authSecret,
    trustedOrigins: [config.publicUrl],
    database: { db, type: 'postgres' },
    emailAndPassword: {
      enabled: Boolean(mailer),
      requireEmailVerification: true,
      minPasswordLength: 8,
      resetPasswordTokenExpiresIn: RESET_PASSWORD_SECONDS,
      sendResetPassword: async ({ user, url }) => {
        await mailer?.send(resetPasswordEmail(user.email, url))
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      // Signing in before confirming sends a fresh link, so an expired one is not a dead end.
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await mailer?.send(verificationEmail(user.email, url))
      },
    },
    socialProviders,
    hooks: { before: oauthClientRules(config) },
    databaseHooks: {
      session: {
        create: {
          after: async (session) => {
            if (!onConfirmedSignIn)
              return
            const user = await db.selectFrom('user').select(['id', 'email', 'emailVerified']).where('id', '=', session.userId).executeTakeFirst()
            if (user?.emailVerified)
              await onConfirmedSignIn({ id: user.id, email: user.email })
          },
        },
      },
    },
    // Better Auth's own JWT endpoint is not used. The OAuth provider signs access tokens with its keys.
    disabledPaths: ['/token'],
    plugins: [
      jwt(),
      // Claude Code, other MCP clients and the Deyslide apps sign people in
      // through the browser: they register themselves, send people to the
      // sign in page and then the consent page, and get a token for one
      // resource. MCP clients get the MCP endpoint; the apps get the API.
      oauthProvider({
        loginPage: `${config.publicUrl}/sign-in`,
        consentPage: `${config.publicUrl}/oauth/consent`,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        resources: [mcpUrl(config), apiUrl(config)],
        // Clients that register themselves get the MCP endpoint. Only the
        // apps may add the API, which `oauthClientRules` checks.
        clientRegistrationDefaultResources: [mcpUrl(config)],
        clientRegistrationAllowedResources: [mcpUrl(config), apiUrl(config)],
        accessTokenExpiresIn: MCP_ACCESS_TOKEN_SECONDS,
        refreshTokenExpiresIn: MCP_REFRESH_TOKEN_SECONDS,
        // Refresh tokens change on every use. A second use within this many
        // seconds gets the same answer, so two requests that refresh at the
        // same moment do not sign the app out.
        refreshTokenReuseInterval: REFRESH_TOKEN_REUSE_SECONDS,
      }),
      ...(mailer
        ? [magicLink({
            expiresIn: MAGIC_LINK_SECONDS,
            sendMagicLink: async ({ email, url }) => {
              await mailer.send(magicLinkEmail(email, url))
            },
          })]
        : []),
    ],
    rateLimit: { enabled: config.production },
    advanced: {
      useSecureCookies: config.publicUrl.startsWith('https:'),
      // Every request reaches the pod through the Cloudflare tunnel, which
      // sets this header to the visitor's address.
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
      // The server migrates on every start, before it serves requests, so a
      // check at construction would only see the schema from before that.
      database: { validateSchema: false },
    },
  })
}

export type Auth = ReturnType<typeof createAuth>

/** Creates or updates Better Auth's tables. */
export async function migrateAuth(auth: Auth) {
  const { runMigrations } = await getMigrations(auth.options)
  await runMigrations()
}
