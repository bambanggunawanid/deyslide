<script setup lang="ts">
import { DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { ref, watch } from 'vue'
import { NAME_MAX_LENGTH } from '../guest/store'

/** Asks for a name, runs `action`, and stays open with the error if it fails. */
const props = withDefaults(defineProps<{
  title: string
  description?: string
  label: string
  submitLabel: string
  initialName?: string
  action: (name: string) => Promise<void>
}>(), { initialName: '' })

const open = defineModel<boolean>('open', { required: true })
const name = ref(props.initialName)
const error = ref('')
const busy = ref(false)

watch(open, (value) => {
  if (value) {
    name.value = props.initialName
    error.value = ''
  }
})

async function submit() {
  busy.value = true
  error.value = ''
  try {
    await props.action(name.value)
    open.value = false
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 bg-black/60" />
      <DialogContent class="dey-panel fixed left-1/2 top-1/2 w-[min(92vw,28rem)] -translate-x-1/2 -translate-y-1/2" data-testid="name-dialog">
        <DialogTitle class="m-0 text-lg font-semibold">
          {{ title }}
        </DialogTitle>
        <DialogDescription v-if="description" class="mt-1 text-sm text-dey-muted">
          {{ description }}
        </DialogDescription>
        <form class="mt-4 flex flex-col gap-3" @submit.prevent="submit">
          <label class="flex flex-col gap-1 text-sm">
            {{ label }}
            <input v-model="name" class="dey-input" :maxlength="NAME_MAX_LENGTH" data-testid="name-input" autofocus>
          </label>
          <slot />
          <p v-if="error" class="m-0 text-sm text-rose-300" role="alert">
            {{ error }}
          </p>
          <div class="mt-2 flex justify-end gap-2">
            <DialogClose class="dey-btn" type="button">
              Cancel
            </DialogClose>
            <button class="dey-btn-primary" type="submit" :disabled="busy" data-testid="name-submit">
              {{ submitLabel }}
            </button>
          </div>
        </form>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
