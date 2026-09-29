import type { RenderRequest } from '../../apps/web/src/preview/protocol'
import { defineComponent, h } from 'vue'

/** Records what the editor asks the preview to render, instead of a sandboxed iframe. */
export const previewRequests: RenderRequest[] = []

export const SlidePreviewFrameDouble = defineComponent({
  name: 'SlidePreviewFrame',
  props: { request: { type: Object, default: undefined } },
  emits: ['rendered', 'error'],
  setup(props) {
    return () => {
      if (props.request)
        previewRequests.push(structuredClone(JSON.parse(JSON.stringify(props.request))) as RenderRequest)
      return h('div', { 'data-testid': 'preview-frame' })
    }
  },
})

/** Lines the editor was asked to move its cursor to. */
export const editorJumps: number[] = []

/** A textarea in place of CodeMirror, with the same props, events and `goToLine`. */
export const MarkdownEditorDouble = defineComponent({
  name: 'MarkdownEditor',
  props: { modelValue: { type: String, required: true } },
  emits: ['update:modelValue', 'cursor'],
  setup(props, { emit, expose }) {
    expose({ goToLine: (line: number) => editorJumps.push(line) })
    return () => h('textarea', {
      'data-testid': 'markdown-editor',
      'value': props.modelValue,
      'onInput': (event: Event) => emit('update:modelValue', (event.target as HTMLTextAreaElement).value),
    })
  },
})

export function resetEditorDoubles() {
  previewRequests.length = 0
  editorJumps.length = 0
}
