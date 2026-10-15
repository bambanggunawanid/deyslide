<script setup lang="ts">
import type * as Y from 'yjs'
import type { DeckSession } from '../deck/session'
import type { DeckView } from '../deck/view'
import type { MarkdownBinding } from '../editor/markdown-sync'
import type { RenderRequest } from '../preview/protocol'
import { deckMarkdown, joinSlides, slideMarkdowns, splitSlides } from '@deyslide/deck-model'
import { computed, onBeforeUnmount, onMounted, onUnmounted, provide, ref, shallowRef, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import AssistantPanel from '../assistant/AssistantPanel.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import ShareDialog from '../components/ShareDialog.vue'
import { useAccount } from '../composables/useAccount'
import { useProjects } from '../composables/useProjects'
import { peopleHere, personInitial, publishPresence } from '../deck/presence'
import { DECK_SESSION_KEY, holdsDeck, statusLabel } from '../deck/session'
import SlideNavigation from '../deck/SlideNavigation.vue'
import { isDeckView, rememberedView, rememberView } from '../deck/view'
import { createMarkdownBinding } from '../editor/markdown-sync'
import MarkdownEditor from '../editor/MarkdownEditor.vue'
import SlidePreviewFrame from '../editor/SlidePreviewFrame.vue'
import { canEdit, deckRole } from '../projects/roles'

const props = defineProps<{ projectId: string, deckId: string }>()

const route = useRoute()
const router = useRouter()
const { account } = useAccount()
const { store, projects, shared } = useProjects(() => props.projectId)
const project = computed(() => [...projects.value, ...shared.value].find(item => item.id === props.projectId))
const summary = computed(() => project.value?.decks.find(deck => deck.id === props.deckId))
/** Viewers of a shared deck follow along; nothing they do is saved. */
const viewOnly = computed(() => Boolean(project.value && summary.value && !canEdit(deckRole(project.value, summary.value))))
const sharing = ref(false)

// The deck, open live --------------------------------------------------------

const session = shallowRef<DeckSession>()
const loadError = shallowRef('')
provide(DECK_SESSION_KEY, session)
const ready = computed(() => Boolean(session.value?.ready.value))

function closeSession() {
  session.value?.close()
  session.value = undefined
}

// Signing in or out swaps the store, which can hold the same deck id.
watch(() => [props.deckId, store.value] as const, async ([deckId, current], _, onCleanup) => {
  let stale = false
  onCleanup(() => {
    stale = true
  })
  closeSession()
  loadError.value = ''
  if (!summary.value)
    return
  try {
    // What the person may do comes from the server: a viewer's session is read only, and stops being so when they become an editor.
    const opened = await current.openDeck(props.projectId, deckId)
    if (stale)
      opened.close()
    else
      session.value = opened
  }
  catch {
    if (!stale)
      loadError.value = 'This deck could not be opened. Reload the page to try again.'
  }
}, { immediate: true })

/** Typing the Markdown view holds back because of a problem in it, which is not in the deck. */
const heldTyping = computed(() => binding.value?.pending.value ? binding.value.problem.value : undefined)

const status = computed(() => {
  const current = session.value
  if (!current)
    return undefined
  if (heldTyping.value && current.status.value !== 'failed')
    return heldTyping.value.kind === 'typing' ? 'Not saved yet: finish the Markdown change.' : 'Not saved: fix the Markdown error.'
  return statusLabel(current.status.value, current.error.value)
})
const statusAlert = computed(() => session.value?.status.value === 'failed' || heldTyping.value?.kind === 'invalid')

// What the preview shows, read from the live deck a moment behind its changes.

interface OutlineSlide {
  id: string
  frontmatter: Record<string, unknown>
  content: string
}

/** How often the preview reads the deck again while it changes, at most. */
const OUTLINE_INTERVAL_MS = 100

const outline = shallowRef<OutlineSlide[]>([])

function readOutline(doc: Y.Doc) {
  const slides = slideMarkdowns(doc)
  const text = joinSlides(slides.map(slide => slide.markdown))
  let split = splitSlides(text)
  // Each slide's Markdown reads as exactly that slide, so read them one by one if the whole deck reads otherwise.
  if (split.length !== slides.length)
    split = slides.map(slide => splitSlides(slide.markdown)[0])
  outline.value = slides.map((slide, index) => ({ id: slide.id, frontmatter: split[index]?.frontmatter ?? {}, content: split[index]?.content ?? '' }))
}

watch(() => [session.value, ready.value] as const, ([current, isReady], _, onCleanup) => {
  outline.value = []
  if (!current || !isReady)
    return
  const doc = current.doc
  let timer: ReturnType<typeof setTimeout> | undefined
  let last = 0
  const refresh = () => {
    timer = undefined
    last = Date.now()
    if (holdsDeck(doc))
      readOutline(doc)
  }
  const onUpdate = () => {
    if (timer === undefined)
      timer = setTimeout(refresh, Math.max(0, last + OUTLINE_INTERVAL_MS - Date.now()))
  }
  refresh()
  doc.on('update', onUpdate)
  onCleanup(() => {
    clearTimeout(timer)
    doc.off('update', onUpdate)
  })
}, { immediate: true })

// The slide on show, by id, so it stays the same slide while others add or remove slides.

const currentId = ref<string>()
let lastIndex = 0
const currentIndex = computed(() => Math.max(0, outline.value.findIndex(slide => slide.id === currentId.value)))
const clicks = ref(0)
const totalClicks = ref(0)
const previewError = ref('')

watch(outline, (list) => {
  // A slide typed in the editor is the cursor's slide once its typing is in the deck.
  if (followsCursor())
    currentId.value = binding.value!.slideIdAtLine(cursorLine!) ?? currentId.value
  if (!list.some(slide => slide.id === currentId.value))
    currentId.value = list[Math.min(lastIndex, list.length - 1)]?.id
})
watch(currentIndex, (index) => {
  lastIndex = index
})
watch(currentId, () => {
  clicks.value = 0
})

const slide = computed(() => outline.value[currentIndex.value])
const request = computed<RenderRequest | undefined>(() => slide.value && {
  type: 'deyslide:render',
  slide: { content: slide.value.content, frontmatter: slide.value.frontmatter, first: currentIndex.value === 0 },
  headmatter: outline.value[0]?.frontmatter ?? {},
  clicks: clicks.value,
})

function onRendered({ clicks: count }: { clicks: number }) {
  totalClicks.value = count
  previewError.value = ''
}

// Design or Markdown: the address says which, else the last choice, else Design.

const remembered = ref(rememberedView())
const view = computed<DeckView>(() => isDeckView(route.query.view) ? route.query.view : remembered.value ?? 'design')
/** Phones show the editor or the preview, not both. */
const phoneTab = ref<'write' | 'preview'>('write')

function chooseView(next: DeckView) {
  remembered.value = next
  rememberView(next)
  void router.replace({ query: { ...route.query, view: next } })
}

const binding = shallowRef<MarkdownBinding>()
const editor = ref<InstanceType<typeof MarkdownEditor>>()
const problem = computed(() => binding.value?.problem.value)
/** The line of the editor's cursor, once the editor reported it. */
let cursorLine: number | undefined
/** A slide the assistant just changed. The preview keeps showing it until the person moves the cursor. */
let shownForAssistant: string | undefined

/** The Markdown view shows the slide under the editor's cursor, unless the assistant just showed another. */
function followsCursor() {
  return view.value === 'markdown' && binding.value !== undefined && cursorLine !== undefined
    && (shownForAssistant === undefined || shownForAssistant !== currentId.value)
}

// Made the first time the Markdown view shows, then kept with the session,
// so typing it holds back (the Markdown has a problem) survives a switch to
// Design and back.
watch(() => [session.value, ready.value] as const, ([current, isReady], _, onCleanup) => {
  if (!current || !isReady)
    return
  let created: MarkdownBinding | undefined
  const stop = watch(view, (shown) => {
    if (shown === 'markdown' && !created) {
      created = createMarkdownBinding(current)
      binding.value = created
    }
  }, { immediate: true })
  onCleanup(() => {
    stop()
    created?.destroy()
    if (binding.value === created)
      binding.value = undefined
  })
}, { immediate: true })

// A fresh editor starts at its first line, until it says otherwise.
watch(view, () => {
  cursorLine = undefined
})

function onCursor(line: number, byOthers = false) {
  cursorLine = line
  if (!byOthers)
    shownForAssistant = undefined
  if (followsCursor())
    currentId.value = binding.value!.slideIdAtLine(line) ?? currentId.value
}

function showSlide(index: number) {
  const target = outline.value[Math.min(Math.max(index, 0), outline.value.length - 1)]
  if (!target)
    return
  currentId.value = target.id
  const line = binding.value?.lineOfSlide(target.id)
  cursorLine = view.value === 'markdown' ? line : undefined
  if (line !== undefined)
    editor.value?.goToLine(line)
}

// The assistant changes the live deck itself. Editing waits while it works.

/** True while the assistant edits the deck. */
const assistantBusy = ref(false)

function onAssistantBusy(busy: boolean) {
  binding.value?.flush()
  assistantBusy.value = busy
}

/** Shows a slide the assistant just changed. */
function showChangedSlide(slideId: string) {
  const current = session.value
  if (!current)
    return
  // The preview has the change at once, not a moment later.
  readOutline(current.doc)
  if (!outline.value.some(item => item.id === slideId))
    return
  currentId.value = slideId
  // The editor's cursor stays where the person left it. The preview follows it again once they move it.
  shownForAssistant = slideId
}

// Presence: who else has the deck open, and what this page shows them.

const people = computed(() => peopleHere(session.value?.peers.value ?? [], account.value?.id))
/** Elements selected on the slide on show. The canvas fills it in. */
const selection = shallowRef<string[]>([])

watch(currentId, () => {
  selection.value = []
})

watch(() => [session.value, account.value, view.value, currentId.value, selection.value] as const, ([current, person, shownView, slideId, selected]) => {
  if (!current)
    return
  publishPresence(current.awareness, {
    // The server fills in who the person is, and their color, for everyone else.
    ...(person ? { user: { id: person.id, name: person.name, color: '' } } : {}),
    view: shownView,
    slideId,
    selection: selected,
  })
}, { immediate: true })

function downloadMarkdown() {
  if (!summary.value || !session.value?.ready.value)
    return
  // What the editor shows, typing included.
  binding.value?.flush()
  const url = URL.createObjectURL(new Blob([deckMarkdown(session.value.doc)], { type: 'text/markdown' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${summary.value.name}.md`
  link.click()
  URL.revokeObjectURL(url)
}

/** Answers the question whether to leave with typing the deck does not have, while the page asks it. */
const leaving = shallowRef<(leave: boolean) => void>()

/** The question closed. Its leave button closes it too, just before it says to leave, so staying waits for that. */
function onLeavingClosed(open: boolean) {
  if (!open)
    setTimeout(() => leaving.value?.(false))
}

// Typing goes into the deck before leaving. The store keeps sending what the
// server does not have yet after the page is gone, so only typing held back
// by a problem in the Markdown would be lost: the page asks first.
onBeforeRouteLeave(async () => {
  binding.value?.flush()
  if (summary.value && binding.value?.pending.value) {
    const leave = await new Promise<boolean>((resolve) => {
      leaving.value = resolve
    })
    leaving.value = undefined
    if (!leave)
      return false
  }
  void session.value?.flush()
})
function warnBeforeUnload(event: BeforeUnloadEvent) {
  const current = session.value
  if (!current)
    return
  void current.flush()
  // Saving covers typing that waits or is held back, too.
  if (current.status.value === 'saving' || (current.status.value === 'offline' && !current.readOnly.value))
    event.preventDefault()
}
onMounted(() => window.addEventListener('beforeunload', warnBeforeUnload))
onBeforeUnmount(() => window.removeEventListener('beforeunload', warnBeforeUnload))
// Once the Markdown view has let go of the deck.
onUnmounted(closeSession)
</script>

<template>
  <section v-if="project && summary" class="flex flex-col gap-3">
    <nav class="text-sm text-dey-muted">
      <RouterLink to="/" class="hover:text-dey-accent">
        Projects
      </RouterLink>
      /
      <RouterLink :to="{ name: 'project', params: { projectId: project.id } }" class="hover:text-dey-accent">
        {{ project.name }}
      </RouterLink>
      / {{ summary.name }}
    </nav>
    <div class="flex flex-wrap items-center gap-2">
      <h1 class="m-0 text-2xl font-semibold" data-testid="deck-name">
        {{ summary.name }}
      </h1>
      <span v-if="viewOnly" class="rounded-full border border-dey-line px-2 py-0.5 text-xs text-dey-muted" data-testid="view-only">
        View only
      </span>
      <span v-else-if="status" class="text-sm" :class="statusAlert ? 'text-rose-300' : 'text-dey-muted'" role="status" data-testid="save-status">
        {{ status }}
      </span>
      <ul v-if="people.length" class="m-0 flex list-none items-center p-0" aria-label="Also here" data-testid="peers">
        <li
          v-for="person in people"
          :key="person.id"
          class="grid h-7 w-7 place-items-center rounded-full border-2 border-slate-900 text-xs font-semibold text-slate-950 [&:not(:first-child)]:-ml-1"
          :style="{ backgroundColor: person.color }"
          :title="person.name"
          :data-peer="person.name"
        >
          {{ personInitial(person.name) }}
        </li>
      </ul>
      <span class="ml-auto" />
      <div class="flex overflow-hidden rounded-md border border-dey-line text-sm" role="group" aria-label="Editor view">
        <button
          class="px-3 py-1"
          :class="view === 'design' ? 'bg-slate-800 text-dey-accent' : 'text-dey-muted'"
          :aria-pressed="view === 'design'"
          data-testid="view-design"
          @click="chooseView('design')"
        >
          Design
        </button>
        <button
          class="px-3 py-1"
          :class="view === 'markdown' ? 'bg-slate-800 text-dey-accent' : 'text-dey-muted'"
          :aria-pressed="view === 'markdown'"
          data-testid="view-markdown"
          @click="chooseView('markdown')"
        >
          Markdown
        </button>
      </div>
      <!-- Present and Export go here. -->
      <div class="flex items-center gap-2" data-testid="header-actions" />
      <button v-if="store.sharing && !viewOnly" class="dey-btn text-sm" data-testid="share-deck" @click="sharing = true">
        Share
      </button>
      <button class="dey-btn text-sm" :disabled="!ready" data-testid="download-markdown" @click="downloadMarkdown">
        Download Markdown
      </button>
    </div>

    <ShareDialog
      v-if="store.sharing"
      v-model:open="sharing"
      :target="{ type: 'deck', id: summary.id }"
      :name="summary.name"
      :sharing="store.sharing"
    />

    <ConfirmDialog
      :open="Boolean(leaving)"
      title="Leave without your last change?"
      description="Your last change is not saved, because the Markdown has a problem, shown under the editor."
      confirm-label="Leave without it"
      @update:open="onLeavingClosed"
      @confirm="leaving?.(true)"
    />

    <p v-if="loadError" class="m-0 text-rose-300" role="alert">
      {{ loadError }}
    </p>

    <template v-else-if="ready && outline.length">
      <div v-if="view === 'markdown'" class="flex gap-2 md:hidden" role="tablist" aria-label="Markdown view">
        <button
          v-for="option in (['write', 'preview'] as const)"
          :key="option"
          role="tab"
          class="dey-btn flex-1 text-sm"
          :class="phoneTab === option && 'border-dey-accent text-dey-accent'"
          :aria-selected="phoneTab === option"
          :data-testid="`tab-${option}`"
          @click="phoneTab = option"
        >
          {{ option === 'write' ? 'Write' : 'Preview' }}
        </button>
      </div>

      <!-- One grid for both views, so the assistant stays put (and keeps its chat) when the view changes. -->
      <div class="grid gap-4" :class="view === 'design' ? 'lg:grid-cols-[minmax(0,1fr)_22rem]' : 'md:grid-cols-2'" :data-testid="`${view}-view`">
        <!-- The canvas comes here. Until then the Design view shows the slide. -->
        <div v-if="view === 'design'" class="flex min-w-0 flex-col gap-3">
          <SlidePreviewFrame :request="request" @rendered="onRendered" @error="previewError = $event" />
          <SlideNavigation :index="currentIndex" :count="outline.length" :clicks="clicks" :total-clicks="totalClicks" @slide="showSlide" @clicks="clicks = $event" />
          <p v-if="previewError" class="m-0 rounded-md bg-rose-950 p-2 font-mono text-xs text-rose-200" role="alert" data-testid="slide-error">
            {{ previewError }}
          </p>
        </div>
        <div v-else class="h-[calc(100dvh-14rem)] min-h-96 flex-col gap-2" :class="phoneTab === 'write' ? 'flex' : 'hidden md:flex'">
          <MarkdownEditor
            v-if="binding"
            ref="editor"
            class="min-h-0 flex-1"
            :binding="binding"
            :readonly="assistantBusy || Boolean(session?.readOnly.value)"
            @cursor="onCursor"
          />
          <p
            v-if="problem"
            class="m-0 max-h-32 shrink-0 overflow-auto rounded-md p-2 text-xs"
            :class="problem.kind === 'typing' ? 'bg-slate-800 text-dey-muted' : 'bg-rose-950 font-mono text-rose-200'"
            :role="problem.kind === 'typing' ? 'status' : 'alert'"
            data-testid="markdown-problem"
          >
            {{ problem.message }}
          </p>
        </div>

        <div class="min-w-0 flex-col gap-3" :class="view === 'design' || phoneTab === 'preview' ? 'flex' : 'hidden md:flex'">
          <template v-if="view === 'markdown'">
            <SlidePreviewFrame :request="request" @rendered="onRendered" @error="previewError = $event" />
            <SlideNavigation :index="currentIndex" :count="outline.length" :clicks="clicks" :total-clicks="totalClicks" @slide="showSlide" @clicks="clicks = $event" />
            <p v-if="previewError" class="m-0 rounded-md bg-rose-950 p-2 font-mono text-xs text-rose-200" role="alert" data-testid="slide-error">
              {{ previewError }}
            </p>
          </template>
          <AssistantPanel v-if="!viewOnly && session" :deck-id="deckId" :session="session" @show="showChangedSlide" @busy="onAssistantBusy" />
        </div>
      </div>
    </template>

    <p v-else class="m-0 text-dey-muted">
      Opening the deck...
    </p>
  </section>

  <section v-else class="dey-panel text-center" data-testid="missing-deck">
    <p class="m-0">
      This deck is not in this browser.
    </p>
    <RouterLink to="/" class="mt-3 inline-block text-dey-accent">
      Back to your projects
    </RouterLink>
  </section>
</template>
