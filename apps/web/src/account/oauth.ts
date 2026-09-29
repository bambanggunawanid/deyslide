import type { LocationQuery } from 'vue-router'

/** Query parameters Better Auth adds to sign an authorization request. They are not part of the request itself. */
const SIGNATURE_PARAMS = new Set(['sig', 'exp', 'ba_iat', 'ba_param', 'ba_pl'])

function toSearch(query: LocationQuery) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === 'string')
        params.append(key, item)
    }
  }
  return params
}

/** True when an app such as Claude Code sent the person here to sign in and approve it. */
export function isOAuthRequest(query: LocationQuery) {
  return typeof query.client_id === 'string' && typeof query.sig === 'string'
}

/**
 * Where to go after signing in, when an app sent the person here: back to
 * the authorization endpoint with the app's original request, which now
 * finds a session and moves on to the consent page.
 */
export function oauthContinueUrl(query: LocationQuery): string | undefined {
  if (!isOAuthRequest(query))
    return undefined
  const params = toSearch(query)
  for (const name of SIGNATURE_PARAMS)
    params.delete(name)
  return `/api/auth/oauth2/authorize?${params}`
}

/** The signed request the consent page answers, exactly as Better Auth sent it. */
export function signedQuery(query: LocationQuery) {
  return toSearch(query).toString()
}

/** The host an app will send the person back to, such as "localhost:33418". */
export function redirectHost(query: LocationQuery) {
  try {
    return typeof query.redirect_uri === 'string' ? new URL(query.redirect_uri).host : undefined
  }
  catch {
    return undefined
  }
}

/** Leaves the web app for another address. A function of its own so page scenarios can watch it. */
export const browser = {
  leave(url: string) {
    window.location.assign(url)
  },
}
