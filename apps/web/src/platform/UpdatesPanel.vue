<script setup lang="ts">
import { computed, inject } from 'vue'
import { UPDATES_KEY } from './updates'

/** The app's update settings: which version runs, a check on request, and the automatic check. */

const updates = inject(UPDATES_KEY, undefined)

const result = computed(() => {
  if (!updates)
    return ''
  switch (updates.status.value) {
    case 'checking':
      return 'Checking for updates...'
    case 'current':
      return `Deyslide ${updates.version} is up to date.`
    case 'available':
    case 'installing':
    case 'restarting':
      return `Deyslide ${updates.found.value?.version} is available. See the note at the top of the page.`
    default:
      return ''
  }
})

function toggle(event: Event) {
  updates?.setAutomatic((event.target as HTMLInputElement).checked)
}
</script>

<template>
  <section v-if="updates" class="dey-panel mt-10 flex flex-col gap-3" data-testid="updates-panel">
    <h2 class="m-0 text-xl font-semibold">
      Updates
    </h2>
    <div class="flex flex-wrap items-center gap-3 text-sm">
      <span>This is Deyslide {{ updates.version }}.</span>
      <button class="dey-btn text-sm" :disabled="updates.status.value === 'checking'" data-testid="check-updates" @click="updates.check({ asked: true })">
        Check for updates
      </button>
    </div>
    <p v-if="result" class="m-0 text-sm text-dey-muted" role="status" data-testid="update-status">
      {{ result }}
    </p>
    <p v-if="updates.checkProblem.value" class="m-0 text-sm text-rose-300" role="alert" data-testid="update-check-problem">
      {{ updates.checkProblem.value }}
    </p>
    <label class="flex items-center gap-2 text-sm">
      <input type="checkbox" role="switch" :checked="updates.automatic.value" data-testid="automatic-updates" @change="toggle">
      Check for updates when the app starts and once a day
    </label>
  </section>
</template>
