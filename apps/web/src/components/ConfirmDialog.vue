<script setup lang="ts">
import { AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogOverlay, AlertDialogPortal, AlertDialogRoot, AlertDialogTitle } from 'reka-ui'

defineProps<{
  title: string
  description: string
  confirmLabel: string
}>()

const emit = defineEmits<{ confirm: [] }>()
const open = defineModel<boolean>('open', { required: true })
</script>

<template>
  <AlertDialogRoot v-model:open="open">
    <AlertDialogPortal>
      <AlertDialogOverlay class="fixed inset-0 bg-black/60" />
      <AlertDialogContent class="dey-panel fixed left-1/2 top-1/2 w-[min(92vw,28rem)] -translate-x-1/2 -translate-y-1/2" data-testid="confirm-dialog">
        <AlertDialogTitle class="m-0 text-lg font-semibold">
          {{ title }}
        </AlertDialogTitle>
        <AlertDialogDescription class="mt-2 text-sm text-dey-muted">
          {{ description }}
        </AlertDialogDescription>
        <div class="mt-4 flex justify-end gap-2">
          <AlertDialogCancel class="dey-btn">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction class="rounded-md border border-rose-400 bg-rose-500 px-3 py-1 font-medium text-white hover:bg-rose-400" data-testid="confirm-action" @click="emit('confirm')">
            {{ confirmLabel }}
          </AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialogPortal>
  </AlertDialogRoot>
</template>
