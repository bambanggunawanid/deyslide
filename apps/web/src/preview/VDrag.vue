<script setup lang="ts">
import { parsePos } from '@deyslide/deck-model/position'
import { computed } from 'vue'

/** Slidev's `<v-drag pos="x,y,w,h,rotate">`, placed in slide canvas units. */
const props = defineProps<{ pos?: string }>()

const style = computed(() => {
  const pos = props.pos ? parsePos(props.pos) : undefined
  if (!pos)
    return {}
  return {
    position: 'absolute' as const,
    left: `${pos.x}px`,
    top: `${pos.y}px`,
    width: `${pos.w}px`,
    height: pos.h === null ? undefined : `${pos.h}px`,
    transform: pos.rotate ? `rotate(${pos.rotate}deg)` : undefined,
  }
})
</script>

<template>
  <div class="v-drag" :style="style">
    <slot />
  </div>
</template>
