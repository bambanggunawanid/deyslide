<script setup lang="ts">
import { markdown } from '@codemirror/lang-markdown'
import { yamlFrontmatter } from '@codemirror/lang-yaml'
import { EditorSelection } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

/** A CodeMirror editor for Slidev Markdown. Reports the 0 based line of the cursor. */
const props = defineProps<{ modelValue: string }>()
const emit = defineEmits<{
  'update:modelValue': [value: string]
  'cursor': [line: number]
}>()

const host = ref<HTMLElement>()
let view: EditorView | undefined

onMounted(() => {
  view = new EditorView({
    doc: props.modelValue,
    parent: host.value!,
    extensions: [
      basicSetup,
      // The deck's settings open the file as YAML frontmatter.
      yamlFrontmatter({ content: markdown() }),
      oneDark,
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ 'aria-label': 'Slide Markdown' }),
      EditorView.theme({ '&': { height: '100%', fontSize: '14px' }, '.cm-scroller': { fontFamily: 'ui-monospace, monospace' } }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged)
          emit('update:modelValue', update.state.doc.toString())
        if (update.docChanged || update.selectionSet)
          emit('cursor', update.state.doc.lineAt(update.state.selection.main.head).number - 1)
      }),
    ],
  })
})

// Text set from outside, for example when the deck loads, replaces the document.
watch(() => props.modelValue, (value) => {
  if (view && value !== view.state.doc.toString())
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
})

onBeforeUnmount(() => view?.destroy())

/** Moves the cursor to the start of a 0 based line and shows it. */
function goToLine(line: number) {
  if (!view)
    return
  const target = view.state.doc.line(Math.min(Math.max(line + 1, 1), view.state.doc.lines))
  view.dispatch({ selection: EditorSelection.cursor(target.from), scrollIntoView: true })
  view.focus()
}

defineExpose({ goToLine })
</script>

<template>
  <div ref="host" class="h-full min-h-0 overflow-hidden rounded-md border border-dey-line" data-testid="markdown-editor" />
</template>
