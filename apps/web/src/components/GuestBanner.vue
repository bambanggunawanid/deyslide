<script setup lang="ts">
import { useAccount } from '../composables/useAccount'
import { isApp } from '../platform/platform'

const { account } = useAccount()
// The app has no sign up page: the browser sign in offers that too.
const inApp = isApp()
</script>

<template>
  <div v-if="!account" class="border-b border-dey-line bg-dey-panel" role="note" data-testid="guest-banner">
    <!-- One row on phones too, with smaller words, so the banner takes little of a small screen. -->
    <div class="mx-auto flex max-w-5xl items-center gap-3 px-4 py-2 text-sm lt-md:text-xs">
      <span v-if="inApp" class="min-w-0 flex-1 text-dey-muted">
        Your work is saved on this device only. Sign in to open the projects in your account too.
      </span>
      <span v-else class="min-w-0 flex-1 text-dey-muted">
        Your work is saved in this browser only. Sign up to keep it in the cloud and open it anywhere.
      </span>
      <RouterLink :to="inApp ? '/sign-in' : '/sign-up'" class="dey-btn shrink-0 text-xs" data-testid="sign-up-link">
        {{ inApp ? 'Sign in' : 'Sign up' }}
      </RouterLink>
    </div>
  </div>
</template>
