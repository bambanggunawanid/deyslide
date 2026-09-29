import type { R2Settings } from './media/storage.ts'
import { z } from 'zod'

const optional = z.string().trim().optional().transform(value => value || undefined)
/** An empty variable, as the deploy workflow writes for unset settings, counts as unset. */
const unsetIfEmpty = (value: unknown) => typeof value === 'string' && !value.trim() ? undefined : value

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
  /** The Claude API key that pays for the assistant. */
  ANTHROPIC_API_KEY: optional,
  /** "true" turns the assistant on without an API key, for a local `ant auth login` profile. "false" turns it off. */
  ASSISTANT_ENABLED: z.preprocess(unsetIfEmpty, z.enum(['true', 'false']).optional()),
  /** What each account may spend on the assistant per calendar month, in US dollars. */
  ASSISTANT_MONTHLY_LIMIT_USD: z.preprocess(unsetIfEmpty, z.coerce.number().positive().default(3)),
  /** The slide renderer for the MCP server: an http URL, or unix:/path/to/socket. */
  RENDERER_URL: optional,
  /** Cloudflare R2, where media uploads live. Media is on when the keys and the bucket are set. */
  CLOUDFLARE_R2_ACCESS_KEY_ID: optional,
  CLOUDFLARE_R2_ACCESS_KEY_SECRET: optional,
  R2_BUCKET: optional,
  /** An S3 endpoint in place of R2's, for tests. */
  R2_ENDPOINT: optional,
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
  /** Present when the assistant is on. */
  assistant?: { monthlyLimitUsd: number }
  /** Where the slide renderer listens, when there is one. */
  rendererUrl?: string
  /** Present when media uploads are on. */
  r2?: R2Settings
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
    assistant: values.ASSISTANT_ENABLED === 'true' || (values.ASSISTANT_ENABLED !== 'false' && values.ANTHROPIC_API_KEY)
      ? { monthlyLimitUsd: values.ASSISTANT_MONTHLY_LIMIT_USD }
      : undefined,
    rendererUrl: values.RENDERER_URL,
    r2: values.CLOUDFLARE_ACCOUNT_ID && values.CLOUDFLARE_R2_ACCESS_KEY_ID && values.CLOUDFLARE_R2_ACCESS_KEY_SECRET && values.R2_BUCKET
      ? {
          accountId: values.CLOUDFLARE_ACCOUNT_ID,
          accessKeyId: values.CLOUDFLARE_R2_ACCESS_KEY_ID,
          secretAccessKey: values.CLOUDFLARE_R2_ACCESS_KEY_SECRET,
          bucket: values.R2_BUCKET,
          endpoint: values.R2_ENDPOINT,
        }
      : undefined,
  }
}
