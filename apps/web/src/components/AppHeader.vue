<script setup lang="ts">
import { useAccount } from '../composables/useAccount'
import AccountMenu from './AccountMenu.vue'

const { account } = useAccount()
</script>

<template>
  <header class="border-b border-dey-line">
    <div class="mx-auto flex max-w-5xl items-center gap-4 px-4 py-3">
      <RouterLink to="/" class="text-lg font-semibold tracking-tight text-dey-accent">
        Deyslide
      </RouterLink>
      <a href="/demo/" class="ml-auto text-sm text-dey-muted hover:text-dey-accent">Watch the demo</a>
      <AccountMenu v-if="account" />
      <RouterLink v-else to="/sign-in" class="text-sm text-dey-muted hover:text-dey-accent" data-testid="sign-in-link">
        Sign in
      </RouterLink>
    </div>
  </header>
</template>
