<script setup lang="ts">
import type { MarkdownFork } from '@deyslide/deck-model'
import type { DeckSession } from '../deck/session'
import type { AssistantAllowance, AssistantEvent, AssistantStop, ChatMessage } from './api'
import { DECK_KEY, deckMarkdown, forkMarkdown, readDeckDoc } from '@deyslide/deck-model'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import * as Y from 'yjs'
import { useAccount } from '../composables/useAccount'
import { useAssistantApi } from '../composables/useAssistant'
import { ASSISTANT_ORIGIN } from '../deck/session'
import { AssistantError } from './api'

/**
 * A chat with Claude about the open deck. Claude's edits go straight into
 * the live deck, merged with whatever anyone else does meanwhile, and Undo
 * takes back the latest reply that changed the deck, and nothing else.
 */
const props = defineProps<{ deckId: string, session: DeckSession }>()
const emit = defineEmits<{
  /** Claude changed this slide, so the page can show it. */
  show: [slideId: string]
  /** True while Claude works, so editing can wait until it finishes. */
  busy: [busy: boolean]
}>()

interface Entry {
  role: 'user' | 'assistant'
  text: string
  changes: string[]
  failed?: boolean
}

const STOP_NOTES: Record<Exclude<AssistantStop, 'done'>, string> = {
  'refused': 'Claude declined this request, so its last step was not applied.',
  'too-long': 'The reply grew too long to finish. Try asking for less at once.',
  'turn-limit': 'Claude stopped after many steps. Ask again to continue.',
  'allowance': 'This month\'s allowance ran out, so Claude stopped early.',
  'unreadable': 'Claude\'s last step could not be read. Try again.',
  'cancelled': 'The reply was stopped.',
}

/** Messages of earlier chat turns sent with a request. */
const HISTORY_LIMIT = 20

const { account } = useAccount()
const api = useAssistantApi()

const enabled = ref(false)
const entries = ref<Entry[]>([])
const draft = ref('')
const working = ref(false)
const error = ref('')
const allowance = ref<AssistantAllowance>()
const log = ref<HTMLElement>()
/** A reply changed the deck, and its changes can still be undone. */
const canUndo = ref(false)
/**
 * The assistant's own undo history. It tracks only what the assistant does,
 * a whole reply as one step, so undoing a reply leaves typing and other
 * people's edits, before or after it, as they are.
 */
const replies = shallowRef<Y.UndoManager>()
let unmounted = false

const resetsOn = computed(() => allowance.value && new Date(allowance.value.resetsAt)
  .toLocaleDateString(undefined, { month: 'long', day: 'numeric', timeZone: 'UTC' }))

async function loadAllowance() {
  try {
    allowance.value = await api.allowance()
  }
  catch {
    allowance.value = undefined
  }
}

onMounted(async () => {
  enabled.value = await api.enabled()
})

watch([enabled, account], ([on, signedIn]) => {
  if (on && signedIn)
    void loadAllowance()
}, { immediate: true })

// A different deck starts a new chat.
watch(() => props.deckId, () => {
  entries.value = []
  error.value = ''
})

/** True when `type` is, or lies inside, something in `added`, such as a slide a reply added. */
function within(type: { _item: Y.Item | null }, added: Parameters<typeof Y.isDeleted>[0]) {
  for (let item = type._item; item; item = item.parent instanceof Y.AbstractType ? item.parent._item : null) {
    if (Y.isDeleted(added, item.id))
      return true
  }
  return false
}

watch(() => props.session, (session, _, onCleanup) => {
  const manager = new Y.UndoManager(session.doc.getMap(DECK_KEY), {
    trackedOrigins: new Set([ASSISTANT_ORIGIN]),
    captureTimeout: Number.POSITIVE_INFINITY,
  })
  /**
   * Someone changed what the reply added, such as a slide Claude wrote.
   * Undoing the reply would remove their change with it, so Undo goes away.
   */
  let editedSince = false
  const follow = () => {
    canUndo.value = manager.undoStack.length > 0 && !editedSince
  }
  const watchEdits = (transaction: Y.Transaction) => {
    const reply = manager.undoStack.at(-1)
    if (editedSince || !reply || transaction.origin === ASSISTANT_ORIGIN || transaction.origin === manager)
      return
    if ([...transaction.changed.keys()].some(type => within(type, reply.insertions))) {
      editedSince = true
      follow()
    }
  }
  manager.on('stack-item-added', follow)
  manager.on('stack-item-popped', follow)
  manager.on('stack-cleared', () => {
    editedSince = false
    follow()
  })
  session.doc.on('afterTransaction', watchEdits)
  replies.value = manager
  canUndo.value = false
  onCleanup(() => {
    session.doc.off('afterTransaction', watchEdits)
    manager.destroy()
    if (replies.value === manager)
      replies.value = undefined
  })
}, { immediate: true })

onBeforeUnmount(() => {
  unmounted = true
  // A reply still running changes nothing from now on, so editing need not wait for it.
  if (working.value)
    emit('busy', false)
})

function scrollToEnd() {
  void nextTick(() => log.value?.scrollTo({ top: log.value.scrollHeight }))
}

function history(): ChatMessage[] {
  return entries.value
    .filter(entry => !entry.failed)
    .map(entry => ({
      role: entry.role,
      text: entry.changes.length ? `${entry.text}\n\nChanges made: ${entry.changes.join(', ')}.` : entry.text,
    }))
    .filter(entry => entry.text)
    .slice(-HISTORY_LIMIT)
}

/** The id of the slide at `index` (counted from 0) in the deck a fork holds. */
function slideIdIn(fork: MarkdownFork, index: number) {
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, fork.textBase())
    const { slides } = readDeckDoc(doc)
    return slides[Math.max(0, Math.min(index, slides.length - 1))]?.id
  }
  finally {
    doc.destroy()
  }
}

async function send() {
  const message = draft.value.trim()
  const session = props.session
  if (!message || working.value)
    return
  // Typing waiting to merge goes into the deck first, so Claude sees what the editor shows.
  void session.flush()
  // Every version the reply sends builds on the deck as it is now. One fork
  // of this state merges them all, so whatever anyone does meanwhile survives.
  const base = Y.encodeStateAsUpdate(session.doc)
  let fork: MarkdownFork | undefined
  const request = { markdown: deckMarkdown(session.doc), message, history: history() }
  const undoHistory = replies.value
  entries.value.push({ role: 'user', text: message, changes: [] })
  const reply: Entry = { role: 'assistant', text: '', changes: [] }
  entries.value.push(reply)
  const current = entries.value.at(-1)!
  draft.value = ''
  error.value = ''
  working.value = true
  emit('busy', true)
  scrollToEnd()

  /** Merges a version from the reply, as long as the page still has this session open and may edit it. */
  const change = (event: Extract<AssistantEvent, { type: 'deck' }>) => {
    if (unmounted || props.session !== session || replies.value !== undoHistory || session.readOnly.value)
      return
    let merged: MarkdownFork
    try {
      if (!fork) {
        // Undo takes back this reply alone from now on. A reply that only
        // talks, or fails, leaves the Undo for the last change as it was.
        undoHistory?.clear()
        fork = forkMarkdown(session.doc, base, ASSISTANT_ORIGIN)
      }
      merged = fork
      merged.apply(event.markdown)
    }
    catch {
      // The assistant only sends Markdown that reads as a deck.
      return
    }
    const slideId = slideIdIn(merged, event.slide - 1)
    if (slideId)
      emit('show', slideId)
  }

  try {
    const done = await api.ask(props.deckId, request, (event) => {
      if (event.type === 'text') {
        current.text += event.text
      }
      else {
        current.changes.push(event.change)
        change(event)
      }
      scrollToEnd()
    })
    current.text = [done.reply, done.stop === 'done' ? '' : STOP_NOTES[done.stop]].filter(Boolean).join('\n\n')
    allowance.value = done.allowance
  }
  catch (failure) {
    current.failed = true
    current.text = ''
    error.value = failure instanceof AssistantError ? failure.message : 'The assistant could not answer. Try again.'
    if (!current.changes.length)
      entries.value.splice(-2, 2)
    draft.value = draft.value || message
  }
  finally {
    working.value = false
    emit('busy', false)
    scrollToEnd()
  }
}

function undo() {
  const session = props.session
  const undoHistory = replies.value
  if (!undoHistory || !canUndo.value || working.value || session.readOnly.value)
    return
  // Typing waiting to merge goes in first and stays.
  void session.flush()
  undoHistory.undo()
  entries.value.push({ role: 'assistant', text: 'Undid Claude\'s last changes.', changes: [] })
  scrollToEnd()
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void send()
  }
}
</script>

<template>
  <section v-if="enabled" class="dey-panel flex min-h-0 flex-col gap-3 p-3" aria-label="Assistant" data-testid="assistant">
    <header class="flex flex-wrap items-center gap-2">
      <h2 class="m-0 text-base font-semibold">
        Assistant
      </h2>
      <span v-if="account && allowance" class="ml-auto text-xs text-dey-muted" data-testid="assistant-allowance">
        {{ allowance.usedPercent }}% of this month's allowance used
        <template v-if="allowance.usedPercent >= 100">, starts again on {{ resetsOn }}</template>
      </span>
    </header>

    <p v-if="!account" class="m-0 text-sm text-dey-muted" data-testid="assistant-sign-in">
      Describe the slides you want and Claude writes them for you.
      <RouterLink to="/sign-in" class="text-dey-accent">
        Sign in
      </RouterLink>
      to use the assistant.
    </p>

    <template v-else>
      <div ref="log" class="flex max-h-80 min-h-0 flex-col gap-2 overflow-y-auto text-sm" role="log" aria-live="polite" data-testid="assistant-log">
        <p v-if="!entries.length" class="m-0 text-dey-muted">
          Ask for a change, such as "Add a slide that compares bubble sort and merge sort" or "Reveal the points on slide 3 one click at a time".
        </p>
        <div
          v-for="(entry, index) in entries"
          :key="index"
          class="rounded-md px-3 py-2"
          :class="entry.role === 'user' ? 'ml-6 bg-slate-800' : 'mr-6 border border-dey-line'"
          :data-testid="`assistant-${entry.role}`"
        >
          <p v-if="entry.text" class="m-0 whitespace-pre-wrap">
            {{ entry.text }}
          </p>
          <p v-else-if="working && index === entries.length - 1" class="m-0 text-dey-muted">
            Claude is working on it...
          </p>
          <ul v-if="entry.changes.length" class="m-0 mt-1 list-none p-0 text-xs text-dey-muted" data-testid="assistant-changes">
            <li v-for="(change, position) in entry.changes" :key="position">
              {{ change }}
            </li>
          </ul>
        </div>
      </div>

      <p v-if="error" class="m-0 text-sm text-rose-300" role="alert" data-testid="assistant-error">
        {{ error }}
      </p>

      <form class="flex flex-col gap-2" @submit.prevent="send">
        <label class="sr-only" for="assistant-message">Message to the assistant</label>
        <textarea
          id="assistant-message"
          v-model="draft"
          class="dey-input min-h-16 resize-y text-sm"
          maxlength="4000"
          placeholder="What should Claude change?"
          :disabled="working"
          data-testid="assistant-input"
          @keydown="onKeydown"
        />
        <div class="flex items-center gap-2">
          <button
            v-if="canUndo && !working"
            type="button"
            class="dey-btn text-sm"
            data-testid="assistant-undo"
            @click="undo"
          >
            Undo
          </button>
          <span class="ml-auto text-xs text-dey-muted">Claude can make mistakes. Check the slides.</span>
          <button type="submit" class="dey-btn-primary text-sm" :disabled="working || !draft.trim()" data-testid="assistant-send">
            {{ working ? 'Working...' : 'Send' }}
          </button>
        </div>
      </form>
    </template>
  </section>
</template>
