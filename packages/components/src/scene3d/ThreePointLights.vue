<script setup lang="ts">
// Rendered by TresCanvas in its own Vue app, where Slidev context is not
// provided. This marker tells Slidev to skip injecting it.
/* @slidev-injection */
/** Key, fill and rim lights tuned for dark slides. */
withDefaults(defineProps<{ intensity?: number }>(), { intensity: 1 })
</script>

<template>
  <TresAmbientLight :intensity="0.25 * intensity" />
  <!-- Key light: main shape and shadow direction. -->
  <TresDirectionalLight :position="[6, 8, 6]" :intensity="2.2 * intensity" color="#ffffff" />
  <!-- Fill light: lifts the shadow side with a cool tint. -->
  <TresDirectionalLight :position="[-8, 4, 4]" :intensity="0.8 * intensity" color="#93c5fd" />
  <!-- Rim light: separates edges from the dark background. -->
  <TresDirectionalLight :position="[0, 6, -10]" :intensity="1.4 * intensity" color="#f0abfc" />
</template>
