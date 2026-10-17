<script setup lang="ts">
import type { DeckSession, Peer } from '../deck/session'
import { deleteSlide, duplicateSlide, insertSlide, moveSlide, newId, readDeckDoc } from '@deyslide/deck-model'
import { computed, inject, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { ACCOUNT_KEY } from '../composables/useAccount'
import { peopleHere } from '../deck/presence'
import { LOCAL_ORIGIN } from '../deck/session'
import { useMediaQuery } from './media-query'
import StripThumbnail from './StripThumbnail.vue'
import { dropIndex, scrollToShow, slideTitle, thumbnailsToShow } from './strip'

/**
 * The deck's slides in order: number, title and who else is on each, with
 * a live picture of each slide on wide screens. Adds, copies and deletes
 * slides, and reorders them by dragging (a long press first on touch). It
 * runs down the side on wide screens and across, swiping, on phones.
 */
const props = defineProps<{
  session: DeckSession
  slides: { id: string, content: string, frontmatter: Record<string, unknown> }[]
  currentId?: string
  /** Nothing changes: the deck is view only or read only, or the assistant is at work. */
  locked: boolean
}>()
const emit = defineEmits<{ select: [slideId: string] }>()

/** How long a finger rests on a slide before it can be dragged. */
const LONG_PRESS_MS = 450
/** How far a press moves, in pixels, before it is a drag (mouse) or a swipe (touch). */
const DRAG_START = { mouse: 5, touch: 8 }

const titles = computed(() => props.slides.map(slide => slideTitle(slide.content)))

const account = inject(ACCOUNT_KEY, undefined)?.account

/** Others on each slide, once per person, as the header counts them: the signed in person's other pages are not others. */
const peersBySlide = computed(() => {
  const bySlide = new Map<string, Peer[]>()
  for (const peer of props.session.peers.value) {
    if (peer.slideId)
      bySlide.set(peer.slideId, [...(bySlide.get(peer.slideId) ?? []), peer])
  }
  const selfId = account?.value?.id
  return new Map([...bySlide].map(([slideId, peers]) => [slideId, peopleHere(peers, selfId)]))
})

// Live pictures of the slides --------------------------------------------------------

/** How many slide pictures run at once, at most: each is a preview frame of its own. */
const MAX_THUMBNAILS = 12

const wide = useMediaQuery('(min-width: 1024px)')
const list = ref<HTMLElement>()
/** The strip's items, by position. */
const itemElements: HTMLElement[] = []
/** Slides whose place in the strip is on screen. */
const onScreen = shallowRef(new Set<string>())
let watcher: IntersectionObserver | undefined
const watched = new Set<Element>()

const headmatter = computed(() => props.slides[0]?.frontmatter ?? {})
/** The slides that show a picture: those on screen, nearest the current slide first, at most 12. */
const thumbnails = computed(() => wide.value
  ? thumbnailsToShow(props.slides.map(slide => slide.id), onScreen.value, props.currentId, MAX_THUMBNAILS)
  : new Set<string>())

function onIntersect(entries: IntersectionObserverEntry[]) {
  const next = new Set(onScreen.value)
  for (const entry of entries) {
    const id = (entry.target as HTMLElement).dataset.slideId
    if (!id)
      continue
    if (entry.isIntersecting)
      next.add(id)
    else
      next.delete(id)
  }
  onScreen.value = next
}

/** Watches the strip's items that are new, and lets go of those that left. */
function watchItems() {
  if (!watcher)
    return
  for (const element of [...watched]) {
    if (!element.isConnected) {
      watcher.unobserve(element)
      watched.delete(element)
    }
  }
  for (const element of itemElements.slice(0, props.slides.length)) {
    if (element?.isConnected && !watched.has(element)) {
      watcher.observe(element)
      watched.add(element)
    }
  }
}

function stopWatching() {
  watcher?.disconnect()
  watcher = undefined
  watched.clear()
  onScreen.value = new Set()
}

watch(wide, (isWide) => {
  stopWatching()
  if (!isWide || typeof IntersectionObserver === 'undefined')
    return
  watcher = new IntersectionObserver(onIntersect, { root: list.value })
  watchItems()
}, { flush: 'post' })

watch(() => props.slides.map(slide => slide.id).join('\n'), () => {
  watchItems()
  // Slides that are gone are no longer on screen.
  const ids = new Set(props.slides.map(slide => slide.id))
  if ([...onScreen.value].some(id => !ids.has(id)))
    onScreen.value = new Set([...onScreen.value].filter(id => ids.has(id)))
}, { flush: 'post' })

// Keeping the current slide in sight -------------------------------------------------

/**
 * Scrolls the strip, and only the strip, so the current slide is in sight:
 * after it changes by any route (the strip, the slide buttons, the keyboard,
 * the assistant) and after slides are added, moved or removed around it.
 */
function showCurrent(smooth: boolean) {
  const box = list.value
  const index = props.slides.findIndex(slide => slide.id === props.currentId)
  const item = itemElements[index]
  if (!box || index < 0 || !item?.isConnected)
    return
  const scroll = { left: box.scrollLeft, top: box.scrollTop }
  const target = scrollToShow(box.getBoundingClientRect(), item.getBoundingClientRect(), scroll)
  if (target.left === scroll.left && target.top === scroll.top)
    return
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  box.scrollTo({ ...target, behavior: smooth && !still ? 'smooth' : 'auto' })
}

watch(() => [props.currentId, props.slides.map(slide => slide.id).join('\n')], () => showCurrent(true), { flush: 'post' })
onMounted(() => showCurrent(false))

// Adding, copying and deleting ------------------------------------------------------

/** A slide just added, shown once the page has it. */
let waitingFor: string | undefined
watch(() => props.slides, (slides) => {
  if (waitingFor && slides.some(slide => slide.id === waitingFor)) {
    emit('select', waitingFor)
    waitingFor = undefined
  }
})

/** One change to the deck, as its own undo step. */
function change(fn: () => void) {
  if (props.locked)
    return
  props.session.undo.stopCapturing()
  try {
    props.session.transact(fn)
  }
  catch {
    // Someone changed the slides meanwhile; the strip shows how they are now.
  }
  props.session.undo.stopCapturing()
}

function currentIndex() {
  return readDeckDoc(props.session.doc).slides.findIndex(slide => slide.id === props.currentId)
}

function addSlide() {
  const id = newId('s')
  change(() => insertSlide(props.session.doc, currentIndex() + 1, { id, frontmatter: {}, elements: [] }, LOCAL_ORIGIN))
  waitingFor = id
}

function duplicateCurrent() {
  const current = props.currentId
  if (!current)
    return
  change(() => {
    waitingFor = duplicateSlide(props.session.doc, current, LOCAL_ORIGIN)
  })
}

function deleteCurrent() {
  const current = props.currentId
  if (current && props.slides.length > 1)
    change(() => deleteSlide(props.session.doc, current, LOCAL_ORIGIN))
}

// Reordering by dragging ------------------------------------------------------------

const root = ref<HTMLElement>()

function setItem(element: unknown, index: number) {
  if (element instanceof HTMLElement)
    itemElements[index] = element
}

interface Drag {
  pointerId: number
  from: number
  id: string
  start: { x: number, y: number }
  touch: boolean
  active: boolean
  timer?: ReturnType<typeof setTimeout>
}

let drag: Drag | undefined
/** The slide being dragged and the place it would take. */
const moving = ref<{ id: string, to: number }>()
/** A drag just ended: the click it ends with does not open the slide. */
let swallowClick = false

/** The item a bar shows in front of (or after, past the last one), while dragging. */
const dropBefore = computed(() => {
  const current = moving.value
  if (!current)
    return undefined
  const from = props.slides.findIndex(slide => slide.id === current.id)
  return current.to >= from ? current.to + 1 : current.to
})

function stopDrag() {
  clearTimeout(drag?.timer)
  drag = undefined
  moving.value = undefined
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointercancel', stopDrag)
}

function activate(event?: PointerEvent) {
  if (!drag)
    return
  drag.active = true
  moving.value = { id: drag.id, to: drag.from }
  if (event)
    follow(event)
}

function follow(event: PointerEvent) {
  if (!drag || !moving.value)
    return
  const rects = itemElements.slice(0, props.slides.length).map(item => item.getBoundingClientRect())
  moving.value = { id: drag.id, to: dropIndex(rects, drag.from, { x: event.clientX, y: event.clientY }) }
}

function onPointerDown(event: PointerEvent, index: number) {
  if (props.locked || drag || (event.pointerType === 'mouse' && event.button !== 0))
    return
  const touch = event.pointerType !== 'mouse'
  drag = { pointerId: event.pointerId, from: index, id: props.slides[index].id, start: { x: event.clientX, y: event.clientY }, touch, active: false }
  if (touch)
    drag.timer = setTimeout(() => activate(), LONG_PRESS_MS)
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', stopDrag)
}

function onPointerMove(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.pointerId)
    return
  if (!drag.active) {
    if (Math.hypot(event.clientX - drag.start.x, event.clientY - drag.start.y) < DRAG_START[drag.touch ? 'touch' : 'mouse'])
      return
    // A finger that moves before the long press is over swipes through the strip.
    if (drag.touch) {
      stopDrag()
      return
    }
    activate(event)
    return
  }
  follow(event)
}

function onPointerUp(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.pointerId)
    return
  const dropped = drag.active ? moving.value : undefined
  stopDrag()
  if (!dropped)
    return
  swallowClick = true
  setTimeout(() => {
    swallowClick = false
  })
  const from = props.slides.findIndex(slide => slide.id === dropped.id)
  if (from >= 0 && dropped.to !== from)
    change(() => moveSlide(props.session.doc, dropped.id, dropped.to, LOCAL_ORIGIN))
}

function onClick(slideId: string) {
  if (!swallowClick)
    emit('select', slideId)
}

/** While a finger drags a slide, the strip does not scroll under it. */
function holdScroll(event: TouchEvent) {
  if (drag?.active)
    event.preventDefault()
}

/** A long press would open the browser's menu on touch screens. */
function onContextMenu(event: Event) {
  if (drag?.touch)
    event.preventDefault()
}

onMounted(() => root.value?.addEventListener('touchmove', holdScroll, { passive: false }))
onBeforeUnmount(() => {
  root.value?.removeEventListener('touchmove', holdScroll)
  stopDrag()
  stopWatching()
})
</script>

<template>
  <nav ref="root" class="flex min-w-0 flex-col gap-2" aria-label="Slides" data-testid="slide-strip">
    <ol ref="list" class="m-0 flex snap-x list-none gap-2 overflow-x-auto p-0 pb-1 md:max-h-[calc(100dvh-16rem)] md:flex-col md:overflow-x-visible md:overflow-y-auto md:pb-0">
      <li
        v-for="(slide, index) in slides"
        :key="slide.id"
        :ref="element => setItem(element, index)"
        class="relative w-36 shrink-0 snap-start select-none [-webkit-touch-callout:none] md:w-auto"
        :class="moving?.id === slide.id && 'opacity-50'"
        :data-slide-id="slide.id"
        data-testid="strip-slide"
        @pointerdown="onPointerDown($event, index)"
        @contextmenu="onContextMenu"
      >
        <span
          v-if="dropBefore === index || (dropBefore === slides.length && index === slides.length - 1)"
          class="absolute inset-y-0 w-0.5 bg-dey-accent md:inset-x-0 md:inset-y-auto md:h-0.5 md:w-auto"
          :class="dropBefore === index ? '-left-1.5 md:-top-1.5 md:left-0' : '-right-1.5 md:-bottom-1.5 md:right-0'"
          aria-hidden="true"
          data-testid="strip-drop"
        />
        <div
          class="flex flex-col rounded-md border"
          :class="slide.id === currentId ? 'border-dey-accent bg-slate-800 text-dey-accent' : 'border-dey-line text-slate-200 hover:border-slate-500'"
        >
          <!-- The picture repeats what the button says, so only the button is announced and focused. -->
          <div v-if="wide" class="cursor-pointer px-2 pt-1.5" aria-hidden="true" @click="onClick(slide.id)">
            <StripThumbnail
              v-if="thumbnails.has(slide.id)"
              :content="slide.content"
              :frontmatter="slide.frontmatter"
              :first="index === 0"
              :headmatter="headmatter"
            />
            <span v-else class="block aspect-video w-full rounded bg-slate-950" data-testid="strip-placeholder" />
          </div>
          <button
            class="flex w-full items-start gap-2 px-2 py-1.5 text-left text-sm"
            :aria-current="slide.id === currentId ? 'true' : undefined"
            @click="onClick(slide.id)"
          >
            <span class="w-5 shrink-0 text-right text-xs text-dey-muted" data-testid="strip-number">{{ index + 1 }}</span>
            <span class="min-w-0 flex-1 truncate" data-testid="strip-title">{{ titles[index] || 'Empty slide' }}</span>
            <span v-if="peersBySlide.get(slide.id)?.length" class="flex shrink-0 gap-0.5 pt-1" data-testid="strip-peers">
              <span
                v-for="person in peersBySlide.get(slide.id)"
                :key="person.id"
                class="h-2 w-2 rounded-full"
                :style="{ backgroundColor: person.color }"
                :title="person.name"
                :data-peer="person.name"
              />
            </span>
          </button>
        </div>
      </li>
    </ol>
    <div v-if="!locked" class="flex flex-wrap gap-1 md:flex-col">
      <button class="dey-btn text-xs" data-testid="add-slide" @click="addSlide">
        Add slide
      </button>
      <button class="dey-btn text-xs" :disabled="!currentId" data-testid="duplicate-slide" @click="duplicateCurrent">
        Duplicate slide
      </button>
      <button class="dey-btn text-xs" :disabled="slides.length <= 1" data-testid="delete-slide" @click="deleteCurrent">
        Delete slide
      </button>
    </div>
  </nav>
</template>
