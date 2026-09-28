import { templateCompilerOptions } from '@tresjs/core'

/**
 * Tags that Vue must leave alone at compile time.
 * `motion-canvas-player` is a real Web Component registered at runtime by
 * `@motion-canvas/player`, so Vue must not try to resolve it as a component.
 */
export const EXTRA_CUSTOM_ELEMENTS = ['motion-canvas-player'] as const

const isTresElement = templateCompilerOptions.template.compilerOptions.isCustomElement

export function isCustomElement(tag: string): boolean {
  return isTresElement(tag) || (EXTRA_CUSTOM_ELEMENTS as readonly string[]).includes(tag)
}

/**
 * Vue plugin options for Slidev. Starts from the TresJS preset so every
 * `<Tres*>` tag compiles as a native three.js element, then adds the
 * Motion Canvas player tag.
 */
export const vueOptions = {
  ...templateCompilerOptions,
  template: {
    ...templateCompilerOptions.template,
    compilerOptions: {
      ...templateCompilerOptions.template.compilerOptions,
      isCustomElement,
    },
  },
}
