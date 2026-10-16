import type { DirectiveNode, ElementNode, NodeTransform, RootNode, SimpleExpressionNode, TemplateChildNode } from '@vue/compiler-dom'
import { createSimpleExpression, ElementTypes, NodeTypes } from '@vue/compiler-dom'

/** Counts clicks while a slide compiles, numbering them in document order from 1. */
export interface ClickCounter {
  total: number
}

function clickDirective(at: number, loc: ElementNode['loc']): DirectiveNode {
  return {
    type: NodeTypes.DIRECTIVE,
    name: 'click',
    rawName: 'v-click',
    exp: createSimpleExpression(String(at), false, loc, 3),
    arg: undefined,
    modifiers: [],
    loc,
  }
}

function isElement(node: TemplateChildNode | RootNode): node is ElementNode {
  return node.type === NodeTypes.ELEMENT
}

function stepCount(steps: DirectiveNode | undefined) {
  try {
    const value = JSON.parse((steps?.exp as SimpleExpressionNode | undefined)?.content ?? '[]') as unknown
    return Array.isArray(value) ? value.length : 1
  }
  catch {
    return 1
  }
}

function literal(exp: DirectiveNode['exp']) {
  const value = Number((exp as SimpleExpressionNode | undefined)?.content)
  return Number.isInteger(value) ? value : undefined
}

/** Slidev's click elements: `<v-click>` shows its content at the next click, `<v-after>` at the click before. */
const CLICK_ELEMENTS = new Set(['v-click', 'VClick'])
const AFTER_ELEMENTS = new Set(['v-after', 'VAfter'])

/** The `at` an element names, written `at="+2"` or `:at="3"`, without quotes. */
function atValue(node: ElementNode) {
  for (const prop of node.props) {
    if (prop.type === NodeTypes.ATTRIBUTE && prop.name === 'at')
      return prop.value?.content.trim()
    if (prop.type === NodeTypes.DIRECTIVE && prop.name === 'bind' && (prop.arg as SimpleExpressionNode | undefined)?.content === 'at')
      return (prop.exp as SimpleExpressionNode | undefined)?.content.trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  return undefined
}

/**
 * The click an element's `at` stands for: `+n` (the default is `+1`) is n
 * clicks after the ones counted so far, a plain number is that click.
 */
function clickAt(at: string | undefined, counter: ClickCounter) {
  const relative = /^[+-]\s*\d+$/.test(at ?? '+1') ? Number((at ?? '+1').replace(/\s/g, '')) : undefined
  if (relative !== undefined)
    return Math.max(counter.total + relative, 0)
  const value = Number(at)
  return Number.isInteger(value) && value >= 0 ? value : counter.total + 1
}

/** Gives a click element the click it shows at, in place of the `at` it was written with. */
function setAt(node: ElementNode, at: number) {
  node.props = node.props.filter(prop => !(prop.type === NodeTypes.ATTRIBUTE && prop.name === 'at')
    && !(prop.type === NodeTypes.DIRECTIVE && prop.name === 'bind' && (prop.arg as SimpleExpressionNode | undefined)?.content === 'at'))
  node.props.push({
    type: NodeTypes.DIRECTIVE,
    name: 'bind',
    rawName: ':at',
    arg: createSimpleExpression('at', true, node.loc, 3),
    exp: createSimpleExpression(String(at), false, node.loc, 3),
    modifiers: [],
    loc: node.loc,
  })
}

/**
 * Gives every `v-click` (directive or element) the click it appears on,
 * `v-after` the click before it, each item of a `<v-clicks>` list its own
 * click, and a Magic Move one click per step after the first. Slidev
 * numbers them the same way.
 */
export function clickTransform(counter: ClickCounter): NodeTransform {
  return (node) => {
    if (!isElement(node))
      return

    if (CLICK_ELEMENTS.has(node.tag)) {
      const at = clickAt(atValue(node), counter)
      counter.total = Math.max(counter.total, at)
      setAt(node, at)
    }
    else if (AFTER_ELEMENTS.has(node.tag)) {
      setAt(node, Math.max(counter.total, 1))
    }

    if (node.tag === 'v-clicks') {
      node.tag = 'div'
      node.tagType = ElementTypes.ELEMENT
      const list = node.children.find(child => isElement(child) && (child.tag === 'ul' || child.tag === 'ol'))
      const items = list && isElement(list) ? list.children.filter(isElement).filter(child => child.tag === 'li') : []
      for (const item of items)
        item.props.push(clickDirective(++counter.total, item.loc))
      return
    }

    if (node.tag === 'MagicMove') {
      const steps = node.props.find(prop => prop.type === NodeTypes.DIRECTIVE && prop.name === 'bind' && (prop.arg as SimpleExpressionNode | undefined)?.content === 'steps') as DirectiveNode | undefined
      const count = stepCount(steps)
      node.props.push({
        type: NodeTypes.DIRECTIVE,
        name: 'bind',
        rawName: ':at',
        arg: createSimpleExpression('at', true, node.loc, 3),
        exp: createSimpleExpression(String(counter.total), false, node.loc, 3),
        modifiers: [],
        loc: node.loc,
      })
      counter.total += Math.max(0, count - 1)
      return
    }

    for (const prop of node.props) {
      if (prop.type !== NodeTypes.DIRECTIVE)
        continue
      if (prop.name === 'click') {
        const at = literal(prop.exp) ?? counter.total + 1
        counter.total = Math.max(counter.total, at)
        prop.exp = createSimpleExpression(String(at), false, prop.loc, 3)
      }
      else if (prop.name === 'after') {
        prop.name = 'click'
        prop.exp = createSimpleExpression(String(Math.max(counter.total, 1)), false, prop.loc, 3)
      }
    }
  }
}
