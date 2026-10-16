<script setup lang="ts">
import type * as Y from 'yjs'
import type { DeckSession } from '../deck/session'
import { markdown } from '@codemirror/lang-markdown'
import { Compartment, EditorSelection, EditorState, Prec, Transaction } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView, keymap } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { yCollab } from 'y-codemirror.next'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

/**
 * Edits shared Markdown in place: a text element on the slide, a raw block
 * or the speaker notes. It is bound to the shared text, so others' typing
 * shows up while the person types. Undo and redo go through the session,
 * so they cover every view of the deck. Escape closes it.
 */
const props = withDefaults(defineProps<{
  text: Y.Text
  session: DeckSession
  fontSize: number
  /** What a screen reader calls the text. */
  label?: string
  readonly?: boolean
  /** Takes the focus, with the cursor at the end, when it opens. */
  autofocus?: boolean
  /** Over the slide, it stands out; in a panel, it looks like a field. */
  look?: 'overlay' | 'field'
}>(), { label: 'Text on the slide', readonly: false, autofocus: true, look: 'overlay' })
const emit = defineEmits<{ close: [] }>()

const host = ref<HTMLElement>()
let view: EditorView | undefined
const editable = new Compartment()
const collab = new Compartment()

const collabFor = (text: Y.Text) => yCollab(text, props.session.awareness, { undoManager: props.session.undo })

function undo() {
  props.session.undoStep()
  return true
}

function redo() {
  props.session.redoStep()
  return true
}

function close() {
  emit('close')
  return true
}

const editableState = (readonly: boolean) => [EditorState.readOnly.of(readonly), EditorView.editable.of(!readonly)]

onMounted(() => {
  view = new EditorView({
    doc: props.text.toString(),
    parent: host.value!,
    extensions: [
      Prec.highest(keymap.of([
        { key: 'Mod-z', run: undo, preventDefault: true },
        { key: 'Mod-Shift-z', run: redo, preventDefault: true },
        { key: 'Mod-y', run: redo, preventDefault: true },
        { key: 'Escape', run: close },
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
      // CodeMirror keeps no history of its own: the session's undo has it all.
      EditorState.transactionExtender.of(() => ({ annotations: Transaction.addToHistory.of(false) })),
      markdown(),
      oneDark,
      EditorView.lineWrapping,
      editable.of(editableState(props.readonly)),
      collab.of(collabFor(props.text)),
      EditorView.contentAttributes.of({ 'aria-label': props.label }),
      EditorView.theme({
        '&': { height: '100%', fontSize: `${props.fontSize}px` },
        '.cm-scroller': { fontFamily: 'ui-monospace, monospace' },
        '.cm-gutters': { display: 'none' },
      }),
    ],
  })
  if (props.autofocus) {
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) })
    view.focus()
  }
})

/**
 * Someone moved the slide, which copies its texts: the editor binds to the
 * new text where it is, so the person keeps the focus, the cursor and what
 * they select, and their next keys land where they were typing.
 */
watch(() => props.text, (text) => {
  if (!view)
    return
  const { selection } = view.state
  view.dispatch({ effects: collab.reconfigure([]) })
  const next = text.toString()
  const length = next.length
  const clamp = (at: number) => Math.min(at, length)
  view.dispatch({
    changes: next === view.state.doc.toString() ? undefined : { from: 0, to: view.state.doc.length, insert: next },
    selection: EditorSelection.create(selection.ranges.map(range => EditorSelection.range(clamp(range.anchor), clamp(range.head))), selection.mainIndex),
  })
  view.dispatch({ effects: collab.reconfigure(collabFor(text)) })
})

watch(() => props.readonly, (readonly) => {
  view?.dispatch({ effects: editable.reconfigure(editableState(readonly)) })
})

onBeforeUnmount(() => {
  view?.destroy()
  // Others stop seeing a cursor in this text.
  if (props.session.awareness.getLocalState() !== null)
    props.session.awareness.setLocalStateField('cursor', null)
})
</script>

<template>
  <div
    ref="host"
    class="overflow-hidden rounded-md"
    :class="look === 'overlay' ? 'shadow-lg shadow-black/50 ring-2 ring-dey-accent' : 'border border-dey-line focus-within:border-dey-accent'"
    data-testid="inline-editor"
  />
</template>
