<script setup lang="ts">
import type { MotionCanvasPlayerElement, PlayerStatus } from '../src/algo-player/controller'
import { useIsSlideActive } from '@slidev/client'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { createPlayerController, resolvePlayerSrc } from '../src/algo-player/controller'

const props = withDefaults(defineProps<{
  /** URL of a built Motion Canvas project, for example `/animations/bubble-sort.js`. */
  src: string
  /** Start playing when the slide becomes active. */
  autoplay?: boolean
  /** Start over when the animation ends. */
  loop?: boolean
  /** Show the Deyslide control bar under the canvas. */
  controls?: boolean
  /** Rendering quality passed to the player, from 0 to 1. */
  quality?: number
  /** Project variables, forwarded to the player as JSON. */
  variables?: Record<string, unknown>
  /** How long to wait for the project bundle before showing an error. */
  timeoutMs?: number
}>(), {
  autoplay: true,
  loop: true,
  controls: true,
  timeoutMs: 15000,
})

const emit = defineEmits<{
  status: [status: PlayerStatus]
}>()

const element = shallowRef<MotionCanvasPlayerElement | null>(null)
const controller = createPlayerController(() => element.value)
const status = ref<PlayerStatus>('loading')
const playing = ref(false)
const looping = ref(props.loop)
const isSlideActive = useIsSlideActive()

const resolvedSrc = computed(() => resolvePlayerSrc(props.src, import.meta.env.BASE_URL, window.location.href))
const variablesAttr = computed(() => props.variables ? JSON.stringify(props.variables) : undefined)

let poll: ReturnType<typeof setInterval> | undefined

function stopPolling() {
  if (poll)
    clearInterval(poll)
  poll = undefined
}

function syncPlaying() {
  playing.value = !!element.value?.playing
}

function onReady() {
  controller.setLoop(looping.value)
  if (props.autoplay && isSlideActive.value)
    play()
}

function waitForReady() {
  stopPolling()
  status.value = 'loading'
  const started = Date.now()
  poll = setInterval(() => {
    const next = controller.status()
    if (next === 'loading' && Date.now() - started < props.timeoutMs)
      return
    stopPolling()
    status.value = next === 'loading' ? 'error' : next
    if (status.value === 'ready')
      onReady()
  }, 100)
}

function play() {
  controller.play()
  syncPlaying()
}

function pause() {
  controller.pause()
  syncPlaying()
}

function toggle() {
  controller.toggle()
  syncPlaying()
}

function restart() {
  controller.restart()
  play()
}

function toggleLoop() {
  looping.value = !looping.value
  controller.setLoop(looping.value)
}

watch(status, value => emit('status', value))

watch(isSlideActive, (active) => {
  if (status.value !== 'ready')
    return
  if (active && props.autoplay)
    play()
  else if (!active)
    pause()
})

watch(() => props.loop, (value) => {
  looping.value = value
  controller.setLoop(value)
})

watch(() => props.src, () => waitForReady())

onMounted(async () => {
  // The player registers a custom element that touches `window`, so it is
  // loaded only in the browser and only when a slide actually uses it.
  await import('@motion-canvas/player')
  waitForReady()
})

onBeforeUnmount(stopPolling)

defineExpose({ play, pause, toggle, restart, toggleLoop, status, playing, looping })
</script>

<template>
  <div class="deyslide-algo-player flex flex-col gap-2" :data-status="status">
    <div class="relative overflow-hidden rounded-lg border border-slate-700/60 bg-[#0b1020]">
      <motion-canvas-player
        ref="element"
        class="block w-full"
        :src="resolvedSrc"
        :quality="quality"
        :variables="variablesAttr"
      />
      <div
        v-if="status === 'error'"
        class="absolute inset-0 flex items-center justify-center bg-black/70 p-4 text-center text-sm text-rose-300"
        role="alert"
      >
        Could not load {{ src }}. Run <code>pnpm animations:build</code> and reload.
      </div>
    </div>
    <div v-if="controls" class="flex items-center gap-2 text-sm">
      <button
        class="dey-btn"
        data-testid="algo-toggle"
        :disabled="status !== 'ready'"
        @click="toggle"
      >
        {{ playing ? 'Pause' : 'Play' }}
      </button>
      <button
        class="dey-btn"
        data-testid="algo-restart"
        :disabled="status !== 'ready'"
        @click="restart"
      >
        Restart
      </button>
      <button
        class="dey-btn"
        data-testid="algo-loop"
        :aria-pressed="looping"
        :disabled="status !== 'ready'"
        @click="toggleLoop"
      >
        Loop: {{ looping ? 'on' : 'off' }}
      </button>
      <span class="ml-auto text-xs uppercase tracking-wide text-slate-400" data-testid="algo-status">
        {{ status }}
      </span>
    </div>
  </div>
</template>
