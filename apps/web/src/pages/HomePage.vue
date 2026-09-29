<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import NameDialog from '../components/NameDialog.vue'
import { useAccount } from '../composables/useAccount'
import { useProjects, useWorkspace } from '../composables/useProjects'
import { plural, timeAgo } from '../format'

const { store, projects, shared } = useProjects()
const { account } = useAccount()
const { notice } = useWorkspace()
const router = useRouter()
const creating = ref(false)

async function createProject(name: string) {
  const project = await store.value.createProject(name)
  await router.push({ name: 'project', params: { projectId: project.id } })
}
</script>

<template>
  <section>
    <div class="flex items-center gap-3">
      <h1 class="m-0 text-2xl font-semibold">
        Your projects
      </h1>
      <button class="dey-btn-primary ml-auto" data-testid="new-project" @click="creating = true">
        New project
      </button>
    </div>

    <div v-if="notice" class="dey-panel mt-6 flex items-start gap-3 text-sm" role="status" data-testid="workspace-notice">
      <span class="flex-1">{{ notice }}</span>
      <button class="dey-btn text-xs" @click="notice = ''">
        Dismiss
      </button>
    </div>

    <div v-if="projects.length === 0" class="dey-panel mt-6 text-center" data-testid="empty-projects">
      <p class="m-0 text-lg">
        No projects yet
      </p>
      <p class="mt-2 text-sm text-dey-muted">
        A project holds your slide decks. Create one to start{{ account ? '.' : ', no account needed.' }}
      </p>
    </div>

    <ul v-else class="m-0 mt-6 grid list-none gap-3 p-0 sm:grid-cols-2" data-testid="project-list">
      <li v-for="project in projects" :key="project.id">
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

    <template v-if="shared.length">
      <h2 class="m-0 mt-10 text-xl font-semibold">
        Shared with you
      </h2>
      <ul class="m-0 mt-4 grid list-none gap-3 p-0 sm:grid-cols-2" data-testid="shared-list">
        <li v-for="project in shared" :key="project.id">
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
