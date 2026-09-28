<script setup lang="ts">
// Rendered by TresCanvas in its own Vue app, where Slidev context is not
// provided. This marker tells Slidev to skip injecting it.
/* @slidev-injection */
import type { CameraPose } from './camera'
import type { MotionMode } from './motion-mode'
import { useLoop } from '@tresjs/core'
import { dampPose, poseMemory } from './camera'

/**
 * Drives the active camera toward `pose` every frame.
 * Lives inside `<TresCanvas>` because `useLoop` needs the Tres context.
 */
const props = defineProps<{
  pose: CameraPose
  sceneId: string
  smoothing: number
  /** When false, OrbitControls owns the camera and the rig only observes. */
  locked: boolean
  mode: MotionMode
}>()

/** Longest step the rig takes in one frame, so a stalled tab does not snap. */
const MAX_DELTA = 0.1

// Start from where the previous slide with the same scene id left off.
let current: CameraPose = poseMemory.recall(props.sceneId) ?? {
  position: [...props.pose.position],
  target: [...props.pose.target],
}

const { onBeforeRender } = useLoop()

onBeforeRender(({ delta, camera }) => {
  const active = camera.value
  if (!active)
    return

  if (props.mode === 'hold')
    return

  if (!props.locked && props.mode === 'animate') {
    const { x, y, z } = active.position
    current = { position: [x, y, z], target: [...props.pose.target] }
    poseMemory.remember(props.sceneId, current)
    return
  }

  const smoothing = props.mode === 'snap' ? 0 : props.smoothing
  current = dampPose(current, props.pose, smoothing, Math.min(delta, MAX_DELTA))
  active.position.set(...current.position)
  active.lookAt(...current.target)
  if (props.mode === 'animate')
    poseMemory.remember(props.sceneId, current)
})
</script>

<template>
  <slot />
</template>
