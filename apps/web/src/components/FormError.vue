<script setup lang="ts">
defineProps<{ message: string }>()
</script>

<template>
  <p v-if="message" class="m-0 text-sm text-rose-300" role="alert">
    {{ message }}
  </p>
</template>
