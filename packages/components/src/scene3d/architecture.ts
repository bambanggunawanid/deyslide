import type { Vec3 } from './camera'

export interface ArchitectureNode {
  id: string
  label: string
  /** Center of the node footprint on the floor (y is the floor height). */
  position: Vec3
  size: Vec3
  color: string
}

export interface ArchitectureLink {
  from: string
  to: string
}

/**
 * Placeholder system architecture used when no GLTF model is given.
 * Each node id can be passed to `<DeyslideScene3D focus="...">`.
 */
export const ARCHITECTURE_NODES: ArchitectureNode[] = [
  { id: 'client', label: 'Client', position: [-4.5, 0, 0], size: [1.2, 0.8, 1.2], color: '#38bdf8' },
  { id: 'gateway', label: 'API Gateway', position: [-1.8, 0, 0], size: [1.2, 1.4, 1.2], color: '#a78bfa' },
  { id: 'auth', label: 'Auth Service', position: [1, 0, -2], size: [1, 1, 1], color: '#34d399' },
  { id: 'orders', label: 'Orders Service', position: [1, 0, 0], size: [1, 1, 1], color: '#34d399' },
  { id: 'search', label: 'Search Service', position: [1, 0, 2], size: [1, 1, 1], color: '#34d399' },
  { id: 'database', label: 'Database', position: [4, 0, 0], size: [1.4, 1.8, 1.4], color: '#f472b6' },
  { id: 'cache', label: 'Cache', position: [4, 0, 2.2], size: [0.9, 0.9, 0.9], color: '#fbbf24' },
]

export const ARCHITECTURE_LINKS: ArchitectureLink[] = [
  { from: 'client', to: 'gateway' },
  { from: 'gateway', to: 'auth' },
  { from: 'gateway', to: 'orders' },
  { from: 'gateway', to: 'search' },
  { from: 'orders', to: 'database' },
  { from: 'search', to: 'cache' },
]

export const SCENE_ORIGIN: Vec3 = [0, 0, 0]

export function findNode(id: string | undefined, nodes: ArchitectureNode[] = ARCHITECTURE_NODES): ArchitectureNode | undefined {
  if (!id)
    return undefined
  return nodes.find(node => node.id === id)
}

/** Middle of the node volume, which is where the camera should look. */
export function nodeCenter(node: ArchitectureNode): Vec3 {
  return [node.position[0], node.position[1] + node.size[1] / 2, node.position[2]]
}

/**
 * The camera target for a focus id. Falls back to the explicit target, then
 * to the scene origin, so an unknown id never breaks a live talk.
 */
export function resolveFocusTarget(focus: string | undefined, fallback: Vec3 | undefined, nodes: ArchitectureNode[] = ARCHITECTURE_NODES): Vec3 {
  const node = findNode(focus, nodes)
  if (node)
    return nodeCenter(node)
  return fallback ? [...fallback] as Vec3 : [...SCENE_ORIGIN] as Vec3
}

export function linkEndpoints(link: ArchitectureLink, nodes: ArchitectureNode[] = ARCHITECTURE_NODES): [Vec3, Vec3] | undefined {
  const from = findNode(link.from, nodes)
  const to = findNode(link.to, nodes)
  if (!from || !to)
    return undefined
  return [nodeCenter(from), nodeCenter(to)]
}
