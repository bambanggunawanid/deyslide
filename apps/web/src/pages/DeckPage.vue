<script setup lang="ts">
import type { RenderRequest } from '../preview/protocol'
import { fromMarkdown, slideAtLine, splitSlides, toMarkdown } from '@deyslide/deck-model'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import AssistantPanel from '../assistant/AssistantPanel.vue'
import ShareDialog from '../components/ShareDialog.vue'
import { useProjects } from '../composables/useProjects'
import { useAutosave } from '../editor/autosave'
import MarkdownEditor from '../editor/MarkdownEditor.vue'
import { canEdit, deckRole } from '../projects/roles'
import SlidePreviewFrame from '../editor/SlidePreviewFrame.vue'

const props = defineProps<{ projectId: string, deckId: string }>()

const { store, projects, shared } = useProjects()
const project = computed(() => [...projects.value, ...shared.value].find(item => item.id === props.projectId))
const summary = computed(() => project.value?.decks.find(deck => deck.id === props.deckId))
/** Viewers of a shared deck read it; nothing they do is saved. */
const viewOnly = computed(() => Boolean(project.value && summary.value && !canEdit(deckRole(project.value, summary.value))))
const sharing = ref(false)

const text = ref('')
const loaded = ref(false)
const loadError = shallowRef('')
const editor = ref<InstanceType<typeof MarkdownEditor>>()

const { status, error: saveError, flush, markSaved } = useAutosave(text, async (value) => {
  await store.value.saveDeck(props.projectId, props.deckId, fromMarkdown(value))
})

// Signing in or out swaps the store, which can hold the same deck id.
watch(() => [props.deckId, store.value] as const, async ([deckId]) => {
  loaded.value = false
  loadError.value = ''
  if (!summary.value)
    return
  try {
    // Slide ids are for the stored deck. People edit Markdown without them.
    const markdown = toMarkdown(await store.value.readDeck(deckId), { ids: false })
    markSaved(markdown)
    text.value = markdown
    loaded.value = true
  }
  catch {
    loadError.value = 'This deck could not be opened. Reload the page to try again.'
  }
}, { immediate: true })

// The preview follows the text a moment behind the keyboard, so fast typing stays smooth.
const previewText = ref('')
let previewTimer: ReturnType<typeof setTimeout> | undefined
watch(text, (value) => {
  clearTimeout(previewTimer)
  previewTimer = setTimeout(() => {
    previewText.value = value
  }, previewText.value ? 150 : 0)
}, { immediate: true })

const slides = computed(() => splitSlides(previewText.value))
const current = ref(0)
const clicks = ref(0)
const totalClicks = ref(0)
const previewError = ref('')
const view = ref<'write' | 'preview'>('write')

// A deck that loses slides, for example after an undo, keeps the preview on a slide that exists.
watch(slides, (list) => {
  if (current.value > list.length - 1)
    current.value = Math.max(0, list.length - 1)
})

const slide = computed(() => slides.value[Math.min(current.value, slides.value.length - 1)])
watch(current, () => {
  clicks.value = 0
})

const request = computed<RenderRequest | undefined>(() => slide.value && {
  type: 'deyslide:render',
  slide: { content: slide.value.content, frontmatter: slide.value.frontmatter, first: current.value === 0 },
  headmatter: slides.value[0]?.frontmatter ?? {},
  clicks: clicks.value,
})

function onCursor(line: number) {
  current.value = slideAtLine(splitSlides(text.value), line)
}

function showSlide(index: number) {
  current.value = Math.min(Math.max(index, 0), slides.value.length - 1)
  const target = slides.value[current.value]
  if (target)
    editor.value?.goToLine(target.start)
}

/** True while the assistant edits the deck. The editor is read only until it finishes. */
const assistantBusy = ref(false)

/** Puts new Markdown in the editor and shows the given slide, or the nearest slide that still exists. */
function applyMarkdown(markdown: string, slideIndex?: number) {
  text.value = markdown
  current.value = Math.max(0, Math.min(slideIndex ?? current.value, splitSlides(markdown).length - 1))
}

function onRendered(count: number) {
  totalClicks.value = count
  previewError.value = ''
}

const statusLabel = computed(() => ({
  saved: 'Saved',
  unsaved: 'Unsaved changes',
  saving: 'Saving...',
  failed: `Not saved: ${saveError.value}`,
}[status.value]))

function downloadMarkdown() {
  if (!summary.value)
    return
  const url = URL.createObjectURL(new Blob([text.value], { type: 'text/markdown' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${summary.value.name}.md`
  link.click()
  URL.revokeObjectURL(url)
}

/**
 * Takes changes made somewhere else, such as by Claude Code through the MCP
 * server, when the tab comes back into view. Unsaved typing is never replaced.
 */
async function refreshFromStore() {
  if (!loaded.value || status.value !== 'saved' || assistantBusy.value || document.visibilityState !== 'visible')
    return
  try {
    const markdown = toMarkdown(await store.value.readDeck(props.deckId), { ids: false })
    if (markdown !== text.value && status.value === 'saved') {
      markSaved(markdown)
      applyMarkdown(markdown)
    }
  }
  catch {
    // The next focus tries again.
  }
}

// Save what is left before leaving the page or closing the tab.
onBeforeRouteLeave(() => flush())
function warnBeforeUnload(event: BeforeUnloadEvent) {
  if (status.value !== 'saved') {
    void flush()
    event.preventDefault()
  }
}
onMounted(() => {
  window.addEventListener('beforeunload', warnBeforeUnload)
  window.addEventListener('focus', refreshFromStore)
  document.addEventListener('visibilitychange', refreshFromStore)
})
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', warnBeforeUnload)
  window.removeEventListener('focus', refreshFromStore)
  document.removeEventListener('visibilitychange', refreshFromStore)
  clearTimeout(previewTimer)
})
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
      <span v-else class="text-sm" :class="status === 'failed' ? 'text-rose-300' : 'text-dey-muted'" role="status" data-testid="save-status">
        {{ statusLabel }}
      </span>
      <span class="ml-auto" />
      <button v-if="store.sharing && !viewOnly" class="dey-btn text-sm" data-testid="share-deck" @click="sharing = true">
        Share
      </button>
      <button class="dey-btn text-sm" :disabled="!loaded" data-testid="download-markdown" @click="downloadMarkdown">
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

    <p v-if="loadError" class="m-0 text-rose-300" role="alert">
      {{ loadError }}
    </p>

    <template v-else-if="loaded">
      <div class="flex gap-2 md:hidden" role="tablist" aria-label="Editor view">
        <button
          v-for="option in (['write', 'preview'] as const)"
          :key="option"
          role="tab"
          class="dey-btn flex-1 text-sm"
          :class="view === option && 'border-dey-accent text-dey-accent'"
          :aria-selected="view === option"
          :data-testid="`tab-${option}`"
          @click="view = option"
        >
          {{ option === 'write' ? 'Write' : 'Preview' }}
        </button>
      </div>

      <div class="grid gap-4 md:grid-cols-2">
        <div class="h-[calc(100dvh-14rem)] min-h-96" :class="view === 'write' ? 'block' : 'hidden md:block'">
          <MarkdownEditor ref="editor" v-model="text" :readonly="assistantBusy || viewOnly" @cursor="onCursor" />
        </div>

        <div class="flex flex-col gap-3" :class="view === 'preview' ? 'flex' : 'hidden md:flex'">
          <SlidePreviewFrame :request="request" @rendered="onRendered" @error="previewError = $event" />
          <div class="flex flex-wrap items-center gap-2 text-sm">
            <button class="dey-btn" :disabled="current === 0" aria-label="Previous slide" data-testid="previous-slide" @click="showSlide(current - 1)">
              ‹
            </button>
            <span data-testid="slide-position">Slide {{ current + 1 }} of {{ slides.length }}</span>
            <button class="dey-btn" :disabled="current >= slides.length - 1" aria-label="Next slide" data-testid="next-slide" @click="showSlide(current + 1)">
              ›
            </button>
            <span class="ml-auto" />
            <button class="dey-btn" :disabled="clicks === 0" aria-label="Previous click" data-testid="previous-click" @click="clicks--">
              ‹
            </button>
            <span data-testid="click-position">Click {{ clicks }} of {{ totalClicks }}</span>
            <button class="dey-btn" :disabled="clicks >= totalClicks" aria-label="Next click" data-testid="next-click" @click="clicks++">
              ›
            </button>
          </div>
          <p v-if="previewError" class="m-0 rounded-md bg-rose-950 p-2 font-mono text-xs text-rose-200" role="alert" data-testid="slide-error">
            {{ previewError }}
          </p>
          <AssistantPanel v-if="!viewOnly" :deck-id="deckId" :markdown="text" @update="applyMarkdown" @busy="assistantBusy = $event" />
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
