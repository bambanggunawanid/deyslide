import type { VueWrapper } from '@vue/test-utils'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { flushPromises, mount } from '@vue/test-utils'
import { expect, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import DeyslideScene3D from '../components/DeyslideScene3D.vue'
import { findNode, nodeCenter } from '../src/scene3d/architecture'
import { FakeResizeObserver } from './support/resize-observer'
import { resetSlidevTestState, slidevTestState } from './support/slidev-client'

vi.mock('@tresjs/cientos', async () => {
  const { defineComponent } = await import('vue')
  const stub = (name: string, props: string[]) => defineComponent({ name, props, render: () => null })
  return {
    OrbitControls: stub('OrbitControls', ['target', 'makeDefault', 'enableDamping']),
    GLTFModel: stub('GLTFModel', ['path']),
  }
})

const feature = await loadFeature('./scene3d.feature')

// happy-dom has no WebGL, so the canvas only renders its children and the
// three.js driven parts are replaced with stubs that expose their props.
// cientos components are mocked above for the same reason.
const TresCanvasStub = defineComponent({
  name: 'TresCanvas',
  emits: ['render'],
  setup: (_, { slots }) => () => h('div', { 'data-stub': 'canvas' }, [h('canvas'), slots.default?.()]),
})

const stubs = {
  TresCanvas: TresCanvasStub,
  CameraRig: true,
  ArchitectureMesh: true,
}

vi.stubGlobal('ResizeObserver', FakeResizeObserver)

function mountHidden(props: Record<string, unknown> = {}) {
  return mount(DeyslideScene3D, { props, global: { stubs } })
}

/** Gives every observed viewport a visible size and waits for the canvas frame. */
async function becomeVisible() {
  FakeResizeObserver.resizeAll(800, 450)
  await new Promise(done => requestAnimationFrame(done))
  await flushPromises()
}

/** Mounts the viewport and gives it a visible size, like an on screen slide. */
async function mountScene(props: Record<string, unknown> = {}) {
  const mounted = mountHidden(props)
  await becomeVisible()
  return mounted
}

describeFeature(feature, ({ Scenario, ScenarioOutline, AfterEachScenario }) => {
  let wrapper: VueWrapper

  AfterEachScenario(() => {
    wrapper?.unmount()
    resetSlidevTestState()
    FakeResizeObserver.reset()
    vi.restoreAllMocks()
  })

  const rig = () => wrapper.findComponent({ name: 'CameraRig' })
  const orbit = () => wrapper.findComponent({ name: 'OrbitControls' })

  Scenario('Camera is locked by default for linear recordings', ({ Given, Then, And }) => {
    Given('the 3D viewport is mounted with default props', async () => {
      wrapper = await mountScene()
    })
    Then('orbit controls are not mounted', () => {
      expect(orbit().exists()).toBe(false)
      expect(wrapper.attributes('data-orbit-controls')).toBe('off')
    })
    And('the camera rig is locked', () => {
      expect(rig().props('locked')).toBe(true)
    })
  })

  Scenario('Orbit controls turn on for live Q&A', ({ Given, Then, And }) => {
    Given('the 3D viewport is mounted with orbit controls on and focus "cache"', async () => {
      wrapper = await mountScene({ orbitControls: true, focus: 'cache' })
    })
    Then('orbit controls are mounted', () => {
      expect(orbit().exists()).toBe(true)
    })
    And('orbit controls circle around the cache', () => {
      expect(orbit().props('target')).toEqual(nodeCenter(findNode('cache')!))
    })
    And('the camera rig is unlocked', () => {
      expect(rig().props('locked')).toBe(false)
    })
    And('a hint tells the audience they can drag', () => {
      expect(wrapper.text()).toContain('drag to rotate')
    })
  })

  Scenario('Zoom moves the camera toward the focused service', ({ Given, When, Then, And }) => {
    const orders = nodeCenter(findNode('orders')!)
    Given('the 3D viewport is mounted with camera 10, 0, 0 focus "orders" and zoom 1', async () => {
      wrapper = await mountScene({ cameraPosition: [10, 0, 0], focus: 'orders', zoomLevel: 1 })
    })
    When('the zoom level changes to 2', async () => {
      await wrapper.setProps({ zoomLevel: 2 })
    })
    Then('the camera rig aims at the orders service', () => {
      expect(rig().props('pose').target).toEqual(orders)
    })
    And('the camera rig target position is halfway to the orders service', () => {
      const expected = [10, 0, 0].map((value, axis) => orders[axis] + (value - orders[axis]) / 2)
      expect(rig().props('pose').position).toEqual(expected)
    })
  })

  Scenario('A hidden slide waits for space before creating a canvas', ({ Given, Then, When }) => {
    Given('the 3D viewport is mounted on a hidden slide', () => {
      wrapper = mountHidden()
    })
    Then('no WebGL canvas is created', () => {
      expect(wrapper.find('[data-stub="canvas"]').exists()).toBe(false)
      expect(wrapper.attributes('data-canvas')).toBe('waiting')
    })
    When('the slide becomes visible', becomeVisible)
    Then('the WebGL canvas is created', () => {
      expect(wrapper.find('[data-stub="canvas"]').exists()).toBe(true)
      expect(wrapper.attributes('data-canvas')).toBe('ready')
    })
  })

  Scenario('PDF export captures a still frame', ({ Given, Then, When, And }) => {
    Given('the 3D viewport is mounted in print mode', async () => {
      vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,FRAME')
      slidevTestState.isPrintMode.value = true
      wrapper = await mountScene()
    })
    Then('the exporter is told to wait for a rendered frame', () => {
      expect(wrapper.attributes('data-waitfor')).toBe('[data-frame-ready]')
      expect(wrapper.find('[data-frame-ready]').exists()).toBe(false)
    })
    When('the canvas renders two frames', async () => {
      const canvas = wrapper.findComponent(TresCanvasStub)
      canvas.vm.$emit('render')
      canvas.vm.$emit('render')
      await flushPromises()
    })
    Then('a still image of the canvas replaces the live canvas', () => {
      expect(wrapper.get('img').attributes('src')).toBe('data:image/png;base64,FRAME')
      expect(wrapper.get('[data-stub="canvas"]').attributes('style')).toContain('visibility: hidden')
    })
    And('the page is marked ready for export', () => {
      expect(wrapper.find('[data-frame-ready]').exists()).toBe(true)
    })
  })

  Scenario('A GLTF model replaces the placeholder architecture', ({ Given, Then, And }) => {
    Given('the 3D viewport is mounted with model "/models/system.glb"', async () => {
      wrapper = await mountScene({ model: '/models/system.glb' })
    })
    Then('the GLTF model loads "/models/system.glb"', () => {
      expect(wrapper.findComponent({ name: 'GLTFModel' }).props('path')).toBe('/models/system.glb')
    })
    And('the placeholder architecture is not rendered', () => {
      expect(wrapper.findComponent({ name: 'ArchitectureMesh' }).exists()).toBe(false)
    })
  })

  ScenarioOutline('Camera motion follows the slide state', ({ Given, When, Then }, variables) => {
    Given('the slide is active: <active>, in print mode: <print>', () => {
      slidevTestState.isSlideActive.value = variables.active === 'true'
      slidevTestState.isPrintMode.value = variables.print === 'true'
    })
    When('the 3D viewport is mounted with default props', async () => {
      wrapper = await mountScene()
    })
    Then('the camera rig mode is "<mode>"', () => {
      expect(rig().props('mode')).toBe(variables.mode)
    })
  })
})
