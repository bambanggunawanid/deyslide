import type { Kysely } from 'kysely'
import type { ServerConfig } from './config.ts'
import type { Mailer } from './mailer.ts'
import { betterAuth } from 'better-auth'
import { getMigrations } from 'better-auth/db/migration'
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
    plugins: mailer
      ? [magicLink({
          expiresIn: MAGIC_LINK_SECONDS,
          sendMagicLink: async ({ email, url }) => {
            await mailer.send(magicLinkEmail(email, url))
          },
        })]
      : [],
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
