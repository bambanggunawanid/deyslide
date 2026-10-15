import type { InjectionKey, MaybeRefOrGetter, Ref, ShallowRef } from 'vue'
import type { Project } from '../guest/types'
import type { ProjectStore } from '../projects/types'
import type { Workspace } from '../projects/workspace'
import { computed, inject, onScopeDispose, shallowRef, toValue, watch } from 'vue'

export const WORKSPACE_KEY: InjectionKey<Workspace> = Symbol('workspace')

export function useWorkspace(): Workspace {
  const workspace = inject(WORKSPACE_KEY)
  if (!workspace)
    throw new Error('The workspace is not provided')
  return workspace
}

/**
 * The store for a project id (the primary store without one), plus lists
 * that refresh after every change: the person's own projects, and the ones
 * shared with them.
 */
export function useProjects(projectId?: MaybeRefOrGetter<string | undefined>): { store: Readonly<Ref<ProjectStore>>, projects: ShallowRef<Project[]>, shared: ShallowRef<Project[]> } {
  const workspace = useWorkspace()
  const store = computed(() => {
    // Both read the workspace's refs, so the choice follows signing in and out.
    const id = toValue(projectId)
    return id === undefined ? workspace.primary.value : workspace.storeFor(id)
  })
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
