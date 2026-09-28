import type { Vec3 } from '../src/scene3d/camera'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { ARCHITECTURE_LINKS, ARCHITECTURE_NODES, findNode, linkEndpoints, resolveFocusTarget } from '../src/scene3d/architecture'

const feature = await loadFeature('./architecture.feature')

describeFeature(feature, ({ Scenario }) => {
  Scenario('Focus on a known node', ({ Given, When, Then }) => {
    let target: Vec3
    Given('the placeholder architecture', () => {
      expect(ARCHITECTURE_NODES.length).toBeGreaterThan(0)
    })
    When('I focus on "database"', () => {
      target = resolveFocusTarget('database', undefined)
    })
    Then('the camera target is the middle of the database block', () => {
      const database = findNode('database')!
      expect(target).toEqual([database.position[0], database.size[1] / 2, database.position[2]])
    })
  })

  Scenario('Unknown focus falls back to the explicit target', ({ Given, When, Then }) => {
    let target: Vec3
    Given('the placeholder architecture', () => {})
    When('I focus on "billing" with a fallback target of 1, 1, 1', () => {
      target = resolveFocusTarget('billing', [1, 1, 1])
    })
    Then('the camera target is 1, 1, 1', () => {
      expect(target).toEqual([1, 1, 1])
    })
  })

  Scenario('No focus and no target looks at the origin', ({ Given, When, Then }) => {
    let target: Vec3
    Given('the placeholder architecture', () => {})
    When('I do not focus on anything', () => {
      target = resolveFocusTarget(undefined, undefined)
    })
    Then('the camera target is 0, 0, 0', () => {
      expect(target).toEqual([0, 0, 0])
    })
  })

  Scenario('Every link connects two existing nodes', ({ Given, Then }) => {
    Given('the placeholder architecture', () => {})
    Then('every link has two endpoints', () => {
      for (const link of ARCHITECTURE_LINKS)
        expect(linkEndpoints(link), `${link.from} to ${link.to}`).toBeDefined()
    })
  })
})
