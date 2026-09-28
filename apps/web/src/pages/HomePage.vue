<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import NameDialog from '../components/NameDialog.vue'
import { useGuestStore } from '../composables/useGuestStore'
import { plural, timeAgo } from '../format'

const { store, projects } = useGuestStore()
const router = useRouter()
const creating = ref(false)

async function createProject(name: string) {
  const project = await store.createProject(name)
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

    <div v-if="projects.length === 0" class="dey-panel mt-6 text-center" data-testid="empty-projects">
      <p class="m-0 text-lg">
        No projects yet
      </p>
      <p class="mt-2 text-sm text-dey-muted">
        A project holds your slide decks. Create one to start, no account needed.
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
