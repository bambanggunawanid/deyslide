<script setup lang="ts">
import type { CompiledSlide } from './compile'
import type { CaptureRequest, FromPreview, RenderRequest, ToPreview } from './protocol'
import type { SlideScope as Scope } from './scope'
import type { PreviewMode } from './state'
import type { TransitionName } from './transitions'
import { computed, onMounted, onScopeDispose, ref, shallowRef, watchEffect } from 'vue'
import { SLIDE_HEIGHT, SLIDE_WIDTH } from './canvas'
import { measureOverflow, rasterize, settle } from './capture'
import { loadFonts, resolveFonts } from './fonts'
import { forwardInput } from './input'
import { LAYOUTS } from './layouts'
import { usablePositions } from './positions'
import { REPLACED } from './protocol'
import { renderSlide } from './render'
import { createSlideScope } from './scope'
import SlideScope from './SlideScope'
import { clicks, dark, frontmatter, headmatter, mode, positions, totalClicks } from './state'
import { resolveTransition, slideTransition } from './transitions'

/** A slide mounted in the page: the one on screen, or while presenting, one on its way out. */
interface ShownSlide {
  version: number
  compiled: CompiledSlide
  scope: Scope
  /** Fixes what the slide shows, once it starts to leave. */
  freeze: () => void
  /** The transition it enters with, and then leaves with. */
  transition?: TransitionName
}

const compiled = shallowRef<CompiledSlide>()
const error = ref('')
/** True while the presenting page says the pointer rests. */
const cursorHidden = ref(false)
/** The slide on screen. */
const version = ref(0)
const shown = shallowRef<ShownSlide[]>([])
const stage = ref<HTMLElement>()
const page = ref<HTMLElement>()
/** The stage's size in CSS pixels. */
const box = ref({ width: SLIDE_WIDTH, height: SLIDE_HEIGHT })
const scale = computed(() => {
  const fit = Math.min(box.value.width / SLIDE_WIDTH, box.value.height / SLIDE_HEIGHT)
  // A slide is 551.25 units tall, so at the scale that fits it the last row
  // of pixels is only partly covered and shows the dark frame through it.
  // Presenting fills the screen, so the slide grows by a pixel, which the
  // stage clips, rather than show a dark line along its edge.
  return mode.value === 'present' ? fit + 1 / SLIDE_HEIGHT : fit
})

function send(message: FromPreview, transfer: Transferable[] = []) {
  window.parent.postMessage(message, '*', transfer)
}

const fonts = computed(() => resolveFonts(headmatter.value.fonts))

function applyHeadmatter(settings: Record<string, unknown>) {
  const schema = settings.colorSchema
  dark.value = schema === 'dark' || (schema !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark.value)
  headmatter.value = settings
  loadFonts(fonts.value.url)
}

function modeOf(request: RenderRequest): PreviewMode {
  return request.mode === 'present' || request.mode === 'print' ? request.mode : 'edit'
}

/** What decides the slide's content. A render that changes none of it only moves through clicks. */
function contentKey(request: RenderRequest) {
  return JSON.stringify([request.slide, request.headmatter, modeOf(request), request.media ?? {}])
}

/** Counts renders in the order they arrive, so a slow compile never replaces a newer one. */
let latest = 0
/** The newest render that had arrived when the positions on screen did. */
let positionsAfter = 0
/** The content on screen, and the render that put it there. */
let shownKey: string | undefined
let shownId: string | undefined
/** True when the latest render did not compile, so the slide on screen is an older one. */
let failed = false
/** An error the slide on screen threw while running, kept as long as that slide is mounted. */
let slideError = ''
/** Settles once the newest render is on screen or has failed, so a capture draws what was asked for. */
let rendering: Promise<void> = Promise.resolve()

/** Shows the click a render asks for and answers it. */
function show(run: number, request: RenderRequest, slide: CompiledSlide) {
  // Positions stay until the next render, unless they came after it.
  if (positionsAfter < run)
    positions.value = {}
  clicks.value = Number.isFinite(request.clicks) ? Math.min(Math.max(0, request.clicks), slide.clicks) : 0
  totalClicks.value = slide.clicks
  error.value = ''
  failed = false
  shownId = request.id
  send({ type: 'deyslide:rendered', id: request.id, clicks: slide.clicks })
}

/** A render that a newer one overtook still gets a reply, so a caller waiting on its id moves on. */
function replaced(request: RenderRequest) {
  if (request.id !== undefined)
    send({ type: 'deyslide:error', id: request.id, message: REPLACED })
}

async function render(request: RenderRequest) {
  const run = ++latest
  const key = contentKey(request)
  const sameContent = !!compiled.value && key === shownKey
  // Only the click changed: the slide stays mounted, so Magic Move morphs and cameras glide.
  // Two cases mount it afresh anyway: print mode, since an export needs each step in its
  // final state, and a slide that threw, so its error clears once a click no longer causes it.
  if (sameContent && !slideError && modeOf(request) !== 'print')
    return show(run, request, compiled.value!)

  try {
    const next = sameContent ? compiled.value! : await renderSlide(request.slide, LAYOUTS, request.media)
    if (run !== latest)
      return replaced(request)
    // The slide on screen is the one being left.
    const leaving = frontmatter.value
    // A window nobody can see paints no frames, so a transition there would never end: the slide is swapped at once.
    const transition = modeOf(request) === 'present' && request.transition && document.visibilityState !== 'hidden'
      ? resolveTransition(request.transition.name || slideTransition(request.transition.back ? request.slide.frontmatter : leaving, request.headmatter), request.transition.back)
      : undefined
    // Slides on their way out keep what they show, whatever the next slide shows.
    for (const slide of shown.value)
      slide.freeze()
    mode.value = modeOf(request)
    frontmatter.value = request.slide.frontmatter
    applyHeadmatter(request.headmatter)
    compiled.value = next
    const onScreen = shown.value.filter(slide => slide.version === version.value)
    const entering: ShownSlide = { version: ++version.value, compiled: next, ...createSlideScope(), transition }
    // A transition slides the next slide in over the last, which stays mounted
    // (3D scenes keep drawing) until it is gone. Otherwise the next one replaces it.
    // Only the slide on screen leaves: slides still on their way out from
    // earlier moves are gone at once, so quick moves never pile slides up.
    if (transition) {
      for (const slide of onScreen)
        slide.transition = transition
      shown.value = [...onScreen, entering]
    }
    else {
      shown.value = [entering]
    }
    shownKey = key
    slideError = ''
    show(run, request, next)
  }
  catch (caught) {
    if (run !== latest)
      return replaced(request)
    failed = true
    error.value = caught instanceof Error ? caught.message : String(caught)
    send({ type: 'deyslide:error', id: request.id, message: error.value })
  }
}

/** A slide that has left unmounts. */
function drop(slide: ShownSlide) {
  if (slide.version !== version.value)
    shown.value = shown.value.filter(item => item !== slide)
}

async function capture(request: CaptureRequest) {
  await rendering
  const slide = page.value
  // A slide that did not compile leaves an older one on screen, which is not the one asked for.
  if (failed || !compiled.value || !slide) {
    send({ type: 'deyslide:captured', id: request.id, overflow: false, error: failed ? error.value : 'There is no slide to capture yet.' })
    return
  }
  try {
    await settle(slide)
    const overflow = measureOverflow(slide)
    const ratio = Number.isFinite(request.pixelRatio) && request.pixelRatio! > 0 ? Math.min(request.pixelRatio!, 4) : 1
    const png = await rasterize(slide, ratio)
    send({ type: 'deyslide:captured', id: request.id, png, overflow, ...(error.value ? { error: error.value } : {}) }, [png])
  }
  catch (caught) {
    send({ type: 'deyslide:captured', id: request.id, overflow: false, error: caught instanceof Error ? caught.message : String(caught) })
  }
}

function onMessage(event: MessageEvent) {
  // Only the editor that embeds this frame may drive it.
  if (event.source !== window.parent)
    return
  const message = event.data as ToPreview | undefined
  if (message?.type === 'deyslide:render') {
    rendering = render(message)
  }
  else if (message?.type === 'deyslide:positions') {
    positions.value = usablePositions(message.positions)
    positionsAfter = latest
  }
  else if (message?.type === 'deyslide:capture' && typeof message.id === 'string') {
    void capture(message)
  }
  else if (message?.type === 'deyslide:cursor') {
    cursorHidden.value = message.hidden === true
  }
}

const pageStyle = computed(() => {
  const style: Record<string, string> = {
    width: `${SLIDE_WIDTH}px`,
    height: `${SLIDE_HEIGHT}px`,
    transform: `scale(${scale.value})`,
  }
  // styles.css falls back to the preview's own fonts for any family the deck does not name.
  for (const kind of ['sans', 'serif', 'mono'] as const) {
    const stack = fonts.value[kind]
    if (stack)
      style[`--deck-font-${kind}`] = stack
  }
  return style
})

const observer = new ResizeObserver(([entry]) => {
  box.value = { width: entry.contentRect.width, height: entry.contentRect.height }
})

// Presenting leaves swipes to the page, which the browser would otherwise take for scrolling or zooming.
watchEffect(() => {
  document.documentElement.style.touchAction = mode.value === 'present' ? 'none' : ''
})

// The pointer hides over the slide as it does over the page around it, while presses still reach the slide.
watchEffect(() => {
  document.documentElement.classList.toggle('preview-cursor-hidden', cursorHidden.value && mode.value === 'present')
})

/** While presenting, presses and keys on the slide go to the page too, which moves the talk. */
const stopForwarding = forwardInput(send, () => mode.value === 'present')

function onSlideError(event: Event) {
  slideError = (event as CustomEvent<string>).detail
  error.value = slideError
  send({ type: 'deyslide:error', id: shownId, message: slideError })
}

onMounted(() => {
  window.addEventListener('message', onMessage)
  window.addEventListener('deyslide:slide-error', onSlideError)
  if (stage.value)
    observer.observe(stage.value)
  send({ type: 'deyslide:ready' })
})

onScopeDispose(() => {
  stopForwarding()
  document.documentElement.classList.remove('preview-cursor-hidden')
  window.removeEventListener('message', onMessage)
  window.removeEventListener('deyslide:slide-error', onSlideError)
  observer.disconnect()
})

defineExpose({ render })
</script>

<template>
  <div ref="stage" class="preview-stage">
    <div ref="page" class="slidev-page bg-main text-main" :style="pageStyle" data-testid="slide">
      <!-- Presenting slides the next slide in; elsewhere it replaces the last one at once. -->
      <Transition
        v-for="slide in shown"
        :key="slide.version"
        :name="slide.transition"
        :css="!!slide.transition"
        appear
        @after-leave="drop(slide)"
      >
        <SlideScope v-show="slide.version === version" :scope="slide.scope" class="preview-slide">
          <component :is="slide.compiled.component" />
        </SlideScope>
      </Transition>
    </div>
    <div v-if="error" class="preview-error" role="alert" data-testid="preview-error">
      {{ error }}
    </div>
  </div>
</template>
