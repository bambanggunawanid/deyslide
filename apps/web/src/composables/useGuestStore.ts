import type { InjectionKey, ShallowRef } from 'vue'
import type { GuestStore } from '../guest/store'
import type { Project } from '../guest/types'
import { inject, onScopeDispose, shallowRef } from 'vue'

export const GUEST_STORE_KEY: InjectionKey<GuestStore> = Symbol('guest-store')

/** The guest store plus a list of projects that refreshes after every change. */
export function useGuestStore(): { store: GuestStore, projects: ShallowRef<Project[]> } {
  const store = inject(GUEST_STORE_KEY)
  if (!store)
    throw new Error('The guest store is not provided')
  const projects = shallowRef(store.listProjects())
  const stop = store.onChange(() => {
    projects.value = store.listProjects()
  })
  onScopeDispose(stop)
  return { store, projects }
}
