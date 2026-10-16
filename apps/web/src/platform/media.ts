import type { ComputedRef } from 'vue'
import type { RenderRequest } from '../preview/protocol'
import { computed, ref, shallowReactive, watch } from 'vue'
import { apiFetch } from './platform'

/**
 * Links to a project's media files that the slide preview can load. Slides
 * name a file `/api/media/<id>/file`, which the API answers for the signed
 * in person only. The preview frame is sandboxed and sends no cookies (and
 * in the app it is not on the server at all), so every such address on a
 * slide is swapped for a short lived signed link before the frame sees it.
 */

/** A file's address on slides, exactly. */
const MEDIA_ADDRESS = /^\/api\/media\/([\w-]{1,200})\/file$/
/** Every file address in a text. */
const MEDIA_ADDRESSES = /\/api\/media\/[\w-]{1,200}\/file/g

/** A link is used until this long before it expires, so a slide never loads one that is about to stop working. */
export const EXPIRY_MARGIN_MS = 60_000
/** A link is kept at least this long, even when the server's clock says it expires sooner. */
const MIN_KEEP_MS = 30_000
/** A file whose link could not be had is asked for again after this long. */
export const RETRY_MS = 30_000

interface Entry {
  /** Missing when the server would not give a link. */
  url?: string
  /** When to ask again, in milliseconds since 1970. */
  until: number
}

/** Links by file id. Reactive, so a page waiting for a link renders once it arrives. */
const links = shallowReactive(new Map<string, Entry>())
const asking = new Map<string, Promise<void>>()
/** Who the links were asked for: signed links are private to an account. */
let owner: string | undefined
/**
 * Counts forgettings, so an answer asked for before one is not kept after
 * it. Reactive, so pages whose links were on their way ask again.
 */
const generation = ref(0)

/** The address slides use for a project's media file. */
export function mediaAddress(id: string) {
  return `/api/media/${id}/file`
}

/** The file id of a media address, or undefined for any other link. */
export function mediaIdOf(src: string): string | undefined {
  return MEDIA_ADDRESS.exec(src)?.[1]
}

/** The media addresses in some texts, each once, in the order they appear. */
export function mediaSources(...texts: string[]): string[] {
  return [...new Set(texts.flatMap(text => text.match(MEDIA_ADDRESSES) ?? []))]
}

const isFresh = (entry: Entry | undefined): entry is Entry => entry !== undefined && entry.until > Date.now()

async function askFor(id: string): Promise<Entry> {
  try {
    const response = await apiFetch(`/api/media/${encodeURIComponent(id)}`)
    if (response.ok) {
      const { url, expiresAt } = await response.json() as { url?: unknown, expiresAt?: unknown }
      const expires = typeof expiresAt === 'string' ? Date.parse(expiresAt) : Number.NaN
      if (typeof url === 'string' && url && Number.isFinite(expires))
        return { url, until: Math.max(expires - EXPIRY_MARGIN_MS, Date.now() + MIN_KEEP_MS) }
    }
  }
  catch {
    // Offline, or the server is away: the slide shows the file as missing for now.
  }
  return { until: Date.now() + RETRY_MS }
}

function load(id: string) {
  let pending = asking.get(id)
  if (!pending) {
    const asked = generation.value
    pending = askFor(id).then((entry) => {
      if (asked !== generation.value)
        return
      links.set(id, entry)
      asking.delete(id)
    })
    asking.set(id, pending)
  }
  return pending
}

/**
 * What is known now for these addresses: the fresh links, and the
 * addresses whose link is missing or about to expire. Others' addresses
 * are left out of both.
 */
export function knownMedia(srcs: Iterable<string>): { links: Record<string, string>, missing: string[] } {
  const known: Record<string, string> = {}
  const missing: string[] = []
  for (const src of srcs) {
    const id = mediaIdOf(src)
    if (id === undefined)
      continue
    const entry = links.get(id)
    if (!isFresh(entry))
      missing.push(src)
    else if (entry.url)
      known[src] = entry.url
  }
  return { links: known, missing }
}

/**
 * Maps each media address among `srcs` to a signed link the preview can
 * load without cookies, asking the API (`GET /api/media/:id`) for the ones
 * it does not have yet. Links are kept until shortly before they expire.
 * Files the server will not give a link for are left out, so the slide
 * shows them as missing. Other links are not touched.
 */
export async function resolveMedia(srcs: Iterable<string>): Promise<Record<string, string>> {
  const list = [...srcs]
  const { missing } = knownMedia(list)
  await Promise.all(missing.map(src => load(mediaIdOf(src)!)))
  return knownMedia(list).links
}

/** Forgets every link, for tests and for a change of account. */
export function clearMediaLinks() {
  generation.value++
  links.clear()
  asking.clear()
}

/**
 * Says whose page asks for links (an account id, or undefined for a guest).
 * When it is someone else than before, every link is forgotten: they were
 * signed for the account that asked, and must not reach anyone else.
 */
export function mediaOwner(id: string | undefined) {
  if (id === owner)
    return
  owner = id
  clearMediaLinks()
}

/** The media addresses a render request's slide uses: in its Markdown and in its frontmatter (a layout's `background` or `image`). */
export function requestMedia(request: RenderRequest): string[] {
  return mediaSources(request.slide.content, JSON.stringify(request.slide.frontmatter))
}

/**
 * A render request with the signed links its slide's media needs, in its
 * `media` map. Undefined while links are on their way, so the preview never
 * draws a slide with files it cannot load; it keeps what it shows until
 * then. A link that ran out is asked for again the next time the request
 * changes.
 */
export function useMediaRequest(request: () => RenderRequest | undefined): ComputedRef<RenderRequest | undefined> {
  let last: { key: string, request: RenderRequest | undefined } | undefined
  const state = computed(() => {
    const base = request()
    if (!base)
      return { request: undefined, missing: [] as string[] }
    const { links: found, missing } = knownMedia(requestMedia(base))
    const next = missing.length ? undefined : Object.keys(found).length ? { ...base, media: found } : base
    // The same request again stays the same object, so the preview is not asked twice.
    const key = JSON.stringify(next ?? null)
    if (last?.key !== key)
      last = { key, request: next }
    return { request: last.request, missing }
  })
  // After a change of account the same addresses are asked for again: the
  // answer to the first asking is dropped, so nothing else would ask.
  watch(() => `${generation.value}\n${state.value.missing.join('\n')}`, () => {
    const { missing } = state.value
    if (missing.length)
      void resolveMedia(missing)
  }, { immediate: true })
  return computed(() => state.value.request)
}
