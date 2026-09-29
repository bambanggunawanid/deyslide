import type { BundledLanguage, Highlighter } from 'shiki'
import { bundledLanguages, createHighlighter, createJavaScriptRegexEngine } from 'shiki'

/** Slidev's default code themes. */
export const CODE_THEMES = { dark: 'vitesse-dark', light: 'vitesse-light' } as const

let highlighter: Promise<Highlighter> | undefined

/**
 * One Shiki highlighter for the preview, with the JavaScript regex engine so
 * no WebAssembly is needed. Languages load the first time a slide uses them.
 */
export async function loadHighlighter(langs: string[]): Promise<Highlighter> {
  highlighter ??= createHighlighter({
    themes: [CODE_THEMES.dark, CODE_THEMES.light],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  })
  const loaded = await highlighter
  const missing = langs.filter(lang => lang in bundledLanguages && !loaded.getLoadedLanguages().includes(lang))
  if (missing.length)
    await loaded.loadLanguage(...missing as BundledLanguage[])
  return loaded
}

/** A language Shiki knows, or plain text. */
export function knownLanguage(highlighter: Highlighter, lang: string) {
  return highlighter.getLoadedLanguages().includes(lang) ? lang : 'text'
}
