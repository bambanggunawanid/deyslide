import type { Component } from 'vue'
import type { ClickCounter } from './clicks'
import { compile, DOMErrorMessages, errorMessages } from '@vue/compiler-dom'
import * as Vue from 'vue'
import { clickTransform } from './clicks'
import { createMarkdownRenderer, splitSlots } from './markdown'

export class SlideCompileError extends Error {}

export interface CompiledSlide {
  component: Component
  /** Clicks the slide needs: its own count, or `clicks` from frontmatter when larger. */
  clicks: number
}

export interface SlideSource {
  content: string
  frontmatter: Record<string, unknown>
  /** Slidev makes the first slide a cover unless it names a layout. */
  first: boolean
}

/** Frontmatter keys that Slidev passes on to the layout. */
const LAYOUT_PROPS = ['class', 'layoutClass', 'background', 'image', 'backgroundSize', 'url', 'scale']

export function layoutName({ frontmatter, first }: Pick<SlideSource, 'frontmatter' | 'first'>) {
  return typeof frontmatter.layout === 'string' ? frontmatter.layout : first ? 'cover' : 'default'
}

function isCustomElement(tag: string) {
  return tag.startsWith('Tres') || tag === 'primitive' || tag === 'motion-canvas-player'
}

/** Compiles a template the way Vue's full build does, so the preview can render any slide. */
function toRenderFunction(template: string, counter: ClickCounter) {
  const errors: string[] = []
  const { code } = compile(template, {
    mode: 'function',
    hoistStatic: false,
    isCustomElement,
    nodeTransforms: [clickTransform(counter)],
    // Production builds of the compiler only carry error codes. Look up the words.
    onError: (error) => {
      const code = Number(error.code)
      errors.push((errorMessages as Record<number, string>)[code] ?? (DOMErrorMessages as Record<number, string>)[code] ?? error.message)
    },
  })
  if (errors.length)
    throw new SlideCompileError(errors[0])
  // The compiled code expects Vue's runtime helpers as `Vue`, like compileToFunction.
  // eslint-disable-next-line no-new-func
  return new Function('Vue', code)(Vue) as Vue.RenderFunction
}

/**
 * Builds a component for one slide: Markdown to a Vue template in the
 * slide's layout, with named slots for `::right::` and the like.
 */
export function compileSlide(source: SlideSource, markdown: ReturnType<typeof createMarkdownRenderer>, layouts: Record<string, Component>): CompiledSlide {
  const slots = Object.entries(splitSlots(source.content))
    .map(([name, part]) => `<template #${name}>${markdown(part)}</template>`)
    .join('\n')
  const template = `<SlideLayout v-bind="layoutProps">${slots}</SlideLayout>`
  const counter: ClickCounter = { total: 0 }
  const render = toRenderFunction(template, counter)

  const name = layoutName(source)
  const layoutProps = Object.fromEntries(LAYOUT_PROPS.filter(key => key in source.frontmatter).map(key => [key, source.frontmatter[key]]))
  const frontmatterClicks = Number(source.frontmatter.clicks)

  return {
    component: {
      name: 'SlidePreview',
      components: { SlideLayout: layouts[name] ?? layouts.default },
      data: () => ({ layoutProps, frontmatter: source.frontmatter }),
      render,
    },
    clicks: Math.max(counter.total, Number.isFinite(frontmatterClicks) ? frontmatterClicks : 0),
  }
}
