<script setup lang="ts">
import type { Highlighter } from 'shiki'
import type { CodeStep } from './markdown'
import { ShikiMagicMove } from '@shikijs/magic-move/vue'
import { computed, shallowRef } from 'vue'
import { CODE_THEMES, knownLanguage, loadHighlighter } from './highlighter'
import { clicks, dark } from './state'
import '@shikijs/magic-move/style.css'

/** Slidev's Magic Move: one code block that morphs to the next step on each click. */
const props = defineProps<{ steps: CodeStep[], at: number }>()

const highlighter = shallowRef<Highlighter>()
loadHighlighter(props.steps.map(step => step.lang)).then((loaded) => {
  highlighter.value = loaded
})

const step = computed(() => props.steps[Math.min(Math.max(clicks.value - props.at, 0), props.steps.length - 1)])
</script>

<template>
  <div class="slidev-code-wrapper slidev-code-magic-move" :data-step="steps.indexOf(step!)">
    <ShikiMagicMove
      v-if="highlighter && step"
      class="slidev-code shiki"
      :highlighter="highlighter"
      :lang="knownLanguage(highlighter, step.lang)"
      :theme="dark ? CODE_THEMES.dark : CODE_THEMES.light"
      :code="step.code"
      :options="{ duration: 500, stagger: 1, lineNumbers: false }"
    />
    <pre v-else class="slidev-code shiki">{{ step?.code }}</pre>
  </div>
</template>
