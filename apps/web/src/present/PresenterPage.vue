<script setup lang="ts">
import { deckMarkdown } from '@deyslide/deck-model'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import SlidePreviewFrame from '../editor/SlidePreviewFrame.vue'
import { keyTarget } from '../preview/input'
import ExportMenu from './ExportMenu.vue'
import { keyAction, keyBelongsTo, next as nextStep } from './navigation'
import { currentPart, noteParts } from './notes'
import { usePresentation } from './presentation'

/**
 * The presenter's view: the slide on screen, the step that comes next,
 * the speaker notes, a timer and the clock. It opens the audience window
 * and keeps it in step; either window can move the talk.
 */
const props = defineProps<{ projectId: string, deckId: string }>()

const router = useRouter()
const talk = usePresentation(props)
const { summary, problem, ready, slides, slide, index, clicks, totalClicks, request, deck, position } = talk

// Notes are Markdown, split at Slidev's [click] markers: the part for the click on screen stands out.
const notes = computed(() => noteParts(slide.value?.notes ?? ''))
const notesNow = computed(() => currentPart(notes.value, clicks.value))

/** The step after the one on screen, for the second preview, or undefined at the end. */
const upcoming = computed(() => {
  if (slides.value.length === 0)
    return undefined
  const after = nextStep(deck.value, position.value)
  return after.slide === position.value.slide && after.clicks === position.value.clicks ? undefined : after
})
const upcomingRequest = talk.requestOf(() => upcoming.value)

/** The slide and click counters, once the deck is here. Slides without clicks show no click counter, as in the audience view. */
const slideCounter = computed(() => slides.value.length ? `Slide ${index.value + 1} of ${slides.value.length}` : '')
const clickCounter = computed(() => totalClicks.value ? `Click ${Math.min(clicks.value, totalClicks.value)} of ${totalClicks.value}` : '')
const upcomingLabel = computed(() => {
  const at = upcoming.value
  if (!at)
    return ''
  return at.slide === position.value.slide ? `Click ${at.clicks} of slide ${at.slide + 1}` : `Slide ${at.slide + 1}`
})

// Timer and clock --------------------------------------------------------------

const now = ref(Date.now())
const started = ref(Date.now())
const ticker = setInterval(() => {
  now.value = Date.now()
}, 1000)

function twoDigits(value: number) {
  return String(value).padStart(2, '0')
}

const elapsed = computed(() => {
  const seconds = Math.max(0, Math.floor((now.value - started.value) / 1000))
  const hours = Math.floor(seconds / 3600)
  const rest = `${twoDigits(Math.floor(seconds / 60) % 60)}:${twoDigits(seconds % 60)}`
  return hours > 0 ? `${hours}:${rest}` : rest
})
const clock = computed(() => new Date(now.value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))

function resetTimer() {
  started.value = Date.now()
  now.value = started.value
}

// The audience window ------------------------------------------------------------

const audienceMessage = ref('')
const canOpenAudience = computed(() => talk.channel()?.canOpenAudience ?? false)

/** Where the talk is, for the address of the audience view and the editor: the slide counted from 1. */
const slideQuery = computed(() => ({ slide: String(index.value + 1) }))

async function openAudience() {
  const channel = talk.channel()
  if (!channel)
    return
  const url = router.resolve({ name: 'present', params: { projectId: props.projectId, deckId: props.deckId }, query: slideQuery.value }).href
  const opened = await channel.openAudience({ projectId: props.projectId, deckId: props.deckId, url })
  audienceMessage.value = opened ? '' : 'The audience window did not open. The browser may have blocked it: press Open audience window.'
}

// Once the deck is here, the audience window opens beside this one, once, on the slide this view starts on.
let audienceOpened = false
watch(() => ready.value && slides.value.length > 0, (isReady) => {
  if (!isReady || !canOpenAudience.value || audienceOpened)
    return
  audienceOpened = true
  void openAudience()
  // After the talk has placed itself on its first slide.
}, { immediate: true, flush: 'post' })

function onKey(event: KeyboardEvent) {
  // Typing belongs to the field, Enter or Space to a focused control, and every key to the open Export menu.
  if (keyBelongsTo(keyTarget(event.target), event.key) || (event.target instanceof Element && event.target.closest('[role="menu"]')))
    return
  const action = keyAction(event)
  if (action === 'next')
    talk.next()
  else if (action === 'previous')
    talk.previous()
  else if (action === 'first')
    talk.first()
  else if (action === 'last')
    talk.last()
  else if (action === 'escape')
    void router.push({ name: 'deck', params: { projectId: props.projectId, deckId: props.deckId }, query: slideQuery.value })
  else
    return
  event.preventDefault()
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  clearInterval(ticker)
})

/** The deck's Markdown, for exporting a deck that lives on this device. */
function markdown() {
  const current = talk.session.value
  return current ? deckMarkdown(current.doc) : ''
}
</script>

<template>
  <div class="min-h-dvh bg-dey-bg p-3 text-dey-text md:p-4" data-testid="presenter-page">
    <template v-if="summary">
      <!--
        Two groups, so a phone shows them as two rows at most: where the
        talk is, then the timer, the clock and the actions. A click on a
        button here never leaves it the focus, so Space and Enter keep
        moving the talk; a button reached with Tab still takes them.
      -->
      <header class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div class="flex min-w-0 items-center gap-x-3">
          <RouterLink :to="{ name: 'deck', params: { projectId, deckId }, query: slideQuery }" class="truncate font-semibold hover:text-dey-accent" data-testid="presenter-back">
            ‹ {{ summary.name }}
          </RouterLink>
          <span v-if="slideCounter" class="shrink-0 text-sm" data-testid="presenter-slide">{{ slideCounter }}</span>
          <span v-if="clickCounter" class="shrink-0 text-sm text-dey-muted" data-testid="presenter-click">{{ clickCounter }}</span>
        </div>
        <div class="ml-auto flex flex-wrap items-center gap-x-2 gap-y-1 sm:gap-x-3">
          <span class="font-mono text-lg tabular-nums" aria-label="Time since the start" data-testid="presenter-timer">{{ elapsed }}</span>
          <button class="dey-btn text-sm" data-testid="presenter-reset" @mousedown.prevent @click="resetTimer">
            Reset
          </button>
          <span class="font-mono text-lg tabular-nums text-dey-muted" aria-label="Time now" data-testid="presenter-clock">{{ clock }}</span>
          <button v-if="canOpenAudience" class="dey-btn text-sm" data-testid="open-audience" @mousedown.prevent @click="openAudience">
            Open audience window
          </button>
          <RouterLink v-else :to="{ name: 'present', params: { projectId, deckId }, query: slideQuery }" class="dey-btn text-sm" data-testid="audience-view">
            Audience view
          </RouterLink>
          <ExportMenu :deck-id="deckId" :deck-name="summary.name" :slides="slides" :markdown="markdown" :disabled="!ready" />
        </div>
      </header>
      <p v-if="audienceMessage" class="m-0 mt-2 text-sm text-amber-300" role="status" data-testid="audience-message">
        {{ audienceMessage }}
      </p>

      <p v-if="problem" class="m-0 mt-4 text-rose-300" role="alert" data-testid="presenter-problem">
        {{ problem }}
      </p>
      <p v-else-if="!ready || slides.length === 0" class="m-0 mt-4 text-dey-muted">
        Opening the deck...
      </p>
      <!--
        Wide screens: the slide on the left, the next step and the notes on
        the right. Narrow ones: the slide, then the notes, which the
        presenter reads most, then a small picture of the next step.
      -->
      <div v-else class="mt-3 grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:grid-rows-[auto_minmax(0,1fr)]">
        <section class="flex min-w-0 flex-col gap-2 lg:col-start-1 lg:row-span-2 lg:row-start-1" aria-label="On screen" data-testid="presenter-current">
          <!-- The slides here only show what the audience sees: a click on them never takes the keys away from this page. -->
          <SlidePreviewFrame :request="request" class="pointer-events-none" tabindex="-1" @rendered="talk.onRendered" @error="talk.onError(request?.id, $event)" />
          <div class="flex gap-2">
            <button class="dey-btn flex-1" :disabled="index === 0 && clicks === 0" data-testid="presenter-previous" @mousedown.prevent @click="talk.previous()">
              ‹ Previous
            </button>
            <button class="dey-btn-primary flex-1" :disabled="!upcoming" data-testid="presenter-next-step" @mousedown.prevent @click="talk.next()">
              Next ›
            </button>
          </div>
        </section>
        <section class="flex min-h-0 min-w-0 flex-col gap-1 lg:col-start-2 lg:row-start-2" aria-label="Speaker notes">
          <h2 class="m-0 text-sm font-medium text-dey-muted">
            Notes
          </h2>
          <!-- Markdown with HTML off, so the notes show as text and run nothing. -->
          <div v-if="notes.length" class="flex max-h-[50dvh] flex-col gap-3 overflow-y-auto rounded-md bg-slate-900 p-3 text-lg leading-relaxed" data-testid="presenter-notes">
            <div
              v-for="(part, at) in notes"
              :key="at"
              class="[&_a]:text-dey-accent [&_a]:underline [&_li]:ml-5 [&_li]:list-disc [&_p+p]:mt-3"
              :class="part === notesNow ? '' : 'opacity-50'"
              :data-note-clicks="part.clicks"
              :aria-current="part === notesNow"
              v-html="part.html"
            />
          </div>
          <p v-else class="m-0 rounded-md bg-slate-900 p-3 text-dey-muted" data-testid="presenter-notes">
            No notes for this slide.
          </p>
        </section>
        <section class="flex min-w-0 flex-row items-start gap-3 lg:col-start-2 lg:row-start-1 lg:flex-col lg:gap-1" aria-label="Next" data-testid="presenter-next">
          <h2 class="m-0 min-w-0 flex-1 text-sm font-medium text-dey-muted lg:flex-none">
            Next: {{ upcomingLabel || 'the end' }}
          </h2>
          <div class="w-36 shrink-0 sm:w-56 lg:w-full">
            <SlidePreviewFrame v-if="upcomingRequest" :request="upcomingRequest" class="pointer-events-none" tabindex="-1" @rendered="talk.onRendered" @error="talk.onError(upcomingRequest?.id, $event)" />
            <p v-else class="m-0 grid aspect-video place-items-center rounded-md border border-dey-line text-sm text-dey-muted" data-testid="presenter-end">
              End of the deck
            </p>
          </div>
        </section>
      </div>
    </template>

    <section v-else class="dey-panel mx-auto mt-8 max-w-md text-center" data-testid="missing-deck">
      <p class="m-0">
        This deck is not here.
      </p>
      <RouterLink to="/" class="mt-3 inline-block text-dey-accent">
        Back to your projects
      </RouterLink>
    </section>
  </div>
</template>
