import type { CameraPose, Vec3 } from '../packages/components/src/scene3d/camera'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { createPoseMemory, damp, MIN_ZOOM, resolveCameraPose } from '../packages/components/src/scene3d/camera'

const feature = await loadFeature('./camera.feature')

function simulate(from: number, goal: number, smoothing: number, frames: number) {
  let value = from
  for (let i = 0; i < frames; i++)
    value = damp(value, goal, smoothing, 1 / frames)
  return value
}

describeFeature(feature, ({ Scenario }) => {
  Scenario('Zoom moves the camera toward the target', ({ Given, When, Then, And }) => {
    let cameraPosition: Vec3
    let pose: CameraPose
    Given('a camera at 0, 0, 10 looking at the origin', () => {
      cameraPosition = [0, 0, 10]
    })
    When('the zoom level is 2', () => {
      pose = resolveCameraPose({ cameraPosition, target: [0, 0, 0], zoomLevel: 2 })
    })
    Then('the camera settles at 0, 0, 5', () => {
      expect(pose.position).toEqual([0, 0, 5])
    })
    And('the camera still looks at the origin', () => {
      expect(pose.target).toEqual([0, 0, 0])
    })
  })

  Scenario('Zoom below the minimum is clamped', ({ Given, When, Then }) => {
    let cameraPosition: Vec3
    let pose: CameraPose
    Given('a camera at 0, 0, 10 looking at the origin', () => {
      cameraPosition = [0, 0, 10]
    })
    When('the zoom level is 0', () => {
      pose = resolveCameraPose({ cameraPosition, target: [0, 0, 0], zoomLevel: 0 })
    })
    Then('the camera distance equals 10 divided by the minimum zoom', () => {
      expect(pose.position[2]).toBeCloseTo(10 / MIN_ZOOM)
    })
  })

  Scenario('Smoothing gives the same result at any frame rate', ({ Given, When, And, Then }) => {
    let slow = 0
    let fast = 0
    Given('a camera moving from 0 to 10 with smoothing 4', () => {})
    When('one second passes in 30 frames', () => {
      slow = simulate(0, 10, 4, 30)
    })
    And('the same second passes in 144 frames', () => {
      fast = simulate(0, 10, 4, 144)
    })
    Then('both runs end at the same position', () => {
      expect(slow).toBeCloseTo(fast, 10)
      expect(slow).toBeGreaterThan(9)
    })
  })

  Scenario('Zero smoothing jumps straight to the goal', ({ Given, When, Then }) => {
    let value = 0
    Given('a camera moving from 0 to 10 with smoothing 0', () => {
      value = 0
    })
    When('a single frame of 16 milliseconds passes', () => {
      value = damp(value, 10, 0, 0.016)
    })
    Then('the position is 10', () => {
      expect(value).toBe(10)
    })
  })

  Scenario('Camera memory carries a pose across slides', ({ Given, When, Then, And }) => {
    const memory = createPoseMemory()
    let received: CameraPose | undefined
    Given('the scene "architecture" remembered a camera at 1, 2, 3', () => {
      memory.remember('architecture', { position: [1, 2, 3], target: [0, 0, 0] })
    })
    When('a new slide asks for the pose of "architecture"', () => {
      received = memory.recall('architecture')
    })
    Then('it receives a camera at 1, 2, 3', () => {
      expect(received?.position).toEqual([1, 2, 3])
    })
    And('changing the received pose does not change the memory', () => {
      received!.position[0] = 99
      expect(memory.recall('architecture')?.position).toEqual([1, 2, 3])
    })
  })
})
