import type { PropType } from 'vue'
import type { SlideScope } from './scope'
import { defineComponent, h, provide } from 'vue'
import { SLIDE_SCOPE } from './scope'

/** One mounted slide: a box whose content reads its clicks and frontmatter from `scope`. */
export default defineComponent({
  name: 'SlideScope',
  props: {
    scope: { type: Object as PropType<SlideScope>, required: true },
  },
  setup(props, { slots }) {
    provide(SLIDE_SCOPE, props.scope)
    return () => h('div', slots.default?.())
  },
})
