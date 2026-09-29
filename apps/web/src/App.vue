<script setup lang="ts">
import { useRoute } from 'vue-router'
import AppHeader from './components/AppHeader.vue'
import GuestBanner from './components/GuestBanner.vue'

const route = useRoute()
</script>

<template>
  <div class="min-h-screen bg-dey-bg text-dey-text">
    <AppHeader />
    <GuestBanner />
    <main :class="route.meta.wide ? 'px-4 py-4' : 'mx-auto max-w-5xl px-4 py-8'">
      <RouterView />
    </main>
  </div>
</template>
