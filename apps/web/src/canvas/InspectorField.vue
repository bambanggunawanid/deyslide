<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'

/**
 * One value of the inspector, typed in a field. While the person types it
 * keeps their text; Enter or leaving the field hands it to `commit`, which
 * writes it, or answers with a short reason when it cannot be used, shown
 * under the field. Text taken back to the deck's value writes nothing.
 * Otherwise the field shows the deck's value, so others' changes appear as
 * they happen.
 */
const props = withDefaults(defineProps<{
  label: string
  /** The deck's value, as text. */
  value: string
  /** Writes `text`, or says why it cannot. */
  commit: (text: string) => string | undefined
  /** Used in test ids: `field-<name>`. */
  name: string
  readonly?: boolean
  placeholder?: string
  multiline?: boolean
  inputmode?: 'text' | 'decimal' | 'numeric' | 'url'
}>(), { readonly: false, placeholder: '', multiline: false, inputmode: 'text' })

const draft = ref(props.value)
const editing = ref(false)
const problem = ref('')
const id = useId()

watch(() => props.value, (value) => {
  if (!editing.value) {
    draft.value = value
    problem.value = ''
  }
})

function onInput(event: Event) {
  editing.value = true
  draft.value = (event.target as HTMLInputElement | HTMLTextAreaElement).value
}

function save() {
  if (props.readonly || !editing.value)
    return
  // Typing taken back (a key, then Backspace) changes nothing.
  if (draft.value === props.value) {
    cancel()
    return
  }
  const reason = props.commit(draft.value)
  problem.value = reason ?? ''
  if (!reason) {
    editing.value = false
    draft.value = props.value
  }
}

/** Escape puts the deck's value back. */
function cancel() {
  editing.value = false
  problem.value = ''
  draft.value = props.value
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.stopPropagation()
    cancel()
  }
  else if (event.key === 'Enter' && !props.multiline) {
    event.preventDefault()
    save()
  }
}

const describedBy = computed(() => problem.value ? `${id}-problem` : undefined)
</script>

<template>
  <div class="flex min-w-0 flex-col gap-1" :data-field="name">
    <label :for="id" class="text-xs text-dey-muted">{{ label }}</label>
    <textarea
      v-if="multiline"
      :id="id"
      class="dey-input min-h-24 py-1 font-mono text-xs"
      :value="draft"
      :readonly="readonly"
      :placeholder="placeholder"
      :aria-invalid="problem ? 'true' : undefined"
      :aria-describedby="describedBy"
      :data-testid="`field-${name}`"
      spellcheck="false"
      @input="onInput"
      @change="save"
      @blur="save"
      @keydown="onKeydown"
    />
    <input
      v-else
      :id="id"
      class="dey-input py-1 text-sm"
      :value="draft"
      :readonly="readonly"
      :placeholder="placeholder"
      :inputmode="inputmode"
      :aria-invalid="problem ? 'true' : undefined"
      :aria-describedby="describedBy"
      :data-testid="`field-${name}`"
      @input="onInput"
      @change="save"
      @blur="save"
      @keydown="onKeydown"
    >
    <p v-if="problem" :id="`${id}-problem`" class="m-0 text-xs text-rose-300" role="alert" :data-testid="`field-${name}-problem`">
      {{ problem }}
    </p>
  </div>
</template>
