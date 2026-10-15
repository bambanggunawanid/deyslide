import type { PropType } from 'vue'
import type { MarkdownBinding } from '../../apps/web/src/editor/markdown-sync'
import type { CapturedSlide, RenderRequest } from '../../apps/web/src/preview/protocol'
import type { Position } from '../../packages/deck-model/src'
import { defineComponent, h, watch } from 'vue'
import { textChanges } from '../../packages/deck-model/src'
import { mapPosition } from './live-decks'

/** Records what the editor asks the preview to render, instead of a sandboxed iframe. */
export const previewRequests: RenderRequest[] = []
/** Positions the editor gave the preview for a drag, in order. */
export const previewPositions: Record<string, Position>[] = []
/** The pixel ratio of each capture the editor asked for. */
export const previewCaptures: (number | undefined)[] = []

/** A 1 by 1 PNG, so code that embeds captures (in a PDF, say) gets a real image. */
const PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII='

/** What every capture answers. */
export function capturedSlide(): CapturedSlide {
  return { png: Uint8Array.from(atob(PIXEL_PNG), char => char.charCodeAt(0)).buffer, overflow: false }
}

export const SlidePreviewFrameDouble = defineComponent({
  name: 'SlidePreviewFrame',
  props: {
    request: { type: Object, default: undefined },
    positions: { type: Object, default: undefined },
  },
  emits: ['rendered', 'error'],
  setup(props, { expose }) {
    expose({
      capture: async (pixelRatio?: number) => {
        previewCaptures.push(pixelRatio)
        return capturedSlide()
      },
    })
    watch(() => props.request, (request) => {
      if (request)
        previewRequests.push(JSON.parse(JSON.stringify(request)) as RenderRequest)
    }, { deep: true, immediate: true })
    watch(() => props.positions, (positions) => {
      if (positions)
        previewPositions.push(JSON.parse(JSON.stringify(positions)) as Record<string, Position>)
    }, { deep: true, immediate: true })
    return () => h('div', { 'data-testid': 'preview-frame' })
  },
})

/** Lines the editor was asked to move its cursor to. */
export const editorJumps: number[] = []

/** The 0 based line that holds `position`. */
const lineAt = (text: string, position: number) => text.slice(0, position).split('\n').length - 1

/**
 * A textarea in place of CodeMirror, with the same props, events and
 * `goToLine`. Typing hands the whole text to the binding; the textarea shows
 * the binding's text, so changes from others appear in it too. Like
 * CodeMirror, it keeps a cursor (at the start until `goToLine` moves it),
 * maps it through every change, and reports its line after `goToLine` and
 * after each change from others.
 */
export const MarkdownEditorDouble = defineComponent({
  name: 'MarkdownEditor',
  props: { binding: { type: Object as PropType<MarkdownBinding>, required: true }, readonly: Boolean },
  emits: ['cursor'],
  setup(props, { emit, expose }) {
    let cursor = 0
    watch(() => props.binding, (binding, _, onCleanup) => {
      cursor = 0
      onCleanup(binding.onPatch((changes) => {
        cursor = Math.min(mapPosition(cursor, changes), binding.text.value.length)
        emit('cursor', lineAt(binding.text.value, cursor), true)
      }))
    }, { immediate: true })
    expose({
      goToLine: (line: number) => {
        editorJumps.push(line)
        const lines = props.binding.text.value.split('\n')
        const target = Math.min(Math.max(line, 0), lines.length - 1)
        cursor = lines.slice(0, target).reduce((length, text) => length + text.length + 1, 0)
        emit('cursor', target)
      },
    })
    return () => h('textarea', {
      'data-testid': 'markdown-editor',
      'value': props.binding.text.value,
      'readonly': props.readonly,
      'onInput': (event: Event) => {
        const before = props.binding.text.value
        const after = (event.target as HTMLTextAreaElement).value
        props.binding.setText(after)
        cursor = Math.min(mapPosition(cursor, textChanges(before, after)), props.binding.text.value.length)
      },
    })
  },
})

export function resetEditorDoubles() {
  previewRequests.length = 0
  previewPositions.length = 0
  previewCaptures.length = 0
  editorJumps.length = 0
}
