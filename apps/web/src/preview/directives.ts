import type { ComponentPublicInstance, Directive, DirectiveBinding } from 'vue'
import type { SlideScope } from './scope'
import { watchEffect } from 'vue'
import { liveScope, SLIDE_SCOPE } from './scope'

type ClickElement = HTMLElement & { stopClickWatch?: () => void }

/**
 * The slide an element belongs to, from what its component's tree
 * provides. Directive hooks run outside setup, where inject cannot.
 */
function slideScope(binding: DirectiveBinding): SlideScope {
  const instance = binding.instance as (ComponentPublicInstance & { $?: { provides?: Record<symbol, unknown> } }) | null
  return (instance?.$?.provides?.[SLIDE_SCOPE as symbol] as SlideScope | undefined) ?? liveScope
}

/**
 * Hides an element until its click, using Slidev's own classes so its
 * styles apply. With `.hide`, as in Slidev, the element shows until its
 * click and hides from then on.
 */
export const vClick: Directive<ClickElement, number> = {
  mounted(el, binding) {
    const { clicks } = slideScope(binding)
    el.classList.add('slidev-vclick-target')
    el.stopClickWatch = watchEffect(() => {
      const reached = clicks.value >= binding.value
      el.classList.toggle('slidev-vclick-hidden', binding.modifiers.hide ? reached : !reached)
    })
  },
  unmounted(el) {
    el.stopClickWatch?.()
  },
}
