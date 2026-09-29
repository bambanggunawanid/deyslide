<script setup lang="ts">
import type { SocialProvider } from '../account/types'
import { ref } from 'vue'
import { AccountError } from '../account/types'
import { useAccount } from '../composables/useAccount'

/** Where to go after signing in, when not the home page. */
const props = defineProps<{ next?: string }>()
const { service, options } = useAccount()
const busy = ref<SocialProvider>()
const error = ref('')

const PROVIDERS: { id: SocialProvider, label: string }[] = [
  { id: 'google', label: 'Continue with Google' },
  { id: 'github', label: 'Continue with GitHub' },
]

async function start(provider: SocialProvider) {
  busy.value = provider
  error.value = ''
  try {
    await service.signInWith(provider, props.next)
  }
  catch (caught) {
    error.value = caught instanceof AccountError ? caught.message : 'Something went wrong. Try again.'
    busy.value = undefined
  }
}
</script>

<template>
  <div v-if="options.google || options.github" class="flex flex-col gap-2">
    <template v-for="provider in PROVIDERS" :key="provider.id">
      <button
        v-if="options[provider.id]"
        class="dey-btn w-full py-2"
        :disabled="Boolean(busy)"
        :data-provider="provider.id"
        @click="start(provider.id)"
      >
        {{ busy === provider.id ? 'Opening...' : provider.label }}
      </button>
    </template>
    <p v-if="error" class="m-0 text-sm text-rose-300" role="alert">
      {{ error }}
    </p>
  </div>
</template>
