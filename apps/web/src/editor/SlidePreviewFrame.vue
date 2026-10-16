<script setup lang="ts">
import type { Position } from '@deyslide/deck-model'
import type { CapturedSlide, ElementSize, FromPreview, KeyFromPreview, PointerFromPreview, RenderRequest, ToPreview } from '../preview/protocol'
import { onBeforeUnmount, onMounted, ref, toRaw, watch } from 'vue'

/**
 * Shows one slide through the preview page in a sandboxed iframe. The frame
 * gets its own opaque origin, so a deck's code cannot reach the app or the API.
 * `positions` moves elements by `data-id` without compiling the slide again,
 * for drags; `sizes` says how large each positioned element is laid out;
 * `capture()` returns a PNG of what the frame shows. While presenting,
 * presses and keys on the slide come out as `pointer` (at the page's own
 * client coordinates) and `key`, and `hideCursor` hides the pointer over
 * the slide.
 */
const props = defineProps<{
  request?: RenderRequest
  positions?: Record<string, Position>
  hideCursor?: boolean
}>()
const emit = defineEmits<{
  rendered: [result: { id?: string, clicks: number }]
  error: [message: string]
  sizes: [sizes: Record<string, ElementSize>]
  pointer: [event: Omit<PointerFromPreview, 'type'>]
  key: [event: Omit<KeyFromPreview, 'type'>]
}>()

/** A capture that takes longer than this answers with an error, so a caller never waits forever. */
const CAPTURE_TIMEOUT_MS = 20_000

const frame = ref<HTMLIFrameElement>()
const ready = ref(false)
let whenReady: () => void
const isReady = new Promise<void>((resolve) => {
  whenReady = resolve
})

function send(message: ToPreview) {
  frame.value?.contentWindow?.postMessage(message, '*')
}

function postPositions() {
  if (ready.value)
    send({ type: 'deyslide:positions', positions: JSON.parse(JSON.stringify(props.positions ?? {})) as Record<string, Position> })
}

function postCursor() {
  if (ready.value)
    send({ type: 'deyslide:cursor', hidden: props.hideCursor === true })
}

function post() {
  if (!ready.value || !props.request)
    return
  send(structuredClone(toRaw(props.request)))
  // A render drops the positions the frame had, so the ones still wanted go again.
  if (props.positions && Object.keys(props.positions).length)
    postPositions()
}

let captures = 0
const waiting = new Map<string, (result: CapturedSlide) => void>()

/** Draws the slide the frame shows to a PNG, after its components, fonts and 3D snapshots settle. */
function capture(pixelRatio?: number): Promise<CapturedSlide> {
  const id = `capture-${++captures}`
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish({ overflow: false, error: 'The slide took too long to capture.' }), CAPTURE_TIMEOUT_MS)
    function finish(result: CapturedSlide) {
      clearTimeout(timer)
      waiting.delete(id)
      resolve(result)
    }
    waiting.set(id, finish)
    void isReady.then(() => {
      if (waiting.has(id))
        send({ type: 'deyslide:capture', id, ...(pixelRatio === undefined ? {} : { pixelRatio }) })
    })
  })
}

function onMessage(event: MessageEvent<FromPreview>) {
  if (event.source !== frame.value?.contentWindow)
    return
  const message = event.data
  if (message?.type === 'deyslide:ready') {
    ready.value = true
    whenReady()
    post()
    // A frame that never hid the pointer has nothing to say about it.
    if (props.hideCursor)
      postCursor()
  }
  else if (message?.type === 'deyslide:rendered') {
    emit('rendered', { id: message.id, clicks: message.clicks })
  }
  else if (message?.type === 'deyslide:error') {
    // An error about a render this component has since replaced is not about the slide it asks for.
    if (message.id === undefined || message.id === props.request?.id)
      emit('error', message.message)
  }
  else if (message?.type === 'deyslide:captured') {
    const { png, overflow, error } = message
    waiting.get(message.id)?.({ ...(png ? { png } : {}), overflow, ...(error ? { error } : {}) })
  }
  else if (message?.type === 'deyslide:pointer' && frame.value) {
    // The frame counts from its own corner, inside its border.
    const box = frame.value.getBoundingClientRect()
    const { type: _, ...pointer } = message
    emit('pointer', { ...pointer, x: box.left + frame.value.clientLeft + message.x, y: box.top + frame.value.clientTop + message.y })
  }
  else if (message?.type === 'deyslide:key') {
    const { type: _, ...key } = message
    emit('key', key)
  }
  else if (message?.type === 'deyslide:sizes') {
    emit('sizes', usableSizes(message.sizes))
  }
}

/** The sizes a message gives that are real sizes; the rest are dropped. */
function usableSizes(value: unknown): Record<string, ElementSize> {
  const sizes = Object.create(null) as Record<string, ElementSize>
  if (typeof value !== 'object' || value === null)
    return sizes
  for (const [id, size] of Object.entries(value as Record<string, Partial<ElementSize> | null>)) {
    const { w, h } = size ?? {}
    if (typeof w === 'number' && typeof h === 'number' && Number.isFinite(w) && Number.isFinite(h) && w >= 0 && h >= 0)
      sizes[id] = { w, h }
  }
  return sizes
}

watch(() => props.request, post, { deep: true })
watch(() => props.positions, postPositions, { deep: true })
watch(() => props.hideCursor === true, postCursor)
onMounted(() => window.addEventListener('message', onMessage))
onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage)
  for (const finish of [...waiting.values()])
    finish({ overflow: false, error: 'The preview closed before the slide was captured.' })
})

defineExpose({ capture })
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
