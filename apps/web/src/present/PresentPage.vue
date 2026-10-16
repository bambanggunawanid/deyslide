<script setup lang="ts">
import type { KeyTarget } from '../preview/protocol'
import type { PresentAction } from './navigation'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import SlidePreviewFrame from '../editor/SlidePreviewFrame.vue'
import { isAudienceWindow, isDesktopApp, isFullscreen, leaveAudienceWindow, setFullscreen } from '../platform/platform'
import { keyTarget } from '../preview/input'
import { Autoplay, autoplayNext, dwellMs, keyAction, keyBelongsTo, pointerAction, slideNumber } from './navigation'
import PresentOverview from './PresentOverview.vue'
import { usePresentation } from './presentation'

/**
 * The audience view: the slide on screen, full window on black, moved by
 * keys, taps and swipes. Live Teaching moves by hand; Cinematic plays the
 * talk by itself.
 */
const props = defineProps<{ projectId: string, deckId: string }>()

const route = useRoute()
const router = useRouter()
const talk = usePresentation(props)
const { summary, problem, ready, slides, index, clicks, totalClicks, request, slide } = talk

/** How long the pointer may rest before it and the controls hide. */
const IDLE_MS = 2000
/** How long the controls stay after a finger asked for them. */
const TOUCH_CONTROLS_MS = 5000

const previewError = ref('')
const overview = ref(false)
const going = ref(false)
const goingTo = ref('')
const goError = ref('')
const goInput = ref<HTMLInputElement>()
const idle = ref(false)
/** True on touch screens, where nothing hovers: the controls come from a button rather than a moving pointer. */
const touch = ref(typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches)
/** True in the audience window a presenter view opened, which closes rather than open the editor. */
const audienceWindow = ref(false)
/** The overview's pictures of slides, kept while presenting. */
const pictures = new Map<string, string>()

// Cinematic: autoplay, with the loop if asked for. The address can ask for both.
const loop = ref(route.query.loop === '1')
const playing = ref(false)
const autoplay = new Autoplay({
  dwellMs: () => dwellMs(slide.value?.frontmatter ?? {}),
  advance: () => {
    // A slide whose clicks are not known yet: the step waits for the preview, then goes on.
    if (totalClicks.value === undefined) {
      talk.next()
      return true
    }
    const target = autoplayNext(talk.deck.value, talk.position.value, loop.value)
    if (!target)
      return false
    talk.moveTo(target)
    return true
  },
  onChange: (running) => {
    playing.value = running
  },
})

// A move by hand, or from the other window, gives the new step its whole time on screen.
watch(() => [index.value, clicks.value], () => autoplay.restart())

watch(ready, (isReady) => {
  if (isReady && route.query.mode === 'cinematic')
    autoplay.start()
}, { immediate: true })

function setMode(cinematic: boolean) {
  if (cinematic)
    autoplay.start()
  else
    autoplay.stop()
}

function onRendered(result: { id?: string, clicks: number }) {
  talk.onRendered(result)
  previewError.value = ''
}

function onPreviewError(message: string) {
  previewError.value = message
  talk.onError(request.value?.id, message)
}

// Moving ---------------------------------------------------------------------

async function leave() {
  if (await leaveAudienceWindow(props.deckId))
    return
  // The editor opens on the slide the talk ended on.
  await router.push({ name: 'deck', params: { projectId: props.projectId, deckId: props.deckId }, query: { slide: String(index.value + 1) } })
}

async function escape() {
  if (going.value) {
    going.value = false
    return
  }
  if (overview.value) {
    overview.value = false
    return
  }
  if (await isFullscreen()) {
    await setFullscreen(false)
    return
  }
  await leave()
}

async function openGoTo() {
  overview.value = false
  going.value = true
  goingTo.value = ''
  goError.value = ''
  await nextTick()
  goInput.value?.focus()
}

function submitGoTo() {
  const target = slideNumber(talk.deck.value, goingTo.value)
  if (target === undefined) {
    goError.value = `Type a slide number from 1 to ${slides.value.length}.`
    return
  }
  going.value = false
  talk.goTo(target)
}

function pick(slideIndex: number) {
  overview.value = false
  talk.goTo(slideIndex)
}

async function run(action: PresentAction) {
  switch (action) {
    case 'next': return talk.next()
    case 'previous': return talk.previous()
    case 'first': return talk.first()
    case 'last': return talk.last()
    case 'fullscreen': return setFullscreen(!(await isFullscreen()))
    case 'overview':
      overview.value = !overview.value
      going.value = false
      return
    case 'goto': return openGoTo()
    case 'autoplay': return autoplay.toggle()
    case 'escape': return escape()
  }
}

/** A key pressed on the page, or on the slide (the frame passes it on). Returns whether the talk took it. */
function onTalkKey(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'metaKey'>, target: KeyTarget) {
  // Typing a slide number, or pressing a focused button, is not a talk key.
  if (keyBelongsTo(target, event.key))
    return false
  const action = keyAction(event)
  if (!action || (overview.value && action !== 'overview' && action !== 'escape' && action !== 'goto'))
    return false
  void run(action)
  return true
}

function onKey(event: KeyboardEvent) {
  if (onTalkKey(event, keyTarget(event.target)))
    event.preventDefault()
}

// Taps, clicks and swipes on the slide, and around it.
let pressed: { id: number, x: number, y: number } | undefined

interface Press { pointerId: number, pointerType: string, button: number, x: number, y: number }

function pressDown(press: Press, interactive = false) {
  touch.value = press.pointerType === 'touch'
  // A press on something the slide lets people use (a button, a 3D scene to turn) is the slide's.
  pressed = press.button === 0 && !interactive ? { id: press.pointerId, x: press.x, y: press.y } : undefined
}

function pressUp(press: Press) {
  // A finger moving the talk leaves the slide clear; a mouse shows the cursor and the controls again.
  if (press.pointerType !== 'touch')
    wake()
  if (!pressed || pressed.id !== press.pointerId)
    return
  const action = pointerAction(pressed, { x: press.x, y: press.y }, window.innerWidth, press.pointerType)
  pressed = undefined
  // A tap beside the slide number form closes it rather than moving on.
  if (going.value)
    going.value = false
  else if (action)
    void run(action)
}

const onPointerDown = (event: PointerEvent) => pressDown({ pointerId: event.pointerId, pointerType: event.pointerType, button: event.button, x: event.clientX, y: event.clientY })
const onPointerUp = (event: PointerEvent) => pressUp({ pointerId: event.pointerId, pointerType: event.pointerType, button: event.button, x: event.clientX, y: event.clientY })

/** A press, move or release on the slide, which the frame passes on at the page's coordinates. */
function onFramePointer(event: Press & { phase: 'down' | 'move' | 'up' | 'cancel', interactive: boolean }) {
  if (event.phase === 'down')
    pressDown(event, event.interactive)
  else if (event.phase === 'up')
    pressUp(event)
  else if (event.phase === 'cancel')
    pressed = undefined
  else if (event.pointerType !== 'touch')
    wake()
}

function onFrameKey(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'metaKey'> & { target: KeyTarget }) {
  onTalkKey(event, event.target)
}

function onPointerMove(event: PointerEvent) {
  if (event.pointerType !== 'touch')
    wake()
}

// The cursor and the controls hide while the pointer rests.
let idleTimer: ReturnType<typeof setTimeout> | undefined
function wake(ms = IDLE_MS) {
  idle.value = false
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idle.value = true
  }, ms)
}

/** On touch screens, the controls show when asked, and stay a little longer. */
function showControls() {
  wake(TOUCH_CONTROLS_MS)
}

function onControlsPointer() {
  if (touch.value)
    showControls()
  else
    wake()
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
  wake()
  void isAudienceWindow(props.deckId).then((value) => {
    audienceWindow.value = value
  })
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  clearTimeout(idleTimer)
  autoplay.stop()
  for (const url of pictures.values())
    URL.revokeObjectURL(url)
})

const counter = computed(() => `${index.value + 1} / ${slides.value.length}`)
const clickCounter = computed(() => totalClicks.value ? `Click ${Math.min(clicks.value, totalClicks.value)} of ${totalClicks.value}` : '')
const controlsShown = computed(() => (!idle.value || going.value) && !overview.value)
const cursorHidden = computed(() => idle.value && !overview.value && !going.value)
/** The app's audience window stays on the talk and closes from its title bar, so it offers no Exit. */
const canExit = computed(() => !(audienceWindow.value && isDesktopApp()))
</script>

<template>
  <div
    class="fixed inset-0 overflow-hidden bg-black text-slate-100"
    :class="cursorHidden ? 'cursor-none' : ''"
    data-testid="present-page"
    :data-idle="idle"
    @pointermove="onPointerMove"
  >
    <template v-if="summary">
      <p v-if="problem" class="m-0 p-6 text-rose-300" role="alert" data-testid="present-problem">
        {{ problem }}
      </p>
      <p v-else-if="!ready || slides.length === 0" class="m-0 p-6 text-slate-400">
        Opening the deck...
      </p>
      <template v-else>
        <!--
          One slide, as large as the window allows at 16:9, on black. Taps on
          the left third go back and the rest go on; swipes on touch screens.
          The slide passes on presses that are not on its own buttons and
          controls, so those still work.
        -->
        <div
          class="absolute inset-0 grid touch-none place-items-center"
          data-testid="present-stage"
          @pointerdown="onPointerDown"
          @pointerup="onPointerUp"
          @pointercancel="pressed = undefined"
        >
          <div class="aspect-video w-[min(100vw,177.78dvh)]">
            <!-- While the pointer rests, the slide hides it too, and presses still reach the slide's own buttons. -->
            <SlidePreviewFrame
              :request="request"
              :hide-cursor="cursorHidden"
              class="!h-full !rounded-none !border-0"
              @rendered="onRendered"
              @error="onPreviewError"
              @pointer="onFramePointer"
              @key="onFrameKey"
            />
          </div>
        </div>

        <p v-if="previewError" class="absolute left-4 right-4 top-4 m-0 rounded-md bg-rose-950/90 p-2 font-mono text-xs text-rose-200" role="alert" data-testid="slide-error">
          {{ previewError }}
        </p>

        <!-- A finger cannot hover, so a small button brings the controls back without moving the talk. -->
        <button
          v-if="touch && !controlsShown && !overview"
          class="absolute bottom-2 right-2 rounded-full bg-slate-900/60 px-3 py-1 text-sm text-slate-300"
          aria-label="Show the controls"
          data-testid="present-menu"
          @click="showControls"
        >
          •••
        </button>

        <!--
          The controls show while the pointer moves, and leave the overview its
          whole screen. A click never leaves them the focus, so Space and the
          arrows keep moving the talk.
        -->
        <div
          v-show="controlsShown"
          class="absolute bottom-2 left-1/2 flex max-w-[calc(100vw-1rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-0.5 rounded-lg bg-slate-900/85 p-1 text-xs sm:bottom-3 sm:gap-1 sm:text-sm"
          data-testid="present-controls"
          @pointerdown="onControlsPointer"
          @mousedown.prevent
        >
          <button class="rounded px-1.5 py-1 hover:bg-slate-700 sm:px-2" aria-label="Previous" data-testid="present-previous" @click="talk.previous()">
            ‹
          </button>
          <span class="px-1 tabular-nums" data-testid="present-position">{{ counter }}</span>
          <span v-if="clickCounter" class="px-1 text-slate-400 tabular-nums" data-testid="present-clicks">{{ clickCounter }}</span>
          <button class="rounded px-1.5 py-1 hover:bg-slate-700 sm:px-2" aria-label="Next" data-testid="present-next" @click="talk.next()">
            ›
          </button>
          <button class="rounded px-1.5 py-1 hover:bg-slate-700 sm:px-2" :aria-pressed="overview" data-testid="present-overview" @click="run('overview')">
            Overview
          </button>
          <button class="rounded px-1.5 py-1 hover:bg-slate-700 sm:px-2" data-testid="present-goto" @click="openGoTo">
            Go to
          </button>
          <div class="flex overflow-hidden rounded border border-slate-700" role="group" aria-label="Mode">
            <button class="px-1.5 py-1 sm:px-2" :class="!playing ? 'bg-slate-700 text-dey-accent' : 'text-slate-300'" :aria-pressed="!playing" data-testid="mode-teaching" @click="setMode(false)">
              Live Teaching
            </button>
            <button class="px-1.5 py-1 sm:px-2" :class="playing ? 'bg-slate-700 text-dey-accent' : 'text-slate-300'" :aria-pressed="playing" data-testid="mode-cinematic" @click="setMode(true)">
              Cinematic
            </button>
          </div>
          <label class="flex items-center gap-1 px-1.5 text-slate-300 sm:px-2">
            <input v-model="loop" type="checkbox" data-testid="present-loop">
            Loop
          </label>
          <button class="rounded px-1.5 py-1 hover:bg-slate-700 sm:px-2" data-testid="present-fullscreen" @click="run('fullscreen')">
            Full screen
          </button>
          <RouterLink
            v-if="!audienceWindow"
            :to="{ name: 'presenter', params: { projectId, deckId }, query: { slide: String(index + 1) } }"
            class="rounded px-1.5 py-1 hover:bg-slate-700 sm:px-2"
            data-testid="present-presenter"
          >
            Presenter view
          </RouterLink>
          <button v-if="canExit" class="rounded px-1.5 py-1 hover:bg-slate-700 sm:px-2" data-testid="present-exit" @click="leave">
            Exit
          </button>
        </div>

        <PresentOverview
          v-if="overview"
          :slides="slides"
          :current="index"
          :headmatter="talk.headmatter.value"
          :cache="pictures"
          @pick="pick"
          @close="overview = false"
          @clicks="talk.learn"
        />

        <form
          v-if="going"
          class="absolute left-1/2 top-1/3 flex -translate-x-1/2 flex-col gap-2 rounded-lg bg-slate-900 p-4 shadow-xl"
          data-testid="goto-form"
          @submit.prevent="submitGoTo"
        >
          <label class="flex items-center gap-2">
            Go to slide
            <input
              ref="goInput"
              v-model="goingTo"
              inputmode="numeric"
              class="w-20 rounded border border-slate-600 bg-slate-950 px-2 py-1"
              :aria-label="`Slide number, 1 to ${slides.length}`"
              data-testid="goto-input"
            >
          </label>
          <p v-if="goError" class="m-0 text-sm text-rose-300" role="alert">
            {{ goError }}
          </p>
          <div class="flex justify-end gap-2">
            <button type="button" class="dey-btn text-sm" data-testid="goto-cancel" @click="going = false">
              Cancel
            </button>
            <button type="submit" class="dey-btn-primary text-sm" data-testid="goto-submit">
              Go
            </button>
          </div>
        </form>
      </template>
    </template>

    <div v-else class="grid h-full place-items-center p-6 text-center" data-testid="missing-deck">
      <div>
        <p class="m-0">
          This deck is not here.
        </p>
        <RouterLink to="/" class="mt-3 inline-block text-dey-accent">
          Back to your projects
        </RouterLink>
      </div>
    </div>
  </div>
</template>
