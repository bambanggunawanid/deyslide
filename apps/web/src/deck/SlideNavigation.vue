<script setup lang="ts">
/** Moves between slides and their click steps. Positions count from 1 for people. */
defineProps<{ index: number, count: number, clicks: number, totalClicks: number }>()
const emit = defineEmits<{
  slide: [index: number]
  clicks: [clicks: number]
}>()
</script>

<template>
  <div class="flex flex-wrap items-center gap-2 text-sm">
    <button class="dey-btn" :disabled="index === 0" aria-label="Previous slide" data-testid="previous-slide" @click="emit('slide', index - 1)">
      ‹
    </button>
    <span data-testid="slide-position">Slide {{ index + 1 }} of {{ count }}</span>
    <button class="dey-btn" :disabled="index >= count - 1" aria-label="Next slide" data-testid="next-slide" @click="emit('slide', index + 1)">
      ›
    </button>
    <span class="ml-auto" />
    <button class="dey-btn" :disabled="clicks === 0" aria-label="Previous click" data-testid="previous-click" @click="emit('clicks', clicks - 1)">
      ‹
    </button>
    <span data-testid="click-position">Click {{ clicks }} of {{ totalClicks }}</span>
    <button class="dey-btn" :disabled="clicks >= totalClicks" aria-label="Next click" data-testid="next-click" @click="emit('clicks', clicks + 1)">
      ›
    </button>
  </div>
</template>
