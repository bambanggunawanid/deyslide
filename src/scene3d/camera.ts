export type Vec3 = [number, number, number]

export interface CameraPose {
  position: Vec3
  target: Vec3
}

export interface CameraInput {
  /** Camera position before zoom is applied. */
  cameraPosition: Vec3
  /** Point the camera looks at. Zoom moves the camera toward this point. */
  target: Vec3
  /** 1 keeps the distance, 2 halves it, 0.5 doubles it. */
  zoomLevel: number
}

export const MIN_ZOOM = 0.05

/**
 * Turns the public props into the pose the camera should settle on.
 * Zoom scales the distance between camera and target, so a higher zoom
 * dives toward the focused sub component without changing the view angle.
 */
export function resolveCameraPose({ cameraPosition, target, zoomLevel }: CameraInput): CameraPose {
  const zoom = Math.max(zoomLevel, MIN_ZOOM)
  const position = cameraPosition.map((value, axis) => {
    const offset = value - target[axis]
    return target[axis] + offset / zoom
  }) as Vec3
  return { position, target: [...target] as Vec3 }
}

/**
 * Frame rate independent exponential smoothing.
 * The same `elapsed` time gives the same result at 30, 60 or 144 fps,
 * which keeps recorded videos deterministic.
 */
export function damp(current: number, goal: number, smoothing: number, delta: number): number {
  if (smoothing <= 0)
    return goal
  return goal + (current - goal) * Math.exp(-smoothing * delta)
}

export function dampVec3(current: Vec3, goal: Vec3, smoothing: number, delta: number): Vec3 {
  return [
    damp(current[0], goal[0], smoothing, delta),
    damp(current[1], goal[1], smoothing, delta),
    damp(current[2], goal[2], smoothing, delta),
  ]
}

export function dampPose(current: CameraPose, goal: CameraPose, smoothing: number, delta: number): CameraPose {
  return {
    position: dampVec3(current.position, goal.position, smoothing, delta),
    target: dampVec3(current.target, goal.target, smoothing, delta),
  }
}

export function isSettled(current: CameraPose, goal: CameraPose, epsilon = 1e-3): boolean {
  const all = [...current.position, ...current.target]
  const expected = [...goal.position, ...goal.target]
  return all.every((value, index) => Math.abs(value - expected[index]) < epsilon)
}

/**
 * Remembers the last camera pose per scene id.
 * Each slide mounts its own viewport, so without this memory the camera
 * would jump on every slide change. With it, the next slide starts where
 * the previous one stopped and eases into its own pose.
 */
export function createPoseMemory() {
  const poses = new Map<string, CameraPose>()
  return {
    remember(sceneId: string, pose: CameraPose) {
      poses.set(sceneId, {
        position: [...pose.position] as Vec3,
        target: [...pose.target] as Vec3,
      })
    },
    recall(sceneId: string): CameraPose | undefined {
      const pose = poses.get(sceneId)
      if (!pose)
        return undefined
      return { position: [...pose.position] as Vec3, target: [...pose.target] as Vec3 }
    },
    forget(sceneId: string) {
      poses.delete(sceneId)
    },
  }
}

export const poseMemory = createPoseMemory()
