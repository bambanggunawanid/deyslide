<script setup lang="ts">
import type { FromPreview, RenderRequest } from '../preview/protocol'
import { onBeforeUnmount, onMounted, ref, toRaw, watch } from 'vue'

/**
 * Shows one slide through the preview page in a sandboxed iframe. The frame
 * gets its own opaque origin, so a deck's code cannot reach the app or the API.
 */
const props = defineProps<{ request?: RenderRequest }>()
const emit = defineEmits<{
  rendered: [clicks: number]
  error: [message: string]
}>()

const frame = ref<HTMLIFrameElement>()
const ready = ref(false)

function post() {
  if (ready.value && props.request)
    frame.value?.contentWindow?.postMessage(structuredClone(toRaw(props.request)), '*')
}

function onMessage(event: MessageEvent<FromPreview>) {
  if (event.source !== frame.value?.contentWindow)
    return
  if (event.data?.type === 'deyslide:ready') {
    ready.value = true
    post()
  }
  else if (event.data?.type === 'deyslide:rendered') {
    emit('rendered', event.data.clicks)
  }
  else if (event.data?.type === 'deyslide:error') {
    emit('error', event.data.message)
  }
}

watch(() => props.request, post, { deep: true })
onMounted(() => window.addEventListener('message', onMessage))
onBeforeUnmount(() => window.removeEventListener('message', onMessage))
</script>

<template>
  <iframe
    ref="frame"
    src="/preview.html"
    sandbox="allow-scripts"
    title="Slide preview"
    class="block aspect-video w-full rounded-md border border-dey-line bg-black"
    data-testid="preview-frame"
  />
</template>
