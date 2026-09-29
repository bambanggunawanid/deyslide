<script setup lang="ts">
defineProps<{ title: string }>()
</script>

<template>
  <section class="dey-panel mx-auto flex max-w-sm flex-col gap-4">
    <h1 class="m-0 text-2xl font-semibold">
      {{ title }}
    </h1>
    <slot />
  </section>
</template>
