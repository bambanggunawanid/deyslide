<script setup lang="ts">
import { useAccount } from '../composables/useAccount'

const { account } = useAccount()
</script>

<template>
  <div class="border-b border-dey-line bg-dey-panel" role="note" data-testid="guest-banner">
    <div class="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-2 text-sm">
      <template v-if="account">
        <span class="text-dey-muted">
          You are signed in. Cloud save for projects is being built, so for now your projects stay in this browser.
        </span>
      </template>
      <template v-else>
        <span class="text-dey-muted">
          Your work is saved in this browser only. Sign up to keep it in the cloud and open it anywhere.
        </span>
        <RouterLink to="/sign-up" class="dey-btn ml-auto text-xs" data-testid="sign-up-link">
          Sign up
        </RouterLink>
      </template>
    </div>
  </div>
</template>
