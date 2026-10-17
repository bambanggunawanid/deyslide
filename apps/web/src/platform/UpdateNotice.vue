<script setup lang="ts">
import { computed, inject } from 'vue'
import { UPDATES_KEY } from './updates'

/** Says a newer version of the app is out, with the way to get it on this device. */

const updates = inject(UPDATES_KEY, undefined)
const shown = computed(() => {
  if (!updates?.found.value || updates.dismissed.value)
    return false
  return ['available', 'installing', 'restarting'].includes(updates.status.value)
})
const busy = computed(() => updates?.status.value === 'installing' || updates?.status.value === 'restarting')
</script>

<template>
  <div v-if="updates && shown" class="border-b border-dey-line bg-dey-panel" role="status" data-testid="update-notice">
    <div class="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-2 text-sm">
      <span data-testid="update-message">
        <template v-if="updates.status.value === 'installing'">Installing Deyslide {{ updates.found.value?.version }}. Your decks are saved first, then the app restarts.</template>
        <template v-else-if="updates.status.value === 'restarting'">Deyslide {{ updates.found.value?.version }} is installed. Restarting...</template>
        <template v-else>Deyslide {{ updates.found.value?.version }} is available</template>
      </span>
      <div class="ml-auto flex items-center gap-2">
        <button v-if="updates.found.value?.how === 'install'" class="dey-btn-primary text-xs" :disabled="busy" data-testid="update-install" @click="updates.install()">
          Install
        </button>
        <button v-else class="dey-btn-primary text-xs" data-testid="update-link" @click="updates.openLink()">
          {{ updates.found.value?.linkLabel }}
        </button>
        <button v-if="!busy" class="dey-btn text-xs" data-testid="update-later" @click="updates.dismissed.value = true">
          Later
        </button>
      </div>
      <p v-if="updates.installProblem.value" class="m-0 w-full text-rose-300" role="alert" data-testid="update-problem">
        {{ updates.installProblem.value }}
      </p>
    </div>
  </div>
</template>
