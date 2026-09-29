<script setup lang="ts">
import type { CompiledSlide } from './compile'
import type { FromPreview, RenderRequest } from './protocol'
import { computed, onMounted, onScopeDispose, ref, shallowRef } from 'vue'
import { SLIDE_HEIGHT, SLIDE_WIDTH } from './canvas'
import { LAYOUTS } from './layouts'
import { renderSlide } from './render'
import { clicks, dark } from './state'

const compiled = shallowRef<CompiledSlide>()
const error = ref('')
const version = ref(0)
const fonts = ref<{ sans?: string, mono?: string }>({})
const stage = ref<HTMLElement>()
const scale = ref(1)

function send(message: FromPreview) {
  window.parent.postMessage(message, '*')
}

function applyHeadmatter(headmatter: Record<string, unknown>) {
  const schema = headmatter.colorSchema
  dark.value = schema === 'dark' || (schema !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark.value)
  fonts.value = typeof headmatter.fonts === 'object' && headmatter.fonts ? headmatter.fonts as typeof fonts.value : {}
}

let latest = 0
async function render(request: RenderRequest) {
  const run = ++latest
  applyHeadmatter(request.headmatter)
  try {
    const next = await renderSlide(request.slide, LAYOUTS)
    if (run !== latest)
      return
    compiled.value = next
    error.value = ''
    version.value++
    clicks.value = Math.min(request.clicks, next.clicks)
    send({ type: 'deyslide:rendered', clicks: next.clicks })
  }
  catch (caught) {
    if (run !== latest)
      return
    error.value = caught instanceof Error ? caught.message : String(caught)
    send({ type: 'deyslide:error', message: error.value })
  }
}

function onMessage(event: MessageEvent) {
  // Only the editor that embeds this frame may drive it.
  if (event.source !== window.parent || event.data?.type !== 'deyslide:render')
    return
  void render(event.data as RenderRequest)
}

const pageStyle = computed(() => ({
  width: `${SLIDE_WIDTH}px`,
  height: `${SLIDE_HEIGHT}px`,
  transform: `scale(${scale.value})`,
  fontFamily: fonts.value.sans ? `${fonts.value.sans}, ui-sans-serif, system-ui, sans-serif` : undefined,
}))

const observer = new ResizeObserver(([entry]) => {
  scale.value = Math.min(entry.contentRect.width / SLIDE_WIDTH, entry.contentRect.height / SLIDE_HEIGHT)
})

function onSlideError(event: Event) {
  error.value = (event as CustomEvent<string>).detail
  send({ type: 'deyslide:error', message: error.value })
}

onMounted(() => {
  window.addEventListener('message', onMessage)
  window.addEventListener('deyslide:slide-error', onSlideError)
  if (stage.value)
    observer.observe(stage.value)
  send({ type: 'deyslide:ready' })
})

onScopeDispose(() => {
  window.removeEventListener('message', onMessage)
  window.removeEventListener('deyslide:slide-error', onSlideError)
  observer.disconnect()
})

defineExpose({ render })
</script>

<template>
  <div ref="stage" class="preview-stage">
    <div class="slidev-page bg-main text-main" :style="pageStyle" data-testid="slide">
      <component :is="compiled.component" v-if="compiled" :key="version" />
    </div>
    <div v-if="error" class="preview-error" role="alert" data-testid="preview-error">
      {{ error }}
    </div>
  </div>
</template>
