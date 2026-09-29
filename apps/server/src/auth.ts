import type { Kysely } from 'kysely'
import type { ServerConfig } from './config.ts'
import type { Mailer } from './mailer.ts'
import { oauthProvider } from '@better-auth/oauth-provider'
import { betterAuth } from 'better-auth'
import { createAuthMiddleware } from 'better-auth/api'
import { getMigrations } from 'better-auth/db/migration'
import { jwt } from 'better-auth/plugins/jwt'
import { magicLink } from 'better-auth/plugins/magic-link'
import { magicLinkEmail, resetPasswordEmail, verificationEmail } from './emails.ts'

export interface AuthDependencies {
  config: ServerConfig
  db: Kysely<any>
  /** Without a mailer, sign in that needs email (password and magic link) is off. */
  mailer?: Mailer
}

export const MAGIC_LINK_SECONDS = 10 * 60
export const RESET_PASSWORD_SECONDS = 60 * 60
/** How long an access token for Claude Code and other MCP clients lasts. They refresh it on their own. */
export const MCP_ACCESS_TOKEN_SECONDS = 60 * 60
/** How long an MCP client stays connected without being used. */
export const MCP_REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60

/** The MCP endpoint. Access tokens name it as their audience. */
export function mcpUrl(config: Pick<ServerConfig, 'publicUrl'>) {
  return `${config.publicUrl}/mcp`
}

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
const registerMcpClientsAsNative = createAuthMiddleware(async (ctx) => {
  const body = ctx.body as { application_type?: string, redirect_uris?: unknown } | undefined
  if (ctx.path !== '/oauth2/register' || !body || body.application_type)
    return
  const uris = body.redirect_uris
  if (Array.isArray(uris) && uris.length > 0 && uris.every(isNativeRedirect))
    return { context: { body: { ...body, application_type: 'native' } } }
})

export function createAuth({ config, db, mailer }: AuthDependencies) {
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
    hooks: { before: registerMcpClientsAsNative },
    // Better Auth's own JWT endpoint is not used. The OAuth provider signs access tokens with its keys.
    disabledPaths: ['/token'],
    plugins: [
      jwt(),
      // Claude Code and other MCP clients sign people in through the browser:
      // they register themselves, send people to the sign in page and then the
      // consent page, and get a token for the MCP endpoint only.
      oauthProvider({
        loginPage: `${config.publicUrl}/sign-in`,
        consentPage: `${config.publicUrl}/oauth/consent`,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        resources: [mcpUrl(config)],
        // Clients that register themselves may ask for tokens for the MCP endpoint, and nothing else.
        clientRegistrationDefaultResources: [mcpUrl(config)],
        clientRegistrationAllowedResources: [mcpUrl(config)],
        accessTokenExpiresIn: MCP_ACCESS_TOKEN_SECONDS,
        refreshTokenExpiresIn: MCP_REFRESH_TOKEN_SECONDS,
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
