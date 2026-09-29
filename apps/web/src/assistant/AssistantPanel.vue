<script setup lang="ts">
import type { AssistantAllowance, AssistantStop, ChatMessage } from './api'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useAccount } from '../composables/useAccount'
import { useAssistantApi } from '../composables/useAssistant'
import { AssistantError } from './api'

/**
 * A chat with Claude about the open deck. Claude's changes come back as new
 * Markdown through `update`, and the whole reply can be undone.
 */
const props = defineProps<{ deckId: string, markdown: string }>()
const emit = defineEmits<{
  /** New Markdown for the editor. `slide` is the slide to show, counted from 0. */
  update: [markdown: string, slide?: number]
  /** True while Claude works, so the editor can stop typing from clashing with it. */
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
/** The Markdown from before the last reply that changed the deck. */
const undoTo = ref<string>()
const log = ref<HTMLElement>()

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
  undoTo.value = undefined
  error.value = ''
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

async function send() {
  const message = draft.value.trim()
  if (!message || working.value)
    return
  const before = props.markdown
  const request = { markdown: before, message, history: history() }
  entries.value.push({ role: 'user', text: message, changes: [] })
  const reply: Entry = { role: 'assistant', text: '', changes: [] }
  entries.value.push(reply)
  const current = entries.value.at(-1)!
  draft.value = ''
  error.value = ''
  working.value = true
  emit('busy', true)
  scrollToEnd()

  try {
    const done = await api.ask(props.deckId, request, (event) => {
      if (event.type === 'text') {
        current.text += event.text
      }
      else {
        current.changes.push(event.change)
        emit('update', event.markdown, event.slide - 1)
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
    if (current.changes.length)
      undoTo.value = before
    working.value = false
    emit('busy', false)
    scrollToEnd()
  }
}

function undo() {
  if (undoTo.value === undefined)
    return
  emit('update', undoTo.value)
  undoTo.value = undefined
  entries.value.push({ role: 'assistant', text: 'Undid the last reply\'s changes.', changes: [] })
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
            v-if="undoTo !== undefined && !working"
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
