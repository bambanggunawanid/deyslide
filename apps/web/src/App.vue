<script setup lang="ts">
import AppHeader from './components/AppHeader.vue'
import GuestBanner from './components/GuestBanner.vue'
</script>

<template>
  <div class="min-h-screen bg-dey-bg text-dey-text">
    <AppHeader />
    <GuestBanner />
    <main class="mx-auto max-w-5xl px-4 py-8">
      <RouterView />
    </main>
  </div>
</template>
