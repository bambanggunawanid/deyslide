import type { Auth } from './auth.ts'
import type { ServerConfig } from './config.ts'
import { verifyJwsAccessToken } from 'better-auth/oauth2'

/** The token in an `Authorization: Bearer <token>` header, if the header has one. */
export function bearerToken(authorization: string | undefined) {
  return authorization?.match(/^Bearer\s+(\S+)$/i)?.[1]
}

/**
 * The person an OAuth access token was issued to, when this server signed it,
 * it has not expired and `audience` is one of the resources it names.
 * Anything else, including a token for another resource, gives undefined.
 */
export async function verifyAccessToken(auth: Auth, config: Pick<ServerConfig, 'publicUrl'>, token: string, audience: string): Promise<string | undefined> {
  try {
    const payload = await verifyJwsAccessToken(token, {
      jwksFetch: async () => (await auth.api.getJwks()),
      jwksCacheKey: auth,
      // Tokens carry Better Auth's base URL as issuer. It equals `authIssuer` on https and loopback hosts.
      verifyOptions: { issuer: `${config.publicUrl}/api/auth`, audience },
    })
    return typeof payload.sub === 'string' && payload.sub ? payload.sub : undefined
  }
  catch {
    return undefined
  }
}

/** The person behind an `Authorization: Bearer <token>` header, when its token is valid for `audience`. */
export async function tokenUser(auth: Auth, config: Pick<ServerConfig, 'publicUrl'>, authorization: string | undefined, audience: string) {
  const token = bearerToken(authorization)
  return token ? verifyAccessToken(auth, config, token, audience) : undefined
}
