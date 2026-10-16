<script setup lang="ts">
import type { TextChange } from '@deyslide/deck-model'
import type { MarkdownBinding } from './markdown-sync'
import { markdown } from '@codemirror/lang-markdown'
import { yamlFrontmatter } from '@codemirror/lang-yaml'
import { Annotation, Compartment, EditorSelection, EditorState, Prec, Transaction } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView, keymap } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { DECK_SESSION_KEY } from '../deck/session'

/**
 * A CodeMirror editor for a deck's Slidev Markdown, kept in sync with the
 * live deck through `binding`. Reports the 0 based line of the cursor, and
 * whether it moved only because others changed the text around it.
 */
const props = defineProps<{ binding: MarkdownBinding, readonly?: boolean }>()
const emit = defineEmits<{
  cursor: [line: number, byOthers?: boolean]
}>()

/** Undo and redo go through the deck session, so they cover every view of the deck. */
const session = inject(DECK_SESSION_KEY, undefined)

const host = ref<HTMLElement>()
let view: EditorView | undefined
let stopPatches = () => {}
/** Marks edits that come from the binding (other people, undo), which are not the person typing here. */
const fromBinding = Annotation.define<boolean>()
const editable = new Compartment()
const lock = (readonly: boolean) => [EditorState.readOnly.of(readonly), EditorView.editable.of(!readonly)]

function undo() {
  session?.value?.undoStep()
  return true
}

function redo() {
  session?.value?.redoStep()
  return true
}

/** Applies the binding's edits, or its whole text when the editor somehow differs from it. */
function applyPatch(changes: TextChange[]) {
  if (!view)
    return
  const expected = props.binding.text.value
  try {
    view.dispatch({ changes, annotations: fromBinding.of(true) })
  }
  catch {
    // Handled below: the editor takes the whole text.
  }
  if (view.state.doc.toString() !== expected)
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: expected }, annotations: fromBinding.of(true) })
}

function follow(binding: MarkdownBinding) {
  stopPatches()
  stopPatches = binding.onPatch(applyPatch)
}

onMounted(() => {
  view = new EditorView({
    doc: props.binding.text.value,
    parent: host.value!,
    extensions: [
      Prec.highest(keymap.of([
        { key: 'Mod-z', run: undo, preventDefault: true },
        { key: 'Mod-Shift-z', run: redo, preventDefault: true },
        { key: 'Mod-y', run: redo, preventDefault: true },
      ])),
      // The browser's own Undo and Redo (menus, touch keyboards) too.
      Prec.highest(EditorView.domEventHandlers({
        beforeinput(event) {
          if (event.inputType !== 'historyUndo' && event.inputType !== 'historyRedo')
            return false
          event.preventDefault()
          return event.inputType === 'historyUndo' ? undo() : redo()
        },
      })),
      basicSetup,
      // CodeMirror keeps no history of its own: nothing is recorded in it.
      EditorState.transactionExtender.of(() => ({ annotations: Transaction.addToHistory.of(false) })),
      // The deck's settings open the file as YAML frontmatter.
      yamlFrontmatter({ content: markdown() }),
      oneDark,
      EditorView.lineWrapping,
      editable.of(lock(props.readonly)),
      EditorView.contentAttributes.of({ 'aria-label': 'Slide Markdown' }),
      EditorView.theme({ '&': { height: '100%', fontSize: '14px' }, '.cm-scroller': { fontFamily: 'ui-monospace, monospace' } }),
      EditorView.updateListener.of((update) => {
        const typed = !update.transactions.some(transaction => transaction.annotation(fromBinding))
        if (typed && update.docChanged) {
          const changes: TextChange[] = []
          update.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
            changes.push({ from, to, insert: inserted.toString() })
          })
          props.binding.applyLocalChanges(changes)
        }
        // Edits from others move the cursor's line too, so the page keeps knowing its slide.
        if (update.docChanged || update.selectionSet)
          emit('cursor', update.state.doc.lineAt(update.state.selection.main.head).number - 1, !typed)
      }),
    ],
  })
  follow(props.binding)
})

// Another binding (another deck) brings its own text.
watch(() => props.binding, (binding) => {
  follow(binding)
  view?.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: binding.text.value }, annotations: fromBinding.of(true) })
})

watch(() => props.readonly, (readonly) => {
  view?.dispatch({ effects: editable.reconfigure(lock(readonly)) })
})

onBeforeUnmount(() => {
  stopPatches()
  view?.destroy()
})

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
