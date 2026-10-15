import type { AttributeNode, DirectiveNode, NodeTransform, SimpleExpressionNode } from '@vue/compiler-dom'
import { ConstantTypes, NodeTypes } from '@vue/compiler-dom'

/** Attributes whose whole value is a link to a file. */
const LINK_ATTRIBUTES = new Set(['src', 'poster'])
/** A `url(...)` in a style declaration, quoted or not. */
const STYLE_URL = /url\(\s*(['"]?)([^'")]*)\1\s*\)/g

/** The link to load in place of `value` when it is a key of `media`, else `value` itself. */
export function mediaLink<T>(media: Record<string, string>, value: T): T | string {
  return typeof value === 'string' && Object.hasOwn(media, value) ? media[value] : value
}

function swapStyleUrls(media: Record<string, string>, declaration: string) {
  return declaration.replace(STYLE_URL, (whole, _quote: string, link: string) => {
    const swapped = mediaLink(media, link)
    return swapped === link ? whole : `url("${swapped.replace(/"/g, '%22')}")`
  })
}

/**
 * A `style` attribute written in the slide. Vue's compiler has already made
 * it a constant `:style` binding: its declarations as a JSON object.
 */
function isWrittenStyle(prop: AttributeNode | DirectiveNode): prop is DirectiveNode & { exp: SimpleExpressionNode } {
  return prop.type === NodeTypes.DIRECTIVE && prop.name === 'bind'
    && prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION && prop.arg.isStatic && prop.arg.content === 'style'
    && prop.exp?.type === NodeTypes.SIMPLE_EXPRESSION && prop.exp.constType === ConstantTypes.CAN_STRINGIFY
}

/**
 * Points every `src` and `poster` attribute equal to a key of `media`, and
 * every such `url()` in a `style` attribute, at its value. The frame is
 * sandboxed and sends no cookies, so a project's media link
 * (`/api/media/<id>/file`) would not load; the editor maps each one to a
 * link that does. Text and code never change, only real attributes.
 */
export function mediaTransform(media: Record<string, string>): NodeTransform {
  return (node) => {
    if (node.type !== NodeTypes.ELEMENT)
      return
    for (const prop of node.props) {
      if (prop.type === NodeTypes.ATTRIBUTE && prop.value && LINK_ATTRIBUTES.has(prop.name)) {
        prop.value.content = mediaLink(media, prop.value.content)
      }
      else if (isWrittenStyle(prop)) {
        const declarations = JSON.parse(prop.exp.content) as Record<string, unknown>
        prop.exp.content = JSON.stringify(Object.fromEntries(Object.entries(declarations).map(([name, value]) => [name, typeof value === 'string' ? swapStyleUrls(media, value) : value])))
      }
    }
  }
}
