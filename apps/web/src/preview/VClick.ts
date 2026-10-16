import type { VNode } from 'vue'
import { cloneVNode, Comment, defineComponent, Fragment, h, Text, withDirectives } from 'vue'
import { vClick } from './directives'

/** Slot content as a flat list: fragments (from `v-for`, say) give their children. */
function flatten(nodes: VNode[]): VNode[] {
  return nodes.flatMap(node => node.type === Fragment && Array.isArray(node.children) ? flatten(node.children as VNode[]) : [node])
}

/**
 * Slidev's `<v-click>` and `<v-after>` elements: everything inside shows
 * at one click (hides at it, with `hide`), text wrapped in a span, as in
 * Slidev. The compiler gives `at` its click number while it counts the
 * slide's clicks, so this only applies it.
 */
export default defineComponent({
  name: 'VClick',
  props: {
    at: { type: Number, default: 1 },
    hide: { type: Boolean, default: false },
  },
  setup(props, { slots }) {
    return () => flatten(slots.default?.() ?? []).map((node) => {
      if (node.type === Comment)
        return node
      const shown = node.type === Text ? h('span', [node]) : cloneVNode(node)
      return withDirectives(shown, [[vClick, props.at, '', { hide: props.hide }]])
    })
  },
})
