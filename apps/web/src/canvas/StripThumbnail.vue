<script setup lang="ts">
import type { RenderRequest } from '../preview/protocol'
import { onBeforeUnmount, shallowRef, watch } from 'vue'
import SlidePreviewFrame from '../editor/SlidePreviewFrame.vue'
import { useMediaRequest } from '../platform/media'
import { LAST_CLICKS } from '../preview/protocol'

/**
 * A small live picture of a slide for the strip: a preview frame scaled to
 * the strip's width, drawing the slide as an export would, every click
 * done. Edits reach it once they pause, so a drag does not draw every
 * slide again and again.
 */
const props = defineProps<{
  content: string
  frontmatter: Record<string, unknown>
  first: boolean
  headmatter: Record<string, unknown>
}>()

/** How long the slide must stay unchanged before the picture follows it. */
const SETTLE_MS = 600

const source = shallowRef<RenderRequest>()
let timer: ReturnType<typeof setTimeout> | undefined

function build(): RenderRequest {
  return {
    type: 'deyslide:render',
    slide: { content: props.content, frontmatter: props.frontmatter, first: props.first },
    headmatter: props.headmatter,
    clicks: LAST_CLICKS,
    mode: 'print',
  }
}

// The page reads slides afresh as the deck changes: only a real change counts.
watch(() => JSON.stringify([props.content, props.frontmatter, props.first, props.headmatter]), () => {
  clearTimeout(timer)
  timer = setTimeout(() => {
    source.value = build()
  }, SETTLE_MS)
})
source.value = build()
onBeforeUnmount(() => clearTimeout(timer))

const request = useMediaRequest(() => source.value)
</script>

<template>
  <span class="pointer-events-none block aspect-video w-full overflow-hidden rounded bg-black" data-testid="strip-thumbnail">
    <SlidePreviewFrame class="!rounded-none !border-0" :request="request" tabindex="-1" data-testid="strip-preview" />
  </span>
</template>
