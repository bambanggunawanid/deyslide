<script setup lang="ts">
import type { DeckTemplate } from '../guest/templates'
import type { DeckSummary } from '../guest/types'
import { RadioGroupIndicator, RadioGroupItem, RadioGroupRoot } from 'reka-ui'
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import NameDialog from '../components/NameDialog.vue'
import { useGuestStore } from '../composables/useGuestStore'
import { plural, timeAgo } from '../format'
import { TEMPLATES } from '../guest/templates'

const props = defineProps<{ projectId: string }>()

const { store, projects } = useGuestStore()
const router = useRouter()
const project = computed(() => projects.value.find(item => item.id === props.projectId))

const addingDeck = ref(false)
const template = ref<DeckTemplate>('blank')
const renamingProject = ref(false)
const deletingProject = ref(false)
const renamingDeck = ref<DeckSummary>()
const deletingDeck = ref<DeckSummary>()

async function addDeck(name: string) {
  const deck = await store.createDeck(props.projectId, name, template.value)
  await router.push({ name: 'deck', params: { projectId: props.projectId, deckId: deck.id } })
}

async function deleteProject() {
  await store.deleteProject(props.projectId)
  await router.push({ name: 'home' })
}
</script>

<template>
  <section v-if="project">
    <nav class="text-sm text-dey-muted">
      <RouterLink to="/" class="hover:text-dey-accent">
        Projects
      </RouterLink>
      / {{ project.name }}
    </nav>
    <div class="mt-2 flex flex-wrap items-center gap-2">
      <h1 class="m-0 text-2xl font-semibold" data-testid="project-name">
        {{ project.name }}
      </h1>
      <button class="dey-btn ml-auto text-sm" @click="renamingProject = true">
        Rename
      </button>
      <button class="dey-btn text-sm" data-testid="delete-project" @click="deletingProject = true">
        Delete
      </button>
      <button class="dey-btn-primary" data-testid="new-deck" @click="template = 'blank'; addingDeck = true">
        New deck
      </button>
    </div>

    <div v-if="project.decks.length === 0" class="dey-panel mt-6 text-center" data-testid="empty-decks">
      <p class="m-0 text-lg">
        No decks in this project
      </p>
      <p class="mt-2 text-sm text-dey-muted">
        Start from a blank slide or from the Deyslide demo deck.
      </p>
    </div>

    <ul v-else class="m-0 mt-6 flex list-none flex-col gap-3 p-0" data-testid="deck-list">
      <li v-for="deck in project.decks" :key="deck.id" class="dey-panel flex flex-wrap items-center gap-3">
        <RouterLink :to="{ name: 'deck', params: { projectId: project.id, deckId: deck.id } }" class="hover:text-dey-accent" :data-deck="deck.name">
          <span class="block text-lg font-medium">{{ deck.name }}</span>
          <span class="block text-sm text-dey-muted">{{ plural(deck.slideCount, 'slide') }} · changed {{ timeAgo(deck.updatedAt) }}</span>
        </RouterLink>
        <button class="dey-btn ml-auto text-sm" @click="renamingDeck = deck">
          Rename
        </button>
        <button class="dey-btn text-sm" @click="deletingDeck = deck">
          Delete
        </button>
      </li>
    </ul>

    <NameDialog
      v-model:open="addingDeck"
      title="New deck"
      label="Deck name"
      submit-label="Create deck"
      :action="addDeck"
    >
      <RadioGroupRoot v-model="template" class="flex flex-col gap-2" aria-label="Start from">
        <span class="text-sm">Start from</span>
        <RadioGroupItem
          v-for="option in TEMPLATES"
          :key="option.id"
          :value="option.id"
          class="flex items-start gap-3 rounded-md border border-slate-600 p-3 text-left data-[state=checked]:border-dey-accent"
          :data-template="option.id"
        >
          <span class="mt-1 h-3 w-3 shrink-0 rounded-full border border-slate-400">
            <RadioGroupIndicator class="block h-full w-full rounded-full bg-dey-accent" />
          </span>
          <span>
            <span class="block font-medium">{{ option.label }}</span>
            <span class="block text-sm text-dey-muted">{{ option.description }}</span>
          </span>
        </RadioGroupItem>
      </RadioGroupRoot>
    </NameDialog>

    <NameDialog
      v-model:open="renamingProject"
      title="Rename project"
      label="Project name"
      submit-label="Save"
      :initial-name="project.name"
      :action="name => store.renameProject(project!.id, name)"
    />

    <NameDialog
      :open="Boolean(renamingDeck)"
      title="Rename deck"
      label="Deck name"
      submit-label="Save"
      :initial-name="renamingDeck?.name"
      :action="name => store.renameDeck(project!.id, renamingDeck!.id, name)"
      @update:open="value => { if (!value) renamingDeck = undefined }"
    />

    <ConfirmDialog
      v-model:open="deletingProject"
      title="Delete this project?"
      :description="`${project.name} and its ${plural(project.decks.length, 'deck')} will be removed from this browser. This cannot be undone.`"
      confirm-label="Delete project"
      @confirm="deleteProject"
    />

    <ConfirmDialog
      :open="Boolean(deletingDeck)"
      title="Delete this deck?"
      :description="`${deletingDeck?.name} will be removed from this browser. This cannot be undone.`"
      confirm-label="Delete deck"
      @update:open="value => { if (!value) deletingDeck = undefined }"
      @confirm="store.deleteDeck(project!.id, deletingDeck!.id)"
    />
  </section>

  <section v-else class="dey-panel text-center" data-testid="missing-project">
    <p class="m-0">
      This project is not in this browser.
    </p>
    <RouterLink to="/" class="mt-3 inline-block text-dey-accent">
      Back to your projects
    </RouterLink>
  </section>
</template>
