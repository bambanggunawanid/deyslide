<script setup lang="ts">
import type { Project } from '../guest/types'
import type { LocalStore } from '../projects/local-store'
import type { ProjectStore } from '../projects/types'
import { computed, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import NameDialog from '../components/NameDialog.vue'
import { useAccount } from '../composables/useAccount'
import { useWorkspace } from '../composables/useProjects'
import { plural, timeAgo } from '../format'
import ClaudeCodePanel from '../platform/ClaudeCodePanel.vue'
import { isDesktopApp } from '../platform/platform'
import UpdatesPanel from '../platform/UpdatesPanel.vue'

/**
 * The website lists one set of projects: the browser's for guests, the
 * account's once signed in. The app lists the projects on the device and,
 * signed in, the account's as a second section.
 */
interface Section {
  key: 'browser' | 'device' | 'account'
  /** A heading of its own, in the app. */
  title?: string
  store: ProjectStore
  empty: string
  hint: string
}

const workspace = useWorkspace()
const { notice } = workspace
const { account } = useAccount()
const router = useRouter()
const desktop = isDesktopApp()

const sections = computed<Section[]>(() => {
  const { local, cloud } = workspace.stores.value
  if (!local) {
    return [{
      key: 'browser',
      store: workspace.primary.value,
      empty: 'No projects yet',
      hint: `A project holds your slide decks. Create one to start${account.value ? '.' : ', no account needed.'}`,
    }]
  }
  const device: Section = {
    key: 'device',
    title: 'On this device',
    store: local,
    empty: 'No projects on this device yet',
    hint: 'A project is a folder of decks saved as Markdown files. Create one to start, no account needed.',
  }
  if (!cloud)
    return [device]
  return [device, {
    key: 'account',
    title: 'Your account',
    store: cloud,
    empty: 'No projects in your account yet',
    hint: 'Projects in your account open wherever you sign in.',
  }]
})

/** Each store's projects, read again after every change. */
const lists = shallowRef(new Map<ProjectStore, { projects: Project[], shared: Project[] }>())
watch(() => sections.value.map(section => section.store), (stores, _, onCleanup) => {
  const read = () => {
    lists.value = new Map(stores.map(store => [store, { projects: store.listProjects(), shared: store.listShared() }]))
  }
  read()
  const stops = stores.map(store => store.onChange(read))
  onCleanup(() => stops.forEach(stop => stop()))
}, { immediate: true })

const projectsOf = (section: Section) => lists.value.get(section.store)?.projects ?? []
const sharedOf = (section: Section) => lists.value.get(section.store)?.shared ?? []
/** Why the device's library folder could not be read, if it could not. */
const problemOf = (section: Section) => section.key === 'device' ? (section.store as Partial<LocalStore>).problem?.value : ''

/** The store a new project goes to, while the dialog is open. */
const creatingIn = shallowRef<ProjectStore>()
const creating = computed({
  get: () => Boolean(creatingIn.value),
  set: (open) => {
    if (!open)
      creatingIn.value = undefined
  },
})

async function createProject(name: string) {
  const project = await creatingIn.value!.createProject(name)
  await router.push({ name: 'project', params: { projectId: project.id } })
}
</script>

<template>
  <section>
    <div class="flex items-center gap-3">
      <h1 class="m-0 text-2xl font-semibold">
        Your projects
      </h1>
      <button v-if="!sections[0].title" class="dey-btn-primary ml-auto" data-testid="new-project" @click="creatingIn = sections[0].store">
        New project
      </button>
    </div>

    <div v-if="notice" class="dey-panel mt-6 flex items-start gap-3 text-sm" role="status" data-testid="workspace-notice">
      <span class="flex-1">{{ notice }}</span>
      <button class="dey-btn text-xs" @click="notice = ''">
        Dismiss
      </button>
    </div>

    <section v-for="section in sections" :key="section.key" :class="section.title && 'mt-8'" :data-section="section.key">
      <div v-if="section.title" class="flex items-center gap-3">
        <h2 class="m-0 text-xl font-semibold">
          {{ section.title }}
        </h2>
        <button class="dey-btn-primary ml-auto" data-testid="new-project" @click="creatingIn = section.store">
          New project
        </button>
      </div>

      <p v-if="section.store.offline?.value" class="m-0 mt-4 flex flex-wrap items-center gap-2 text-sm text-dey-muted" role="status" data-testid="projects-offline">
        <span class="rounded-full border border-dey-line px-2 py-0.5 text-xs">Offline</span>
        <span>These are your projects as of your last connection. Decks opened on this device before open and change offline.</span>
      </p>

      <p v-if="problemOf(section)" class="m-0 mt-4 text-sm text-rose-300" role="alert" data-testid="library-problem">
        {{ problemOf(section) }}
      </p>

      <div v-if="projectsOf(section).length === 0" class="dey-panel text-center" :class="section.title ? 'mt-4' : 'mt-6'" data-testid="empty-projects">
        <p class="m-0 text-lg">
          {{ section.empty }}
        </p>
        <p class="mt-2 text-sm text-dey-muted">
          {{ section.hint }}
        </p>
      </div>

      <ul v-else class="m-0 grid list-none gap-3 p-0 sm:grid-cols-2" :class="section.title ? 'mt-4' : 'mt-6'" data-testid="project-list">
        <li v-for="project in projectsOf(section)" :key="project.id">
          <RouterLink
            :to="{ name: 'project', params: { projectId: project.id } }"
            class="dey-panel block transition-colors hover:border-dey-accent"
            :data-project="project.name"
          >
            <span class="block text-lg font-medium">{{ project.name }}</span>
            <span class="mt-1 block text-sm text-dey-muted">
              {{ plural(project.decks.length, 'deck') }} · changed {{ timeAgo(project.updatedAt) }}
            </span>
          </RouterLink>
        </li>
      </ul>

      <template v-if="sharedOf(section).length">
        <h2 class="m-0 text-xl font-semibold" :class="section.title ? 'mt-6' : 'mt-10'">
          Shared with you
        </h2>
        <ul class="m-0 mt-4 grid list-none gap-3 p-0 sm:grid-cols-2" data-testid="shared-list">
          <li v-for="project in sharedOf(section)" :key="project.id">
            <RouterLink
              :to="{ name: 'project', params: { projectId: project.id } }"
              class="dey-panel block transition-colors hover:border-dey-accent"
              :data-shared-project="project.name"
            >
              <span class="block text-lg font-medium">{{ project.name }}</span>
              <span class="mt-1 block text-sm text-dey-muted">
                {{ project.shared?.owner.name }} ·
                {{ project.shared?.role === 'editor' ? 'you can edit' : project.shared?.role === 'viewer' ? 'view only' : plural(project.decks.length, 'deck') + ' shared' }}
                · changed {{ timeAgo(project.updatedAt) }}
              </span>
            </RouterLink>
          </li>
        </ul>
      </template>
    </section>

    <ClaudeCodePanel v-if="desktop" />
    <UpdatesPanel />

    <NameDialog
      v-model:open="creating"
      title="New project"
      description="Group related decks, like a course or a conference talk."
      label="Project name"
      submit-label="Create project"
      :action="createProject"
    />
  </section>
</template>
