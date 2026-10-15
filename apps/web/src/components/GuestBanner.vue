<script setup lang="ts">
import { useAccount } from '../composables/useAccount'
import { isApp } from '../platform/platform'

const { account } = useAccount()
// The app has no sign up page: the browser sign in offers that too.
const inApp = isApp()
</script>

<template>
  <div v-if="!account" class="border-b border-dey-line bg-dey-panel" role="note" data-testid="guest-banner">
    <div class="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-2 text-sm">
      <span v-if="inApp" class="text-dey-muted">
        Your work is saved on this device only. Sign in to keep it in your account and open it anywhere.
      </span>
      <span v-else class="text-dey-muted">
        Your work is saved in this browser only. Sign up to keep it in the cloud and open it anywhere.
      </span>
      <RouterLink :to="inApp ? '/sign-in' : '/sign-up'" class="dey-btn ml-auto text-xs" data-testid="sign-up-link">
        {{ inApp ? 'Sign in' : 'Sign up' }}
      </RouterLink>
    </div>
  </div>
</template>
