<script setup lang="ts">
import type { Vec3 } from '../src/scene3d/camera'
import { useIsSlideActive, useNav, useSlideContext } from '@slidev/client'
import { GLTFModel, OrbitControls } from '@tresjs/cientos'
import { TresCanvas } from '@tresjs/core'
import { computed, ref, shallowRef } from 'vue'
import ArchitectureMesh from '../src/scene3d/ArchitectureMesh.vue'
import { resolveFocusTarget } from '../src/scene3d/architecture'
import { resolveCameraPose } from '../src/scene3d/camera'
import CameraRig from '../src/scene3d/CameraRig.vue'
import { resolveMotionMode } from '../src/scene3d/motion-mode'
import ThreePointLights from '../src/scene3d/ThreePointLights.vue'
import { useHasArea } from '../src/scene3d/use-has-area'

const props = withDefaults(defineProps<{
  /** Camera position before zoom. */
  cameraPosition?: Vec3
  /** Explicit look at point. Ignored when `focus` matches a node. */
  target?: Vec3
  /** Id of a placeholder architecture node to center and highlight. */
  focus?: string
  /** 1 keeps the distance to the target, 2 halves it, 0.5 doubles it. */
  zoomLevel?: number
  /** Mount OrbitControls. Keep off for recordings, turn on for live Q&A. */
  orbitControls?: boolean
  /** Path to a GLTF or GLB file. Replaces the placeholder architecture. */
  model?: string
  /** Viewports with the same id share camera memory across slides. */
  sceneId?: string
  /** Higher is snappier. 0 jumps straight to the target pose. */
  smoothing?: number
  /** Radians per second the placeholder scene turns. */
  spin?: number
  /** Let the slide background show through. */
  transparent?: boolean
}>(), {
  cameraPosition: () => [7, 5, 9],
  zoomLevel: 1,
  orbitControls: false,
  sceneId: 'default',
  smoothing: 3,
  spin: 0,
  transparent: false,
})

const root = shallowRef<HTMLElement>()
const hasArea = useHasArea(root)

// Print mode comes from the global nav: the per slide `$nav` inside Slidev's
// print container does not carry it.
const { isPrintMode } = useNav()
const { $renderContext } = useSlideContext()
const isSlideActive = useIsSlideActive()

const mode = computed(() => resolveMotionMode({
  renderContext: $renderContext.value,
  isPrintMode: isPrintMode.value,
  isSlideActive: isSlideActive.value,
}))

// Slidev's exporter waits for `[data-waitfor]` selectors before it prints a
// page. Chromium's PDF output drops WebGL canvases, so while exporting the
// rendered frame is copied into an <img>, and only then is the page marked
// ready. Live previews (overview, next slide) keep the canvas, because their
// pose can still change.
const FRAMES_BEFORE_READY = 2
const renderedFrames = ref(0)
const snapshot = ref<string>()
const capturing = computed(() => isPrintMode.value)
const frameReady = computed(() => capturing.value
  ? !!snapshot.value
  : renderedFrames.value >= FRAMES_BEFORE_READY)

function onRender() {
  if (renderedFrames.value >= FRAMES_BEFORE_READY)
    return
  renderedFrames.value++
  if (renderedFrames.value === FRAMES_BEFORE_READY && capturing.value)
    snapshot.value = root.value?.querySelector('canvas')?.toDataURL('image/png')
}

const lookAt = computed(() => resolveFocusTarget(props.focus, props.target))

const pose = computed(() => resolveCameraPose({
  cameraPosition: props.cameraPosition,
  target: lookAt.value,
  zoomLevel: props.zoomLevel,
}))
</script>

<template>
  <div
    ref="root"
    class="deyslide-scene3d relative h-full w-full overflow-hidden"
    :data-orbit-controls="orbitControls ? 'on' : 'off'"
    :data-focus="focus ?? ''"
    :data-motion-mode="mode"
    :data-canvas="hasArea ? 'ready' : 'waiting'"
    :data-waitfor="capturing ? '[data-frame-ready]' : undefined"
  >
    <TresCanvas
      v-if="hasArea"
      clear-color="#0b1020"
      :clear-alpha="transparent ? 0 : 1"
      :alpha="transparent"
      :preserve-drawing-buffer="capturing"
      antialias
      :style="snapshot ? { visibility: 'hidden' } : undefined"
      @render="onRender"
    >
      <TresPerspectiveCamera :fov="45" :near="0.1" :far="200" />
      <CameraRig :pose="pose" :scene-id="sceneId" :smoothing="smoothing" :locked="!orbitControls" :mode="mode" />
      <OrbitControls v-if="orbitControls" make-default :target="pose.target" enable-damping />
      <ThreePointLights />
      <Suspense v-if="model">
        <GLTFModel :path="model" />
      </Suspense>
      <ArchitectureMesh v-else :focus="focus" :spin="mode === 'snap' ? 0 : spin" />
    </TresCanvas>
    <img
      v-if="snapshot"
      :src="snapshot"
      alt=""
      class="pointer-events-none absolute inset-0 h-full w-full"
    >
    <span v-if="frameReady" data-frame-ready class="pointer-events-none absolute left-0 top-0 h-px w-px" />
    <div
      v-if="orbitControls"
      class="pointer-events-none absolute right-3 top-3 rounded bg-black/50 px-2 py-1 text-xs text-sky-300"
    >
      Orbit: drag to rotate
    </div>
  </div>
</template>
