<script setup lang="ts">
import { computed } from 'vue'

/** A plain shape that fills its `v-drag` box. Used by shape elements in the deck model. */
const props = withDefaults(defineProps<{
  shape: 'rect' | 'ellipse'
  fill?: string
  stroke?: string
  strokeWidth?: number
}>(), {
  fill: '#38bdf8',
  strokeWidth: 0,
})

const style = computed(() => ({
  background: props.fill,
  border: props.stroke && props.strokeWidth > 0 ? `${props.strokeWidth}px solid ${props.stroke}` : 'none',
  borderRadius: props.shape === 'ellipse' ? '50%' : '0',
}))
</script>

<template>
  <div class="deyslide-shape h-full min-h-4 w-full" :data-shape="shape" :style="style" />
</template>
