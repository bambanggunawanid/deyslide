<script setup lang="ts">
import { parsePos } from '@deyslide/deck-model/position'
import { computed, useAttrs } from 'vue'
import { positions } from './state'

/**
 * Slidev's `<v-drag pos="x,y,w,h,rotate">`, placed in slide canvas units.
 * While the editor drags an element, the position it sends for this
 * element's `data-id` wins over `pos`, so nothing compiles again.
 */
const props = defineProps<{ pos?: string }>()
const id = useAttrs()['data-id']

const style = computed(() => {
  // Only the editor's own entries count, never a name such as `constructor` that every object has.
  const given = typeof id === 'string' && Object.hasOwn(positions.value, id) ? positions.value[id] : undefined
  const pos = given ?? (props.pos ? parsePos(props.pos) : undefined)
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
