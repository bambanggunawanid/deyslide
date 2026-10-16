<script setup lang="ts">
import type { DeckElement, PositionedElement } from '@deyslide/deck-model'
import type { DeckSession } from '../deck/session'
import type { ProjectMedia } from '../projects/media'
import { deleteElement, ElementSchema, findSlide } from '@deyslide/deck-model'
import { computed, nextTick, ref, shallowRef, watch } from 'vue'
import * as Y from 'yjs'
import { plural } from '../format'
import { LOCAL_ORIGIN } from '../deck/session'
import ElementInspector from './ElementInspector.vue'
import { elementLabel, holdsPositioned, inspectorChange } from './inspector'
import { useMediaQuery } from './media-query'
import SlideInspector from './SlideInspector.vue'

/**
 * Settings for what the canvas has selected, or for the slide when nothing
 * is. It sits beside the slide on wide screens and is a sheet at the bottom
 * of phones, opened from its bar. View only decks, and decks the assistant
 * is changing, show it read only.
 */
const props = defineProps<{
  session: DeckSession
  slideId: string
  /** The slide is the deck's first. */
  first: boolean
  selection: string[]
  /** View only, or the assistant is at work. Read only sessions are locked too. */
  locked: boolean
  media?: ProjectMedia
}>()
const emit = defineEmits<{ 'update:selection': [ids: string[]] }>()

const phone = useMediaQuery('(max-width: 767px)')
/** The sheet is open, on phones. */
const open = ref(false)
const panel = ref<HTMLElement>()

const elements = shallowRef<DeckElement[]>([])

watch(() => [props.session, props.slideId] as const, ([session, slideId], _, onCleanup) => {
  const read = () => {
    const list = findSlide(session.doc, slideId)?.get('elements')
    elements.value = list instanceof Y.Array
      ? list.toArray().flatMap((value) => {
          const parsed = value instanceof Y.Map ? ElementSchema.safeParse(value.toJSON()) : undefined
          return parsed?.success ? [parsed.data] : []
        })
      : []
  }
  read()
  session.doc.on('update', read)
  onCleanup(() => session.doc.off('update', read))
}, { immediate: true })

const order = computed(() => elements.value.map(element => element.id))
/** What takes part in the paint order: movable elements, and Markdown laid over the slide. */
const stack = computed(() => elements.value.filter(element => element.type !== 'raw' || holdsPositioned(element.markdown)).map(element => element.id))
const selected = computed(() => props.selection.length === 1
  ? elements.value.find((element): element is PositionedElement => element.id === props.selection[0] && element.type !== 'raw')
  : undefined)
const locked = computed(() => props.locked || props.session.readOnly.value)

const title = computed(() => {
  if (selected.value)
    return elementLabel(selected.value)
  if (props.selection.length > 1)
    return `${plural(props.selection.length, 'element')} selected`
  return 'Slide'
})

const problem = ref('')

function removeAll() {
  const ids = props.selection
  const result = inspectorChange(props.session, props.locked, (doc) => {
    for (const id of ids) {
      try {
        deleteElement(doc, props.slideId, id, LOCAL_ORIGIN)
      }
      catch {
        // Someone removed it already.
      }
    }
  })
  problem.value = result ?? ''
  if (!result)
    emit('update:selection', [])
}

watch(() => props.selection, () => {
  problem.value = ''
})

/**
 * The sheet covers the bottom of a phone's screen: the slide goes to the
 * top, where it stays in sight. After the page has made room for the sheet.
 */
watch(open, (isOpen) => {
  if (isOpen && phone.value)
    document.querySelector('[data-testid="slide-stage"]')?.scrollIntoView?.({ block: 'start' })
}, { flush: 'post' })

/** Shows the inspector, opening the sheet on phones, and moves the focus into it. */
async function reveal() {
  open.value = true
  await nextTick()
  // A phone would bring up its keyboard for a field: the sheet itself takes the focus there.
  if (phone.value) {
    panel.value?.focus({ preventScroll: true })
    return
  }
  panel.value?.scrollIntoView?.({ block: 'nearest' })
  panel.value?.querySelector<HTMLElement>('input:not([readonly]), select:not([disabled]), textarea:not([readonly]), button')?.focus({ preventScroll: true })
}

defineExpose({ reveal })
</script>

<template>
  <div class="min-w-0">
    <aside
      :class="phone
        ? 'fixed inset-x-0 bottom-0 z-30 flex max-h-[55dvh] flex-col rounded-t-xl border-t border-dey-line bg-slate-900 shadow-2xl shadow-black/60'
        : 'dey-panel flex max-h-[75dvh] flex-col'"
      aria-label="Inspector"
      data-testid="inspector"
      :data-sheet="phone ? (open ? 'open' : 'closed') : undefined"
      :data-locked="locked || undefined"
    >
      <button
        v-if="phone"
        type="button"
        class="flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-sm font-semibold"
        :aria-expanded="open"
        data-testid="inspector-toggle"
        @click="open = !open"
      >
        <span>{{ title }}</span>
        <span class="text-dey-muted" aria-hidden="true">{{ open ? 'Close' : 'Settings' }}</span>
      </button>
      <div v-show="!phone || open" ref="panel" class="min-h-0 overflow-y-auto outline-none" tabindex="-1" :class="phone && 'px-4 pb-4'" data-testid="inspector-panel">
        <ElementInspector
          v-if="selected"
          :key="selected.id"
          :session="session"
          :slide-id="slideId"
          :element="selected"
          :order="order"
          :stack="stack"
          :locked="locked"
          :media="media"
          @update:selection="emit('update:selection', $event)"
        />
        <div v-else-if="selection.length > 1" class="flex flex-col gap-3" data-testid="many-selected">
          <h3 class="m-0 text-sm font-semibold lt-md:hidden" data-testid="inspector-title">
            {{ title }}
          </h3>
          <p class="m-0 text-xs text-dey-muted">
            Drag them on the slide to move them together, or select one to change it.
          </p>
          <button v-if="!locked" type="button" class="dey-btn self-start text-xs text-rose-300" data-testid="delete-elements" @click="removeAll">
            Delete them from the slide
          </button>
          <p v-if="problem" class="m-0 text-xs text-rose-300" role="alert" data-testid="inspector-problem">
            {{ problem }}
          </p>
        </div>
        <SlideInspector
          v-else
          :key="slideId"
          :session="session"
          :slide-id="slideId"
          :first="first"
          :locked="locked"
          @update:selection="emit('update:selection', $event)"
        />
      </div>
    </aside>
    <!-- Room at the very end of the page, as tall as the sheet, so it covers nothing the page cannot scroll past. -->
    <Teleport to="body">
      <div v-if="phone" :class="open ? 'h-[55dvh]' : 'h-14'" aria-hidden="true" data-testid="inspector-room" />
    </Teleport>
  </div>
</template>
