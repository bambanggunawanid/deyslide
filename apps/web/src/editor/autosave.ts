import type { Ref } from 'vue'
import { computed, onScopeDispose, ref, watch } from 'vue'

export type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'failed'

/**
 * Saves `text` a moment after it stops changing. `markSaved` records text that
 * is already stored, such as the text a page loaded.
 */
export function useAutosave(text: Ref<string>, save: (value: string) => Promise<void>, delay = 800) {
  const savedText = ref(text.value)
  const saving = ref(false)
  const error = ref('')
  let timer: ReturnType<typeof setTimeout> | undefined

  const status = computed<SaveStatus>(() => {
    if (saving.value)
      return 'saving'
    if (error.value)
      return 'failed'
    return text.value === savedText.value ? 'saved' : 'unsaved'
  })

  async function flush() {
    clearTimeout(timer)
    if (saving.value || text.value === savedText.value)
      return
    const value = text.value
    saving.value = true
    try {
      await save(value)
      savedText.value = value
      error.value = ''
    }
    catch (caught) {
      error.value = caught instanceof Error ? caught.message : String(caught)
    }
    finally {
      saving.value = false
    }
    if (!error.value && text.value !== savedText.value)
      schedule()
  }

  function schedule() {
    clearTimeout(timer)
    timer = setTimeout(() => void flush(), delay)
  }

  function markSaved(value: string) {
    savedText.value = value
    error.value = ''
  }

  watch(text, () => {
    if (text.value !== savedText.value)
      schedule()
  })
  onScopeDispose(() => clearTimeout(timer))

  return { status, error, flush, markSaved }
}
