import type { Position } from '../../packages/deck-model/src'
import type { CapturedSlide, RenderRequest } from '../../apps/web/src/preview/protocol'
import { defineComponent, h, watch } from 'vue'

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

/** A textarea in place of CodeMirror, with the same props, events and `goToLine`. */
export const MarkdownEditorDouble = defineComponent({
  name: 'MarkdownEditor',
  props: { modelValue: { type: String, required: true }, readonly: Boolean },
  emits: ['update:modelValue', 'cursor'],
  setup(props, { emit, expose }) {
    expose({ goToLine: (line: number) => editorJumps.push(line) })
    return () => h('textarea', {
      'data-testid': 'markdown-editor',
      'value': props.modelValue,
      'readonly': props.readonly,
      'onInput': (event: Event) => emit('update:modelValue', (event.target as HTMLTextAreaElement).value),
    })
  },
})

export function resetEditorDoubles() {
  previewRequests.length = 0
  previewPositions.length = 0
  previewCaptures.length = 0
  editorJumps.length = 0
}
