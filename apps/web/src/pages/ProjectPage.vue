<script setup lang="ts">
import type { DeckTemplate } from '../guest/templates'
import type { DeckSummary } from '../guest/types'
import { RadioGroupIndicator, RadioGroupItem, RadioGroupRoot } from 'reka-ui'
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import NameDialog from '../components/NameDialog.vue'
import ShareDialog from '../components/ShareDialog.vue'
import { useProjects, useWorkspace } from '../composables/useProjects'
import { plural, timeAgo } from '../format'
import { TEMPLATES } from '../guest/templates'
import { isMobileApp } from '../platform/platform'
import { canEdit, deckRole, projectRole } from '../projects/roles'
import { LOCAL_ID_PREFIX } from '../projects/workspace'

const props = defineProps<{ projectId: string }>()

const { store, projects, shared } = useProjects(() => props.projectId)
const workspace = useWorkspace()
const router = useRouter()
const project = computed(() => [...projects.value, ...shared.value].find(item => item.id === props.projectId))
/** The account's lists come from this device while the server is out of reach. */
const offline = computed(() => Boolean(store.value.offline?.value))

const addingDeck = ref(false)
const template = ref<DeckTemplate>('blank')
const renamingProject = ref(false)
const deletingProject = ref(false)
const renamingDeck = ref<DeckSummary>()
const deletingDeck = ref<DeckSummary>()
/** The deck the question is about. The question closes just before it confirms, which clears `deletingDeck`. */
let questionedDeck: DeckSummary | undefined
watch(deletingDeck, (deck) => {
  if (deck)
    questionedDeck = deck
})
const sharing = ref(false)

// Owners do everything. On a shared project, editors add and rename, and viewers only open decks.
const role = computed(() => project.value && projectRole(project.value))
const isOwner = computed(() => role.value === 'owner')
const editable = computed(() => canEdit(role.value))
const ROLE_NAMES = { owner: 'owner', editor: 'an editor', viewer: 'a viewer' }
// A device project is a folder: deleting moves it to the system's trash, or deletes it where the system has none.
const removal = computed(() => {
  if (props.projectId.startsWith(LOCAL_ID_PREFIX))
    return isMobileApp() ? 'will be deleted from this device. This cannot be undone.' : 'will go to the trash, or be deleted for good where the system has none.'
  return store.value === workspace.stores.value.cloud
    ? 'will be deleted from your account. This cannot be undone.'
    : 'will be removed from this browser. This cannot be undone.'
})

async function addDeck(name: string) {
  const deck = await store.value.createDeck(props.projectId, name, template.value)
  await router.push({ name: 'deck', params: { projectId: props.projectId, deckId: deck.id } })
}

async function deleteProject() {
  await store.value.deleteProject(props.projectId)
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
      <span class="ml-auto" />
      <button v-if="store.sharing && role" class="dey-btn text-sm" data-testid="share-project" @click="sharing = true">
        Share
      </button>
      <button v-if="editable" class="dey-btn text-sm" @click="renamingProject = true">
        Rename
      </button>
      <button v-if="isOwner" class="dey-btn text-sm" data-testid="delete-project" @click="deletingProject = true">
        Delete
      </button>
      <button v-if="editable" class="dey-btn-primary" data-testid="new-deck" @click="template = 'blank'; addingDeck = true">
        New deck
      </button>
    </div>
    <p v-if="project.shared" class="m-0 mt-1 text-sm text-dey-muted" data-testid="shared-by">
      Shared by {{ project.shared.owner.name }}.
      {{ project.shared.role ? `You are ${ROLE_NAMES[project.shared.role]}.` : 'Only some of its decks are shared with you.' }}
    </p>

    <p v-if="offline" class="m-0 mt-3 flex flex-wrap items-center gap-2 text-sm text-dey-muted" role="status" data-testid="project-offline">
      <span class="rounded-full border border-dey-line px-2 py-0.5 text-xs">Offline</span>
      <span>Decks kept on this device open and change now. The others need a connection.</span>
    </p>

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
          <span v-if="offline" class="block text-xs" :class="store.keptOnDevice?.(deck.id) ? 'text-dey-accent' : 'text-dey-muted'" :data-deck-offline="deck.name">
            {{ store.keptOnDevice?.(deck.id) ? 'On this device' : 'Needs a connection' }}
          </span>
        </RouterLink>
        <span v-if="project.shared" class="ml-auto text-xs text-dey-muted" :data-deck-role="deck.name">
          {{ deckRole(project, deck) === 'editor' ? 'Can edit' : 'View only' }}
        </span>
        <RouterLink
          :to="{ name: 'present', params: { projectId: project.id, deckId: deck.id } }"
          class="dey-btn text-sm"
          :class="!project.shared && 'ml-auto'"
          :data-present="deck.name"
        >
          Present
        </RouterLink>
        <button v-if="canEdit(deckRole(project, deck))" class="dey-btn text-sm" @click="renamingDeck = deck">
          Rename
        </button>
        <button v-if="isOwner" class="dey-btn text-sm" @click="deletingDeck = deck">
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

    <ShareDialog
      v-if="store.sharing"
      v-model:open="sharing"
      :target="{ type: 'project', id: project.id }"
      :name="project.name"
      :sharing="store.sharing"
    />

    <ConfirmDialog
      v-model:open="deletingProject"
      title="Delete this project?"
      :description="`${project.name} and its ${plural(project.decks.length, 'deck')} ${removal}`"
      confirm-label="Delete project"
      @confirm="deleteProject"
    />

    <ConfirmDialog
      :open="Boolean(deletingDeck)"
      title="Delete this deck?"
      :description="`${deletingDeck?.name} ${removal}`"
      confirm-label="Delete deck"
      @update:open="value => { if (!value) deletingDeck = undefined }"
      @confirm="store.deleteDeck(project!.id, questionedDeck!.id)"
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
