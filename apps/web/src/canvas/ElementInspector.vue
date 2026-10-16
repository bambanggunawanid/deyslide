<script setup lang="ts">
import type { CodeStep, ElementPatch, Position, PositionedElement } from '@deyslide/deck-model'
import type { DeckSession } from '../deck/session'
import type { MediaFile, ProjectMedia } from '../projects/media'
import type { Reading, RowKeys } from './inspector'
import { deleteElement, moveElementInStack, updateElement } from '@deyslide/deck-model'
import { computed, ref } from 'vue'
import { LOCAL_ORIGIN } from '../deck/session'
import { mediaAddress } from '../platform/media'
import { describeFile } from './elements'
import { MIN_SIZE } from './geometry'
import {
  commitReading,
  elementLabel,
  fieldText,
  followRows,
  inspectorChange,
  placeProblem,
  readColor,
  readLink,
  readNumber,
  readOptionalLink,
  readText,
  readVector,
  ROW_GONE,
  withProps,
} from './inspector'
import InspectorField from './InspectorField.vue'
import MediaPicker from './MediaPicker.vue'

/**
 * The selected element's settings: where it is, what it shows, where it
 * sits among the slide's other elements, and Delete. Each value is checked
 * before it reaches the deck, and goes in as its own undo step.
 */
const props = defineProps<{
  session: DeckSession
  slideId: string
  element: PositionedElement
  /** Ids of the slide's elements in their order on the slide, Markdown blocks included. */
  order: string[]
  /** The ids among them that take part in the paint order: movable elements, and Markdown laid over the slide. */
  stack: string[]
  locked: boolean
  /** The project's media library, when there is one to pick from. */
  media?: ProjectMedia
}>()
const emit = defineEmits<{ 'update:selection': [ids: string[]] }>()

const readonly = computed(() => props.locked || props.session.readOnly.value)
/** A reason a switch, a list or a button could not change the deck. */
const problem = ref('')

function change(fn: Parameters<typeof inspectorChange>[2]) {
  return inspectorChange(props.session, props.locked, fn)
}

function update(patch: ElementPatch) {
  return change(doc => updateElement(doc, props.slideId, props.element.id, patch, LOCAL_ORIGIN))
}

/** Changes some of the element's props; a key set to undefined goes back to its default. */
function setProps(patch: Record<string, unknown>) {
  if (!('props' in props.element))
    return undefined
  return update({ props: withProps(props.element.props, patch) })
}

/** For switches, lists and buttons, whose problems show under the section. */
function act(result: string | undefined) {
  problem.value = result ?? ''
}

// Where it is -------------------------------------------------------------------------

/** Text and code may grow with their content; other elements need a height. */
const autoHeight = computed(() => props.element.type === 'text' || props.element.type === 'code')

const POSITION_FIELDS: { field: keyof Position, label: string }[] = [
  { field: 'x', label: 'X' },
  { field: 'y', label: 'Y' },
  { field: 'w', label: 'Width' },
  { field: 'h', label: 'Height' },
  { field: 'rotate', label: 'Turn (degrees)' },
]

// The same limits as on the canvas: no box below MIN_SIZE, and part of it on the slide.
function readPosition(field: keyof Position, text: string): Reading<number | null> {
  if (field === 'w')
    return readNumber(text, { min: MIN_SIZE }) as Reading<number>
  if (field === 'h') {
    const reading = readNumber(text, { min: MIN_SIZE, optional: autoHeight.value })
    return 'value' in reading ? { value: reading.value ?? null } : reading
  }
  return readNumber(text) as Reading<number>
}

function commitPosition(field: keyof Position) {
  return (text: string) => commitReading(readPosition(field, text), (value) => {
    const next = { ...props.element.pos, [field]: value }
    return placeProblem(props.element, next) ?? update({ pos: { [field]: value } })
  })
}

/** A prop field: read its text, then write the value, or the default for nothing. */
function commitProp<T>(key: string, read: (text: string) => Reading<T>) {
  return (text: string) => commitReading(read(text), value => setProps({ [key]: value }))
}

const shapeProps = computed(() => props.element.type === 'shape' ? props.element.props : undefined)

/** The color picker needs six hex digits. Other colors show the default in it. */
function pickerColor(value: string | undefined, fallback: string) {
  return value && /^#[\da-f]{6}$/i.test(value) ? value : fallback
}

// Images ------------------------------------------------------------------------------

const choosing = ref(false)

/** Another picture takes the description of its own file: the old one described the picture it replaces. */
function pickImage(file: MediaFile) {
  if (props.element.type !== 'image')
    return
  const src = mediaAddress(file.id)
  act(update(src === props.element.src ? { src } : { src, alt: describeFile(file.name) }))
  choosing.value = false
}

// Code and its Magic Move steps -----------------------------------------------------

const MAGIC_MOVE_FENCE = /^```/m

function steps(): CodeStep[] {
  return props.element.type === 'code' ? props.element.steps : []
}

/**
 * Rows of a list others may change while this person types in it: steps,
 * starting values. Each row has a key that follows it, so fields stay with
 * their row and a change goes to the row it was typed for.
 */
function rowKeys(rows: () => string[]) {
  let known: RowKeys = { keys: [], rows: [] }
  return computed(() => {
    known = followRows(known, rows())
    return known.keys
  })
}

const stepKeys = rowKeys(() => steps().map(step => JSON.stringify([step.lang, step.code])))

function checkSteps(next: CodeStep[]): string | undefined {
  if (next.some(step => !/^[^\s`]*$/.test(step.lang)))
    return 'A language name has no spaces or backticks.'
  if (next.length > 1 && next.some(step => MAGIC_MOVE_FENCE.test(step.code)))
    return 'A Magic Move step cannot have a line that starts with ```.'
  return undefined
}

function writeSteps(next: CodeStep[]) {
  return checkSteps(next) ?? update({ steps: next })
}

function commitStep(row: string, key: keyof CodeStep) {
  return (text: string) => {
    const index = stepKeys.value.indexOf(row)
    if (index === -1)
      return ROW_GONE
    return writeSteps(steps().map((step, at) => at === index ? { ...step, [key]: key === 'lang' ? text.trim() : text } : step))
  }
}

/** A new step starts as a copy of the last one, ready to change: Magic Move morphs from one to the next. */
function addStep() {
  const list = steps()
  act(writeSteps([...list, { ...list[list.length - 1] }]))
}

function removeStep(row: string) {
  const index = stepKeys.value.indexOf(row)
  act(index === -1 ? ROW_GONE : writeSteps(steps().filter((_, at) => at !== index)))
}

// Live sandbox values -----------------------------------------------------------------

type ValueKind = 'text' | 'number' | 'switch'
const KINDS: { kind: ValueKind, label: string }[] = [
  { kind: 'text', label: 'Text' },
  { kind: 'number', label: 'Number' },
  { kind: 'switch', label: 'Switch' },
]

const kindOf = (value: unknown): ValueKind => typeof value === 'boolean' ? 'switch' : typeof value === 'number' ? 'number' : 'text'

const sandboxValues = computed(() => props.element.type === 'sandbox' ? Object.entries(props.element.props.initial) : [])
const valueKeys = rowKeys(() => sandboxValues.value.map(([name]) => name))

/** Where a row of starting values is now, or -1 when someone removed it. */
const valueAt = (row: string) => valueKeys.value.indexOf(row)

function writeValues(entries: [string, string | number | boolean][]) {
  return setProps({ initial: Object.fromEntries(entries) })
}

function commitKey(row: string) {
  return (text: string) => {
    const index = valueAt(row)
    if (index === -1)
      return ROW_GONE
    const key = text.trim()
    if (!key)
      return 'Give the value a name.'
    // A record cannot hold this name: the value would vanish.
    if (key === '__proto__')
      return 'Choose another name.'
    if (sandboxValues.value.some(([other], at) => at !== index && other === key))
      return 'Another value has that name.'
    return writeValues(sandboxValues.value.map(([name, value], at) => [at === index ? key : name, value]))
  }
}

function commitValue(row: string) {
  return (text: string) => {
    const index = valueAt(row)
    if (index === -1)
      return ROW_GONE
    const [, current] = sandboxValues.value[index]
    let value: string | number = text
    if (typeof current === 'number') {
      const reading = readNumber(text)
      if ('problem' in reading)
        return reading.problem
      value = reading.value!
    }
    return writeValues(sandboxValues.value.map(([name, old], at) => [name, at === index ? value : old]))
  }
}

function setValue(row: string, value: boolean) {
  const index = valueAt(row)
  act(index === -1 ? ROW_GONE : writeValues(sandboxValues.value.map(([name, old], at) => [name, at === index ? value : old])))
}

/** A value of another kind keeps what it can: a number from text, on for any value but false, 0 and empty. */
function convert(value: string | number | boolean, kind: ValueKind): string | number | boolean {
  if (kind === 'switch')
    return value === 'false' ? false : Boolean(value)
  if (kind === 'number') {
    const number = Number(value)
    return Number.isFinite(number) ? number : 0
  }
  return String(value)
}

function setKind(row: string, kind: ValueKind) {
  const index = valueAt(row)
  act(index === -1 ? ROW_GONE : writeValues(sandboxValues.value.map(([name, value], at) => [name, at === index ? convert(value, kind) : value])))
}

function addValue() {
  const names = new Set(sandboxValues.value.map(([name]) => name))
  let count = names.size + 1
  while (names.has(`value${count}`))
    count++
  act(writeValues([...sandboxValues.value, [`value${count}`, 0]]))
}

function removeValue(row: string) {
  const index = valueAt(row)
  act(index === -1 ? ROW_GONE : writeValues(sandboxValues.value.filter((_, at) => at !== index)))
}

// Where it sits among the others ----------------------------------------------------------

// The slide's list is its paint order. Markdown that flows always shows under
// movable elements, so only Markdown laid over the slide (a 3D scene behind
// the title, say) takes part.
const place = computed(() => props.stack.indexOf(props.element.id))
const last = computed(() => props.stack.length - 1)

/** Moves the element to `target` in the paint order: to where that element is in the slide's list. */
function stackTo(target: number) {
  const index = props.order.indexOf(props.stack[target] ?? '')
  act(index === -1 ? ROW_GONE : change(doc => moveElementInStack(doc, props.slideId, props.element.id, index, LOCAL_ORIGIN)))
}

const forward = () => stackTo(place.value + 1)
const backward = () => stackTo(place.value - 1)
const toFront = () => stackTo(last.value)
const toBack = () => stackTo(0)

function remove() {
  const result = change(doc => deleteElement(doc, props.slideId, props.element.id, LOCAL_ORIGIN))
  act(result)
  if (!result)
    emit('update:selection', [])
}
</script>

<template>
  <div class="flex flex-col gap-4" data-testid="element-inspector" :data-type="element.type">
    <h3 class="m-0 text-sm font-semibold lt-md:hidden" data-testid="inspector-title">
      {{ elementLabel(element) }}
    </h3>

    <section class="grid grid-cols-2 gap-2" aria-label="Place and size">
      <InspectorField
        v-for="{ field, label } in POSITION_FIELDS"
        :key="field"
        :name="field"
        :label="label"
        :value="fieldText(element.pos[field])"
        :placeholder="field === 'h' && autoHeight ? 'Auto' : ''"
        inputmode="decimal"
        :readonly="readonly"
        :commit="commitPosition(field)"
      />
    </section>

    <p v-if="element.type === 'text'" class="m-0 text-xs text-dey-muted">
      Double click or double tap the text on the slide to change it.
    </p>

    <section v-else-if="element.type === 'image'" class="flex flex-col gap-2" aria-label="Image">
      <InspectorField name="src" label="Image link" inputmode="url" :value="element.src" :readonly="readonly" :commit="text => commitReading(readLink(text), src => update({ src }))" />
      <button v-if="media && !readonly" type="button" class="dey-btn self-start text-xs" :aria-expanded="choosing" data-testid="choose-media" @click="choosing = !choosing">
        {{ choosing ? 'Close the project images' : 'Choose from this project' }}
      </button>
      <MediaPicker v-if="media && choosing && !readonly" :media="media" @pick="pickImage" />
      <InspectorField name="alt" label="Description for screen readers" :value="element.alt" :readonly="readonly" :commit="text => update({ alt: text.trim() })" />
    </section>

    <section v-else-if="shapeProps" class="grid grid-cols-2 items-start gap-2" aria-label="Shape">
      <div class="flex items-start gap-1">
        <InspectorField class="flex-1" name="fill" label="Fill" :value="shapeProps.fill ?? ''" placeholder="#38bdf8" :readonly="readonly" :commit="commitProp('fill', readColor)" />
        <input
          type="color"
          class="mt-5 h-8 w-8 shrink-0 cursor-pointer rounded border border-dey-line bg-transparent p-0"
          :value="pickerColor(shapeProps.fill, '#38bdf8')"
          :disabled="readonly"
          aria-label="Pick the fill color"
          data-testid="pick-fill"
          @change="act(setProps({ fill: ($event.target as HTMLInputElement).value }))"
        >
      </div>
      <div class="flex items-start gap-1">
        <InspectorField class="flex-1" name="stroke" label="Outline" :value="shapeProps.stroke ?? ''" placeholder="None" :readonly="readonly" :commit="commitProp('stroke', readColor)" />
        <input
          type="color"
          class="mt-5 h-8 w-8 shrink-0 cursor-pointer rounded border border-dey-line bg-transparent p-0"
          :value="pickerColor(shapeProps.stroke, '#ffffff')"
          :disabled="readonly"
          aria-label="Pick the outline color"
          data-testid="pick-stroke"
          @change="act(setProps({ stroke: ($event.target as HTMLInputElement).value }))"
        >
      </div>
      <InspectorField name="stroke-width" label="Outline width" inputmode="decimal" :value="fieldText(shapeProps.strokeWidth)" placeholder="0" :readonly="readonly" :commit="commitProp('strokeWidth', text => readNumber(text, { min: 0, optional: true }))" />
    </section>

    <section v-else-if="element.type === 'code'" class="flex flex-col gap-3" aria-label="Code">
      <div v-for="(step, index) in element.steps" :key="stepKeys[index]" class="flex flex-col gap-2 rounded-md border border-dey-line p-2" data-testid="code-step">
        <div class="flex items-end gap-2">
          <InspectorField class="flex-1" :name="`step-${index}-lang`" :label="element.steps.length > 1 ? `Step ${index + 1} language` : 'Language'" :value="step.lang" placeholder="ts" :readonly="readonly" :commit="commitStep(stepKeys[index], 'lang')" />
          <button v-if="element.steps.length > 1 && !readonly" type="button" class="dey-btn text-xs" :data-testid="`remove-step-${index}`" @click="removeStep(stepKeys[index])">
            Remove step
          </button>
        </div>
        <InspectorField :name="`step-${index}-code`" label="Code" multiline :value="step.code" :readonly="readonly" :commit="commitStep(stepKeys[index], 'code')" />
      </div>
      <button v-if="!readonly" type="button" class="dey-btn self-start text-xs" data-testid="add-step" @click="addStep">
        Add a Magic Move step
      </button>
    </section>

    <section v-else-if="element.type === 'scene3d'" class="grid grid-cols-2 gap-2" aria-label="3D scene">
      <InspectorField name="camera-position" label="Camera position" :value="fieldText(element.props.cameraPosition)" placeholder="7, 5, 9" :readonly="readonly" :commit="commitProp('cameraPosition', readVector)" />
      <InspectorField name="target" label="Look at" :value="fieldText(element.props.target)" placeholder="0, 0, 0" :readonly="readonly" :commit="commitProp('target', readVector)" />
      <InspectorField name="focus" label="Focus on node" :value="element.props.focus ?? ''" :readonly="readonly" :commit="commitProp('focus', readText)" />
      <InspectorField name="zoom-level" label="Zoom level" inputmode="decimal" :value="fieldText(element.props.zoomLevel)" placeholder="1" :readonly="readonly" :commit="commitProp('zoomLevel', text => readNumber(text, { above: 0, optional: true }))" />
      <InspectorField class="col-span-2" name="model" label="Model link (GLTF or GLB)" inputmode="url" :value="element.props.model ?? ''" :readonly="readonly" :commit="commitProp('model', readOptionalLink)" />
      <InspectorField name="scene-id" label="Scene id" :value="element.props.sceneId ?? ''" placeholder="default" :readonly="readonly" :commit="commitProp('sceneId', readText)" />
      <InspectorField name="smoothing" label="Smoothing" inputmode="decimal" :value="fieldText(element.props.smoothing)" placeholder="3" :readonly="readonly" :commit="commitProp('smoothing', text => readNumber(text, { min: 0, optional: true }))" />
      <InspectorField name="spin" label="Spin (radians a second)" inputmode="decimal" :value="fieldText(element.props.spin)" placeholder="0" :readonly="readonly" :commit="commitProp('spin', text => readNumber(text, { optional: true }))" />
      <div class="col-span-2 flex flex-wrap gap-x-4 gap-y-1">
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" :checked="element.props.orbitControls ?? false" :disabled="readonly" data-testid="switch-orbit-controls" @change="act(setProps({ orbitControls: ($event.target as HTMLInputElement).checked }))">
          Orbit controls
        </label>
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" :checked="element.props.transparent ?? false" :disabled="readonly" data-testid="switch-transparent" @change="act(setProps({ transparent: ($event.target as HTMLInputElement).checked }))">
          See through to the slide
        </label>
      </div>
    </section>

    <section v-else-if="element.type === 'algo-player'" class="flex flex-col gap-2" aria-label="Algorithm player">
      <InspectorField name="src" label="Animation link" inputmode="url" :value="element.props.src" :readonly="readonly" :commit="commitProp('src', readLink)" />
      <div class="flex flex-wrap gap-x-4 gap-y-1">
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" :checked="element.props.autoplay ?? true" :disabled="readonly" data-testid="switch-autoplay" @change="act(setProps({ autoplay: ($event.target as HTMLInputElement).checked }))">
          Play on its own
        </label>
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" :checked="element.props.loop ?? true" :disabled="readonly" data-testid="switch-loop" @change="act(setProps({ loop: ($event.target as HTMLInputElement).checked }))">
          Loop
        </label>
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" :checked="element.props.controls ?? true" :disabled="readonly" data-testid="switch-controls" @change="act(setProps({ controls: ($event.target as HTMLInputElement).checked }))">
          Controls
        </label>
      </div>
      <InspectorField name="quality" label="Quality (0 to 1)" inputmode="decimal" :value="fieldText(element.props.quality)" placeholder="1" :readonly="readonly" :commit="commitProp('quality', text => readNumber(text, { min: 0, max: 1, optional: true }))" />
    </section>

    <section v-else-if="element.type === 'sandbox'" class="flex flex-col gap-2" aria-label="Live sandbox">
      <div class="grid grid-cols-2 gap-2">
        <InspectorField name="title" label="Title" :value="element.props.title ?? ''" placeholder="Live sandbox" :readonly="readonly" :commit="commitProp('title', readText)" />
        <InspectorField name="step" label="Stepper amount" inputmode="decimal" :value="fieldText(element.props.step)" placeholder="1" :readonly="readonly" :commit="commitProp('step', text => readNumber(text, { above: 0, optional: true }))" />
      </div>
      <label class="flex items-center gap-2 text-sm">
        <input type="checkbox" :checked="element.props.inspector ?? true" :disabled="readonly" data-testid="switch-inspector" @change="act(setProps({ inspector: ($event.target as HTMLInputElement).checked }))">
        Show the state and its changes
      </label>
      <span class="text-xs text-dey-muted">Starting values</span>
      <div v-for="([key, value], index) in sandboxValues" :key="valueKeys[index]" class="grid grid-cols-[1fr_auto_1fr_auto] items-end gap-1" data-testid="sandbox-value">
        <InspectorField :name="`value-${index}-key`" label="Name" :value="key" :readonly="readonly" :commit="commitKey(valueKeys[index])" />
        <label class="flex flex-col gap-1 text-xs text-dey-muted">
          Kind
          <select
            class="dey-input w-auto py-1 text-sm"
            :value="kindOf(value)"
            :disabled="readonly"
            :data-testid="`field-value-${index}-kind`"
            @change="setKind(valueKeys[index], ($event.target as HTMLSelectElement).value as ValueKind)"
          >
            <option v-for="option in KINDS" :key="option.kind" :value="option.kind">{{ option.label }}</option>
          </select>
        </label>
        <label v-if="typeof value === 'boolean'" class="flex items-center gap-2 pb-1.5 text-sm">
          <input type="checkbox" :checked="value" :disabled="readonly" :data-testid="`field-value-${index}`" @change="setValue(valueKeys[index], ($event.target as HTMLInputElement).checked)">
          On
        </label>
        <InspectorField v-else :name="`value-${index}`" label="Value" :inputmode="typeof value === 'number' ? 'decimal' : 'text'" :value="fieldText(value)" :readonly="readonly" :commit="commitValue(valueKeys[index])" />
        <button v-if="!readonly" type="button" class="dey-btn mb-0.5 px-2 text-xs" :aria-label="`Remove ${key}`" :data-testid="`remove-value-${index}`" @click="removeValue(valueKeys[index])">
          &times;
        </button>
      </div>
      <button v-if="!readonly" type="button" class="dey-btn self-start text-xs" data-testid="add-value" @click="addValue">
        Add a value
      </button>
    </section>

    <section v-if="!readonly" class="flex flex-col gap-2" aria-label="Order and removal">
      <span class="text-xs text-dey-muted">Order on the slide</span>
      <div class="grid grid-cols-2 gap-1">
        <button type="button" class="dey-btn text-xs" :disabled="place >= last" data-testid="stack-forward" @click="forward">
          Bring forward
        </button>
        <button type="button" class="dey-btn text-xs" :disabled="place <= 0" data-testid="stack-backward" @click="backward">
          Send backward
        </button>
        <button type="button" class="dey-btn text-xs" :disabled="place >= last" data-testid="stack-front" @click="toFront">
          Bring to front
        </button>
        <button type="button" class="dey-btn text-xs" :disabled="place <= 0" data-testid="stack-back" @click="toBack">
          Send to back
        </button>
      </div>
      <button type="button" class="dey-btn self-start text-xs text-rose-300" data-testid="delete-element" @click="remove">
        Delete from the slide
      </button>
    </section>

    <p v-if="problem" class="m-0 text-xs text-rose-300" role="alert" data-testid="inspector-problem">
      {{ problem }}
    </p>
  </div>
</template>
