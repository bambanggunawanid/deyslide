import type { MotionMode, MotionModeInput } from '../packages/components/src/scene3d/motion-mode'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { resolveMotionMode } from '../packages/components/src/scene3d/motion-mode'

const feature = await loadFeature('./motion-mode.feature')

describeFeature(feature, ({ ScenarioOutline }) => {
  ScenarioOutline('Choose the motion mode', ({ Given, And, When, Then }, variables) => {
    const input: MotionModeInput = { renderContext: '', isPrintMode: false, isSlideActive: false }
    let mode: MotionMode
    Given('the slide renders in the "<context>" context', () => {
      input.renderContext = variables.context
    })
    And('print mode is <print>', () => {
      input.isPrintMode = variables.print === 'true'
    })
    And('the slide active state is <active>', () => {
      input.isSlideActive = variables.active === 'true'
    })
    When('the motion mode is resolved', () => {
      mode = resolveMotionMode(input)
    })
    Then('the mode is "<mode>"', () => {
      expect(mode).toBe(variables.mode)
    })
  })
})
