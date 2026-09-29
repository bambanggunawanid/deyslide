import type { Highlighter } from 'shiki'
import { componentPlugin } from '@mdit-vue/plugin-component'
import MarkdownIt from 'markdown-it'
import { CODE_THEMES, knownLanguage } from './highlighter'

export interface CodeStep {
  lang: string
  code: string
}

const SLOT_MARKER = /^::\s*([\w.-]+)\s*::[ \t]*$/gm
const FENCE_LANG = /^(`{3,}|~{3,})[ \t]*([\w+-]+)/gm
const MAGIC_MOVE_STEP = /^```([^\s`{]*)[^\n]*\n([\s\S]*?)\n```[ \t]*$/gm

/** Splits a slide on Slidev's `::name::` lines into the default slot and named slots. */
export function splitSlots(content: string): Record<string, string> {
  const slots: Record<string, string> = {}
  let name = 'default'
  let cursor = 0
  for (const match of content.matchAll(SLOT_MARKER)) {
    slots[name] = (slots[name] ?? '') + content.slice(cursor, match.index)
    name = match[1]
    cursor = match.index + match[0].length
  }
  slots[name] = (slots[name] ?? '') + content.slice(cursor)
  return slots
}

/** Every code language a slide uses, so the highlighter can load them first. */
export function codeLanguages(content: string): string[] {
  return [...new Set([...content.matchAll(FENCE_LANG)].map(match => match[2]).filter(lang => lang !== 'md'))]
}

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** A JSON value placed in a single quoted Vue attribute. */
function bindJson(value: unknown) {
  return JSON.stringify(value).replace(/&/g, '&amp;').replace(/'/g, '&#39;')
}

export function parseMagicMove(body: string): CodeStep[] {
  return [...body.matchAll(MAGIC_MOVE_STEP)].map(match => ({ lang: match[1] || 'text', code: match[2] }))
}

/**
 * Markdown to a Vue template string, the way Slidev does it: HTML and Vue
 * syntax pass through, code is highlighted and wrapped in `v-pre` so it is
 * shown and never evaluated.
 */
export function createMarkdownRenderer(highlighter: Highlighter) {
  // Slidev reads Vue components as HTML blocks even when their tags span
  // several lines, through the same plugin.
  const md = new MarkdownIt({ html: true, linkify: true }).use(componentPlugin)

  md.renderer.rules.code_inline = (tokens, index) => `<code v-pre>${escapeHtml(tokens[index].content)}</code>`

  md.renderer.rules.fence = (tokens, index) => {
    const token = tokens[index]
    const info = token.info.trim()
    const code = token.content.replace(/\n$/, '')
    if (/^md\s+magic-move\b/.test(info))
      return `<MagicMove :steps='${bindJson(parseMagicMove(code))}' />\n`
    const lang = knownLanguage(highlighter, info.split(/[\s{]/)[0] || 'text')
    const html = highlighter.codeToHtml(code, { lang, themes: CODE_THEMES, defaultColor: false })
      .replace('<pre class="shiki', '<pre class="slidev-code shiki')
    return `<div class="slidev-code-wrapper" v-pre>${html}</div>\n`
  }

  return (markdown: string) => md.render(markdown)
}
