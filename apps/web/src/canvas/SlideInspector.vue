<script setup lang="ts">
import type { DeckSession } from '../deck/session'
import { elementText, findSlide, makeMovable, setFrontmatter, slideFrontmatter } from '@deyslide/deck-model'
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import * as Y from 'yjs'
import { LOCAL_ORIGIN } from '../deck/session'
import { TRANSITIONS } from '../preview/transitions'
import InlineTextEditor from './InlineTextEditor.vue'
import { commitReading, fieldText, inspectorChange, movableProblem, previewLayouts, readBackground, readNumber, readText } from './inspector'
import InspectorField from './InspectorField.vue'

/**
 * The slide's own settings, shown while nothing is selected: its layout,
 * class, background, transition and clicks; its Markdown blocks, to edit
 * or to make movable; and the speaker notes, edited live
 * with everyone else.
 */
const props = defineProps<{
  session: DeckSession
  slideId: string
  /** The deck's first slide, which Slidev lays out as a cover unless it says otherwise. */
  first: boolean
  locked: boolean
}>()
const emit = defineEmits<{ 'update:selection': [ids: string[]] }>()

/** Where a block made movable goes: inside the default layout's padding, as wide as it. */
const MOVABLE_PLACE = { x: 56, y: 40, w: 868, h: null, rotate: 0 }

const readonly = computed(() => props.locked || props.session.readOnly.value)
const problem = ref('')

interface RawBlock {
  id: string
  markdown: string
}

const frontmatter = shallowRef<Record<string, unknown>>({})
const blocks = shallowRef<RawBlock[]>([])
const notes = shallowRef<Y.Text>()
/** The Markdown block open in its editor, and its text. */
const editing = shallowRef<{ id: string, text: Y.Text }>()

function slideMap() {
  return findSlide(props.session.doc, props.slideId)
}

function readFrontmatter(): Record<string, unknown> {
  const map = slideMap()
  return map ? slideFrontmatter(map) : {}
}

watch(() => [props.session, props.slideId] as const, ([session], _, onCleanup) => {
  const read = () => {
    const map = slideMap()
    frontmatter.value = readFrontmatter()
    const elements = map?.get('elements')
    blocks.value = elements instanceof Y.Array
      ? elements.toArray().flatMap(element => element instanceof Y.Map && element.get('type') === 'raw' && typeof element.get('id') === 'string'
        ? [{ id: element.get('id') as string, markdown: String(element.get('markdown') ?? '') }]
        : [])
      : []
    const text = map?.get('notes')
    notes.value = text instanceof Y.Text ? text : undefined
    followEditedBlock()
  }
  read()
  session.doc.on('update', read)
  onCleanup(() => session.doc.off('update', read))
}, { immediate: true })

// Settings ---------------------------------------------------------------------------------

const layouts = ref<string[]>([])
onMounted(async () => {
  // Without the list (the chunk did not load), the menu offers the slide's own layout and the default.
  layouts.value = await previewLayouts().catch(() => [])
})

const layout = computed(() => typeof frontmatter.value.layout === 'string' ? frontmatter.value.layout : '')
/** The preview's layouts, and the slide's own when it names one the preview does not have. */
const layoutChoices = computed(() => layout.value && !layouts.value.includes(layout.value) ? [...layouts.value, layout.value] : layouts.value)

const transition = computed(() => typeof frontmatter.value.transition === 'string' ? frontmatter.value.transition : '')
const transitionChoices = computed(() => {
  const known: string[] = [...TRANSITIONS, 'none']
  return transition.value && !known.includes(transition.value) ? [...known, transition.value] : known
})

/** Sets one frontmatter key, or removes it for undefined. The rest of the frontmatter stays. */
function setSetting(key: string, value: unknown) {
  return inspectorChange(props.session, props.locked, (doc) => {
    const next = { ...readFrontmatter() }
    if (value === undefined)
      delete next[key]
    else
      next[key] = value
    setFrontmatter(doc, props.slideId, next, LOCAL_ORIGIN)
  })
}

function choose(key: string, value: string) {
  problem.value = setSetting(key, value || undefined) ?? ''
}

function commitText(key: string) {
  return (text: string) => commitReading(readText(text), value => setSetting(key, value))
}

const commitBackground = (text: string) => commitReading(readBackground(text), value => setSetting('background', value))

const commitClicks = (text: string) => commitReading(readNumber(text, { min: 0, whole: true, optional: true }), value => setSetting('clicks', value))

// Markdown blocks ------------------------------------------------------------------------------

function summary(markdown: string) {
  const line = markdown.split('\n').map(part => part.trim()).find(Boolean) ?? ''
  return line.length > 60 ? `${line.slice(0, 59)}...` : line || 'Empty block'
}

function edit(id: string) {
  if (editing.value?.id === id) {
    editing.value = undefined
    return
  }
  try {
    editing.value = { id, text: elementText(props.session.doc, props.slideId, id) }
  }
  catch {
    editing.value = undefined
  }
}

/**
 * A block someone removed, or made movable, is no longer edited here. A
 * block whose text is new (someone moved the slide, which copies it) is
 * edited in its new text, so typing never goes to a text the deck dropped.
 */
function followEditedBlock() {
  const current = editing.value
  if (!current)
    return
  let text: Y.Text | undefined
  try {
    text = blocks.value.some(block => block.id === current.id) ? elementText(props.session.doc, props.slideId, current.id) : undefined
  }
  catch {
    text = undefined
  }
  if (text !== current.text)
    editing.value = text && { id: current.id, text }
}

watch(() => props.slideId, () => {
  editing.value = undefined
  problem.value = ''
})

function movable(id: string) {
  const refused = movableProblem(blocks.value.find(block => block.id === id)?.markdown ?? '')
  if (refused) {
    problem.value = refused
    return
  }
  let made: string | undefined
  const result = inspectorChange(props.session, props.locked, (doc) => {
    made = makeMovable(doc, props.slideId, id, MOVABLE_PLACE, LOCAL_ORIGIN)
  })
  problem.value = result ?? ''
  if (made)
    emit('update:selection', [made])
}

// Speaker notes ------------------------------------------------------------------------------------

function leaveNotes() {
  (document.activeElement as HTMLElement | null)?.blur()
}
</script>

<template>
  <div class="flex flex-col gap-4" data-testid="slide-inspector">
    <h3 class="m-0 text-sm font-semibold lt-md:hidden" data-testid="inspector-title">
      Slide
    </h3>

    <section class="grid grid-cols-2 gap-2" aria-label="Slide settings">
      <label class="flex min-w-0 flex-col gap-1 text-xs text-dey-muted">
        Layout
        <select class="dey-input py-1 text-sm" :value="layout" :disabled="readonly" data-testid="field-layout" @change="choose('layout', ($event.target as HTMLSelectElement).value)">
          <option value="">
            {{ first ? 'Automatic (cover)' : 'Automatic (default)' }}
          </option>
          <option v-for="name in layoutChoices" :key="name" :value="name">
            {{ name }}
          </option>
        </select>
      </label>
      <label class="flex min-w-0 flex-col gap-1 text-xs text-dey-muted">
        Transition
        <select class="dey-input py-1 text-sm" :value="transition" :disabled="readonly" data-testid="field-transition" @change="choose('transition', ($event.target as HTMLSelectElement).value)">
          <option value="">
            The deck's
          </option>
          <option v-for="name in transitionChoices" :key="name" :value="name">
            {{ name }}
          </option>
        </select>
      </label>
      <InspectorField name="class" label="Class" :value="fieldText(frontmatter.class)" placeholder="None" :readonly="readonly" :commit="commitText('class')" />
      <InspectorField name="clicks" label="Clicks" inputmode="numeric" :value="fieldText(frontmatter.clicks)" placeholder="Auto" :readonly="readonly" :commit="commitClicks" />
      <InspectorField class="col-span-2" name="background" label="Background (a color or an image link)" :value="fieldText(frontmatter.background)" :readonly="readonly" :commit="commitBackground" />
    </section>

    <section v-if="blocks.length" class="flex flex-col gap-2" aria-label="Markdown blocks">
      <span class="text-xs text-dey-muted">Markdown on the slide</span>
      <div v-for="block in blocks" :key="block.id" class="flex flex-col gap-2 rounded-md border border-dey-line p-2" :data-element="block.id" data-testid="raw-block">
        <code class="truncate text-xs" data-testid="raw-summary">{{ summary(block.markdown) }}</code>
        <div v-if="!readonly" class="flex flex-wrap gap-1">
          <button type="button" class="dey-btn text-xs" :aria-expanded="editing?.id === block.id" data-testid="edit-raw" @click="edit(block.id)">
            {{ editing?.id === block.id ? 'Done' : 'Edit' }}
          </button>
          <button type="button" class="dey-btn text-xs" data-testid="make-movable" @click="movable(block.id)">
            Make movable
          </button>
        </div>
        <InlineTextEditor
          v-if="editing?.id === block.id"
          class="h-40"
          :text="editing.text"
          :session="session"
          :font-size="13"
          label="Markdown block"
          look="field"
          :readonly="readonly"
          data-testid="raw-editor"
          @close="editing = undefined"
        />
      </div>
    </section>

    <section class="flex flex-col gap-1" aria-label="Speaker notes">
      <span class="text-xs text-dey-muted">Speaker notes</span>
      <InlineTextEditor
        v-if="notes"
        class="h-32"
        :text="notes"
        :session="session"
        :font-size="13"
        label="Speaker notes"
        look="field"
        :autofocus="false"
        :readonly="readonly"
        data-testid="notes-editor"
        @close="leaveNotes"
      />
    </section>

    <p v-if="problem" class="m-0 text-xs text-rose-300" role="alert" data-testid="inspector-problem">
      {{ problem }}
    </p>
  </div>
</template>
