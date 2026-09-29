import type { InjectionKey, ShallowRef } from 'vue'
import type { Project } from '../guest/types'
import type { ProjectStore } from '../projects/types'
import type { Workspace } from '../projects/workspace'
import { inject, onScopeDispose, shallowRef, watch } from 'vue'

export const WORKSPACE_KEY: InjectionKey<Workspace> = Symbol('workspace')

export function useWorkspace(): Workspace {
  const workspace = inject(WORKSPACE_KEY)
  if (!workspace)
    throw new Error('The workspace is not provided')
  return workspace
}

/**
 * The active project store plus lists that refresh after every change: the
 * person's own projects, and the ones shared with them.
 */
export function useProjects(): { store: ShallowRef<ProjectStore>, projects: ShallowRef<Project[]>, shared: ShallowRef<Project[]> } {
  const { store } = useWorkspace()
  const projects = shallowRef<Project[]>([])
  const shared = shallowRef<Project[]>([])
  let stop = () => {}
  watch(store, (current) => {
    stop()
    const read = () => {
      projects.value = current.listProjects()
      shared.value = current.listShared()
    }
    read()
    const unsubscribe = current.onChange(read)
    stop = () => {
      unsubscribe()
    }
  }, { immediate: true })
  onScopeDispose(() => stop())
  return { store, projects, shared }
}
