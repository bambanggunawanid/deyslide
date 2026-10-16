<script setup lang="ts">
import { useAccount } from '../composables/useAccount'
import { isApp } from '../platform/platform'
import AccountMenu from './AccountMenu.vue'

const { account } = useAccount()
// Inside the app, the demo (a separate build) and the download page have no place.
const website = !isApp()
</script>

<template>
  <header class="border-b border-dey-line">
    <div class="mx-auto flex max-w-5xl items-center gap-4 px-4 py-3">
      <RouterLink to="/" class="text-lg font-semibold tracking-tight text-dey-accent">
        Deyslide
      </RouterLink>
      <div class="ml-auto flex flex-wrap items-center justify-end gap-x-4 gap-y-1">
        <template v-if="website">
          <a href="/demo/" class="text-sm text-dey-muted hover:text-dey-accent" data-testid="demo-link">Watch the demo</a>
          <RouterLink to="/download" class="text-sm text-dey-muted hover:text-dey-accent" data-testid="get-the-app">
            Get the app
          </RouterLink>
        </template>
        <AccountMenu v-if="account" />
        <RouterLink v-else to="/sign-in" class="text-sm text-dey-muted hover:text-dey-accent" data-testid="sign-in-link">
          Sign in
        </RouterLink>
      </div>
    </div>
  </header>
</template>
