import type { Component } from 'vue'
import type { CompiledSlide, SlideSource } from './compile'
import { compileSlide } from './compile'
import { loadHighlighter } from './highlighter'
import { codeLanguages, createMarkdownRenderer } from './markdown'

/** Loads the code languages a slide needs, then compiles it. */
export async function renderSlide(source: SlideSource, layouts: Record<string, Component>): Promise<CompiledSlide> {
  const highlighter = await loadHighlighter(codeLanguages(source.content))
  return compileSlide(source, createMarkdownRenderer(highlighter), layouts)
}
