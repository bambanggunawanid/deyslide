import { z } from 'zod'

const optional = z.string().trim().optional().transform(value => value || undefined)

const EnvSchema = z.object({
  NODE_ENV: optional,
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default('127.0.0.1'),
  /** The address people open, for example https://deyslide.bambanggunawan.id. */
  PUBLIC_URL: z.url().default('http://localhost:5173'),
  BETTER_AUTH_SECRET: optional,
  EMAIL_FROM: z.email().default('noreply@bambanggunawan.id'),
  CLOUDFLARE_ACCOUNT_ID: optional,
  CLOUDFLARE_EMAIL_TOKEN: optional,
  GOOGLE_CLIENT_ID: optional,
  GOOGLE_CLIENT_SECRET: optional,
  GH_OAUTH_CLIENT_ID: optional,
  GH_OAUTH_CLIENT_SECRET: optional,
})

export interface OAuthCredentials {
  clientId: string
  clientSecret: string
}

export interface ServerConfig {
  production: boolean
  port: number
  host: string
  publicUrl: string
  authSecret: string
  emailFrom: string
  cloudflareEmail?: { accountId: string, token: string }
  google?: OAuthCredentials
  github?: OAuthCredentials
}

/** Development only. Production refuses to start without a real secret. */
const DEVELOPMENT_SECRET = 'deyslide-development-secret-do-not-use-in-production'

function pair(id: string | undefined, secret: string | undefined): OAuthCredentials | undefined {
  return id && secret ? { clientId: id, clientSecret: secret } : undefined
}

export class ConfigError extends Error {}

/** Reads the server settings from environment variables. */
export function readConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success)
    throw new ConfigError(`Invalid server settings:\n${z.prettifyError(parsed.error)}`)
  const values = parsed.data
  const production = values.NODE_ENV === 'production'

  if (production && (!values.BETTER_AUTH_SECRET || values.BETTER_AUTH_SECRET.length < 32))
    throw new ConfigError('BETTER_AUTH_SECRET must be set to at least 32 characters in production')

  return {
    production,
    port: values.PORT,
    host: values.HOST,
    publicUrl: values.PUBLIC_URL.replace(/\/$/, ''),
    authSecret: values.BETTER_AUTH_SECRET ?? DEVELOPMENT_SECRET,
    emailFrom: values.EMAIL_FROM,
    cloudflareEmail: values.CLOUDFLARE_ACCOUNT_ID && values.CLOUDFLARE_EMAIL_TOKEN
      ? { accountId: values.CLOUDFLARE_ACCOUNT_ID, token: values.CLOUDFLARE_EMAIL_TOKEN }
      : undefined,
    google: pair(values.GOOGLE_CLIENT_ID, values.GOOGLE_CLIENT_SECRET),
    github: pair(values.GH_OAUTH_CLIENT_ID, values.GH_OAUTH_CLIENT_SECRET),
  }
}
