<script setup lang="ts">
import type { SandboxChange, SandboxState, SandboxValue } from '../src/sandbox/sandbox'
import { computed, reactive } from 'vue'
import { createSandboxModel, DEFAULT_HISTORY_LIMIT } from '../src/sandbox/sandbox'

const props = withDefaults(defineProps<{
  /** Starting state. Booleans become switches, numbers get steppers, strings get inputs. */
  initial: SandboxState
  title?: string
  /** Amount the number steppers add or remove. */
  step?: number
  /** Show the JSON inspector and change log. */
  inspector?: boolean
  historyLimit?: number
}>(), {
  title: 'Live sandbox',
  step: 1,
  inspector: true,
  historyLimit: DEFAULT_HISTORY_LIMIT,
})

const emit = defineEmits<{
  change: [change: SandboxChange | null, state: SandboxState]
}>()

const model = createSandboxModel(props.initial, {
  historyLimit: props.historyLimit,
  wrap: value => reactive(value) as typeof value,
})

const entries = computed(() => Object.entries(model.state))
const recent = computed(() => [...model.history].reverse().slice(0, 5))
const snapshot = computed(() => model.snapshot())

function afterChange() {
  emit('change', model.history.at(-1) ?? null, { ...model.state })
}

function set(key: string, value: SandboxValue) {
  model.set(key, value)
  afterChange()
}

function toggle(key: string) {
  model.toggle(key)
  afterChange()
}

function stepBy(key: string, amount: number) {
  model.step(key, amount)
  afterChange()
}

function undo() {
  model.undo()
  afterChange()
}

function reset() {
  model.reset()
  afterChange()
}

function onText(key: string, event: Event) {
  set(key, (event.target as HTMLInputElement).value)
}

defineExpose({ model })
</script>

<template>
  <section class="deyslide-sandbox dey-panel flex flex-col gap-2 text-sm">
    <header class="flex items-center gap-2">
      <div class="text-xs font-semibold uppercase tracking-wider text-slate-300">
        {{ title }}
      </div>
      <button class="dey-btn ml-auto" data-testid="sandbox-undo" :disabled="model.history.length === 0" @click="undo">
        Undo
      </button>
      <button class="dey-btn" data-testid="sandbox-reset" @click="reset">
        Reset
      </button>
    </header>

    <div class="grid gap-3" :class="inspector ? 'grid-cols-2' : 'grid-cols-1'">
      <ul class="m-0 flex list-none flex-col gap-1.5 p-0">
        <li
          v-for="[key, value] in entries"
          :key="key"
          class="flex items-center justify-between gap-2 rounded bg-slate-800/60 px-3 py-1"
          :data-key="key"
        >
          <span class="font-mono text-slate-300">{{ key }}</span>

          <button
            v-if="typeof value === 'boolean'"
            role="switch"
            :aria-checked="value"
            :data-testid="`toggle-${key}`"
            class="relative h-6 w-11 rounded-full transition-colors"
            :class="value ? 'bg-emerald-500' : 'bg-slate-600'"
            @click="toggle(key)"
          >
            <span
              class="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all"
              :class="value ? 'left-5.5' : 'left-0.5'"
            />
          </button>

          <span v-else-if="typeof value === 'number'" class="flex items-center gap-1">
            <button class="dey-btn px-2" :data-testid="`dec-${key}`" @click="stepBy(key, -step)">-</button>
            <output class="w-12 text-center font-mono text-sky-300" :data-testid="`value-${key}`">{{ value }}</output>
            <button class="dey-btn px-2" :data-testid="`inc-${key}`" @click="stepBy(key, step)">+</button>
          </span>

          <input
            v-else
            class="w-40 rounded border border-slate-600 bg-slate-900 px-2 py-1 font-mono text-slate-100"
            :data-testid="`input-${key}`"
            :value="value"
            @change="onText(key, $event)"
          >
        </li>
      </ul>

      <div v-if="inspector" class="flex flex-col gap-2">
        <pre class="m-0 rounded bg-black/40 p-3 font-mono text-xs text-emerald-300" data-testid="sandbox-json">{{ snapshot }}</pre>
        <ol class="m-0 flex list-none flex-col gap-1 p-0 text-xs text-slate-400" data-testid="sandbox-history">
          <li v-for="(change, index) in recent" :key="index">
            <span class="font-mono">{{ change.key }}</span>: {{ String(change.from) }} to {{ String(change.to) }}
          </li>
        </ol>
      </div>
    </div>

    <div v-if="$slots.default" class="rounded border border-dashed border-slate-600 p-2">
      <slot :state="model.state" />
    </div>
  </section>
</template>
