import type { Directive } from 'vue'
import { watchEffect } from 'vue'
import { clicks } from './state'

type ClickElement = HTMLElement & { stopClickWatch?: () => void }

/** Hides an element until its click, using Slidev's own classes so its styles apply. */
export const vClick: Directive<ClickElement, number> = {
  mounted(el, binding) {
    el.classList.add('slidev-vclick-target')
    el.stopClickWatch = watchEffect(() => {
      el.classList.toggle('slidev-vclick-hidden', clicks.value < binding.value)
    })
  },
  unmounted(el) {
    el.stopClickWatch?.()
  },
}
