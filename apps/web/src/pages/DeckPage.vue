<script setup lang="ts">
import type { Deck } from '@deyslide/deck-model'
import { toMarkdown } from '@deyslide/deck-model'
import { computed, shallowRef, watch } from 'vue'
import { useGuestStore } from '../composables/useGuestStore'
import { plural } from '../format'
import { deckOutline } from '../guest/outline'

const props = defineProps<{ projectId: string, deckId: string }>()

const { store, projects } = useGuestStore()
const project = computed(() => projects.value.find(item => item.id === props.projectId))
const summary = computed(() => project.value?.decks.find(deck => deck.id === props.deckId))
const deck = shallowRef<Deck>()
const loadError = shallowRef('')

watch(() => props.deckId, async (deckId) => {
  deck.value = undefined
  loadError.value = ''
  if (!summary.value)
    return
  try {
    deck.value = await store.readDeck(deckId)
  }
  catch {
    loadError.value = 'This deck could not be read from this browser.'
  }
}, { immediate: true })

const outline = computed(() => deck.value ? deckOutline(deck.value) : [])

function downloadMarkdown() {
  if (!deck.value || !summary.value)
    return
  const blob = new Blob([toMarkdown(deck.value)], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${summary.value.name}.md`
  link.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <section v-if="project && summary">
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
    <div class="mt-2 flex flex-wrap items-center gap-2">
      <h1 class="m-0 text-2xl font-semibold" data-testid="deck-name">
        {{ summary.name }}
      </h1>
      <button class="dey-btn-primary ml-auto" :disabled="!deck" data-testid="download-markdown" @click="downloadMarkdown">
        Download Markdown
      </button>
    </div>

    <p class="dey-panel mt-4 text-sm text-dey-muted">
      The visual editor is on its way. For now you can review the slides here and download the deck as Slidev Markdown.
    </p>

    <p v-if="loadError" class="mt-4 text-rose-300" role="alert">
      {{ loadError }}
    </p>

    <ol v-else-if="deck" class="m-0 mt-6 flex list-none flex-col gap-2 p-0" data-testid="slide-outline">
      <li v-for="slide in outline" :key="slide.number" class="dey-panel flex items-center gap-4 py-3">
        <span class="w-8 text-right font-mono text-dey-muted">{{ slide.number }}</span>
        <span class="flex-1">
          <span class="block font-medium" data-testid="slide-title">{{ slide.title }}</span>
          <span class="block text-sm text-dey-muted">{{ slide.summary }}</span>
        </span>
        <span v-if="slide.hasNotes" class="dey-chip">Notes</span>
      </li>
    </ol>
    <p v-else class="mt-6 text-dey-muted">
      Loading {{ plural(summary.slideCount, 'slide') }}...
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
