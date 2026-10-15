/**
 * The `fonts` headmatter, read the way Slidev reads it: `sans`, `serif`
 * and `mono` name families (a list, or names split by commas), loaded from
 * Google Fonts unless listed in `local` or `provider` is `none`.
 */
export interface DeckFonts {
  /** Font stacks for the slide, with Slidev's fallbacks after the named families. */
  sans?: string
  serif?: string
  mono?: string
  /** The Google Fonts stylesheet for the named families, if any need loading. */
  url?: string
}

const FALLBACKS = {
  sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', '"Helvetica Neue"', 'Arial', '"Noto Sans"', 'sans-serif', '"Apple Color Emoji"', '"Segoe UI Emoji"', '"Segoe UI Symbol"', '"Noto Color Emoji"'],
  serif: ['ui-serif', 'Georgia', 'Cambria', '"Times New Roman"', 'Times', 'serif'],
  mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', '"Liberation Mono"', '"Courier New"', 'monospace'],
}

const QUOTED = /^(['"])(.*)\1$/

function names(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
  return list
    .flatMap(item => String(item).split(','))
    .map(item => item.trim())
    // A family name is all a stylesheet or a URL needs; anything that could end the declaration is dropped.
    .filter(item => item && !/[;{}<>\\]/.test(item))
}

function unquote(name: string) {
  return name.replace(QUOTED, '$2')
}

function quote(name: string) {
  return QUOTED.test(name) ? name : `"${name}"`
}

export function resolveFonts(value: unknown): DeckFonts {
  if (typeof value !== 'object' || value === null)
    return {}
  const options = value as Record<string, unknown>
  const families = { sans: names(options.sans), serif: names(options.serif), mono: names(options.mono) }
  const fallbacks = options.fallbacks !== false
  const stack = (kind: keyof typeof families) => families[kind].length
    ? [...families[kind].map(quote), ...(fallbacks ? FALLBACKS[kind] : [])].join(', ')
    : undefined

  const local = names(options.local).map(unquote)
  const webfonts = (options.webfonts !== undefined ? names(options.webfonts) : [...families.sans, ...families.serif, ...families.mono, ...names(options.custom)])
    .map(unquote)
    .filter((name, index, list) => !local.includes(name) && list.indexOf(name) === index)
  const weights = names(options.weights ?? '200,400,600').filter(weight => /^\d+$/.test(weight))
  const italic = options.italic === true
  const axis = weights.flatMap(weight => italic ? [`0,${weight}`, `1,${weight}`] : [weight]).sort().join(';')
  const family = (name: string) => `family=${encodeURIComponent(name).replace(/%20/g, '+')}:${italic ? 'ital,' : ''}wght@${axis}`
  const url = options.provider !== 'none' && webfonts.length && axis
    ? `https://fonts.googleapis.com/css2?${webfonts.map(family).join('&')}&display=swap`
    : undefined

  return { sans: stack('sans'), serif: stack('serif'), mono: stack('mono'), url }
}

/** Stylesheets that did not load. A frame without a network does not ask for them again. */
const unavailable = new Set<string>()
/** Each deck font stylesheet, settled once it has loaded or failed. */
const settled = new WeakMap<HTMLLinkElement, Promise<void>>()

function fontLinks() {
  return [...document.querySelectorAll<HTMLLinkElement>('link[data-deck-fonts]')]
}

/**
 * Adds the stylesheet for a deck's fonts and returns at once: text shows in
 * a fallback font until the files arrive, and a frame without a network
 * (the slide renderer) simply keeps the fallback.
 */
export function loadFonts(url: string | undefined) {
  if (!url || unavailable.has(url) || fontLinks().some(link => link.dataset.deckFonts === url))
    return
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  // Read with CORS, so a capture can embed the font files in its image.
  link.crossOrigin = 'anonymous'
  link.href = url
  link.dataset.deckFonts = url
  settled.set(link, new Promise<void>((resolve) => {
    link.addEventListener('load', () => resolve(), { once: true })
    // A stylesheet that failed stays unreadable, and a capture would try to fetch it again each time.
    link.addEventListener('error', () => {
      unavailable.add(url)
      link.remove()
      resolve()
    }, { once: true })
  }))
  document.head.append(link)
}

/** Settles once every deck font stylesheet on the page has loaded or failed, so a capture can wait for them. */
export async function fontStylesheetsSettled() {
  await Promise.all(fontLinks().map(link => settled.get(link)))
}
