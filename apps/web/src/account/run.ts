import type { Ref } from 'vue'
import { AccountError } from './types'

/** Runs a form action, keeping `busy` and `error` up to date. Returns true on success. */
export async function runForm(busy: Ref<boolean>, error: Ref<string>, action: () => Promise<unknown>) {
  busy.value = true
  error.value = ''
  try {
    await action()
    return true
  }
  catch (caught) {
    error.value = caught instanceof AccountError ? caught.message : 'Something went wrong. Try again.'
    return false
  }
  finally {
    busy.value = false
  }
}
