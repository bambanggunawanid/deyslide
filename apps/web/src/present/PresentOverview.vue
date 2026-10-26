<script setup lang="ts">
import type { PresentSlide } from './outline'
import { inject, onBeforeUnmount, onMounted, ref, shallowReactive } from 'vue'
import SlidePreviewFrame from '../editor/SlidePreviewFrame.vue'
import { MEDIA_DECK_KEY } from '../platform/media'
import { useFrameRenderer } from './frame-renderer'
import { LAST_CLICKS } from './navigation'

/**
 * Every slide in a grid: its number, its title and a small picture. Picking
 * one goes there. The pictures come one by one from a hidden preview frame,
 * which mounts each slide in print mode (a 3D scene waits for its snapshot)
 * and copies it into an image: a second or more each. So the tiles in view
 * come first, from the slide on screen, and pictures stay for the whole
 * talk, until a slide changes.
 */
const props = defineProps<{
  slides: PresentSlide[]
  current: number
  headmatter: Record<string, unknown>
  /** Pictures drawn earlier, by what the slide shows, as object URLs. The page owns them. */
  cache: Map<string, string>
}>()
const emit = defineEmits<{
  pick: [index: number]
  close: []
  /** A slide's click count, learned while drawing its picture. */
  clicks: [slide: PresentSlide, total: number]
}>()

/** Pictures are 320 by 180: a quarter of a 1280 by 720 capture. */
const THUMBNAIL_RATIO = 0.25

function keyOf(slide: PresentSlide, index: number) {
  return JSON.stringify([slide.content, slide.frontmatter, index === 0, props.headmatter])
}

const pictures = shallowReactive(new Map<string, string>())
/** Slides whose picture is done, or could not be drawn, by id. The others say a picture is coming. */
const settled = shallowReactive(new Set<string>())
const drawer = useFrameRenderer('overview', inject(MEDIA_DECK_KEY, () => () => undefined, true))
const { frame: thumbnailFrame, request: thumbnailRequest } = drawer
const drawing = ref(true)
let stopped = false

/** Tiles in view, by index. */
const inView = new Set<number>()
/** Slides drawn or tried, by index. */
const tried = new Set<number>()

/** The next slide to draw: a tile in view, closest to the slide on screen, else the next one after it. */
function nextToDraw(): number | undefined {
  const count = props.slides.length
  const left = props.slides.map((_, index) => index).filter(index => !tried.has(index))
  const after = (index: number) => (index - props.current + count) % count
  const seen = left.filter(index => inView.has(index))
  if (seen.length)
    return seen.reduce((best, index) => Math.abs(index - props.current) < Math.abs(best - props.current) ? index : best)
  return left.sort((a, b) => after(a) - after(b))[0]
}

async function drawAll() {
  for (let index = nextToDraw(); index !== undefined && !stopped; index = nextToDraw()) {
    tried.add(index)
    const slide = props.slides[index]
    const key = keyOf(slide, index)
    const known = props.cache.get(key)
    if (known) {
      pictures.set(slide.id, known)
      settled.add(slide.id)
      continue
    }
    try {
      const total = await drawer.render({
        slide: { content: slide.content, frontmatter: slide.frontmatter, first: index === 0 },
        headmatter: props.headmatter,
        clicks: LAST_CLICKS,
        mode: 'print',
      })
      emit('clicks', slide, total)
      const captured = await drawer.capture(THUMBNAIL_RATIO)
      if (stopped || !captured.png)
        continue
      const url = URL.createObjectURL(new Blob([captured.png], { type: 'image/png' }))
      props.cache.set(key, url)
      pictures.set(slide.id, url)
    }
    catch {
      // A slide that cannot be drawn shows its title only.
    }
    settled.add(slide.id)
  }
  drawing.value = false
}

const grid = ref<HTMLElement>()
let watching: IntersectionObserver | undefined

onMounted(() => {
  if (typeof IntersectionObserver === 'function' && grid.value) {
    watching = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const index = Number((entry.target as HTMLElement).dataset.overviewSlide) - 1
        if (entry.isIntersecting)
          inView.add(index)
        else
          inView.delete(index)
      }
    })
    for (const tile of grid.value.querySelectorAll('[data-overview-slide]'))
      watching.observe(tile)
  }
  void drawAll()
  grid.value?.querySelector<HTMLElement>('[aria-current="true"]')?.focus()
})
onBeforeUnmount(() => {
  stopped = true
  watching?.disconnect()
  drawer.stop()
})
</script>

<template>
  <div class="absolute inset-0 overflow-y-auto bg-black p-4" role="dialog" aria-label="All slides" data-testid="present-overview-grid" @click.self="emit('close')">
    <div class="mb-3 flex items-center justify-between gap-2">
      <h2 class="m-0 text-base font-medium text-slate-300">
        All slides
      </h2>
      <button class="dey-btn text-sm" data-testid="overview-close" @click="emit('close')">
        Close
      </button>
    </div>
    <ul ref="grid" class="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-3 p-0">
      <li v-for="(slide, index) in slides" :key="slide.id">
        <button
          class="block w-full rounded-md border-2 bg-slate-900 p-1 text-left hover:border-dey-accent focus:border-dey-accent focus:outline-none"
          :class="index === current ? 'border-dey-accent' : 'border-slate-700'"
          :aria-current="index === current"
          :data-overview-slide="index + 1"
          @click="emit('pick', index)"
        >
          <span class="block aspect-video overflow-hidden rounded bg-slate-950">
            <img v-if="pictures.get(slide.id)" :src="pictures.get(slide.id)" alt="" class="block h-full w-full object-cover">
            <!-- A picture takes a second or more, so a tile still waiting says so rather than look empty. -->
            <span v-else-if="drawing && !settled.has(slide.id)" class="grid h-full animate-pulse place-items-center text-xs text-slate-500" data-overview-waiting>
              Drawing...
            </span>
          </span>
          <span class="mt-1 flex gap-2 px-1 text-sm">
            <span class="text-slate-400 tabular-nums">{{ index + 1 }}</span>
            <span class="truncate">{{ slide.title || `Slide ${index + 1}` }}</span>
          </span>
        </button>
      </li>
    </ul>
    <SlidePreviewFrame
      v-if="drawing"
      ref="thumbnailFrame"
      :request="thumbnailRequest"
      class="pointer-events-none fixed left-0 top-0 -z-10 w-160 opacity-0"
      aria-hidden="true"
      data-testid="overview-frame"
      @rendered="drawer.onRendered"
      @error="drawer.onError"
    />
  </div>
</template>
