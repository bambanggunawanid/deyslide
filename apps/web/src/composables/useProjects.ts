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

/** The active project store plus a project list that refreshes after every change. */
export function useProjects(): { store: ShallowRef<ProjectStore>, projects: ShallowRef<Project[]> } {
  const { store } = useWorkspace()
  const projects = shallowRef<Project[]>([])
  let stop = () => {}
  watch(store, (current) => {
    stop()
    projects.value = current.listProjects()
    const unsubscribe = current.onChange(() => {
      projects.value = current.listProjects()
    })
    stop = () => {
      unsubscribe()
    }
  }, { immediate: true })
  onScopeDispose(() => stop())
  return { store, projects }
}
