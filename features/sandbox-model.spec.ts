import type { SandboxModel, SandboxState } from '../src/sandbox/sandbox'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { createSandboxModel } from '../src/sandbox/sandbox'

const feature = await loadFeature('./sandbox-model.feature')

const STARTING: SandboxState = { debug: false, retries: 2, name: 'demo' }

describeFeature(feature, ({ Background, Scenario }) => {
  let model: SandboxModel
  let error: unknown

  Background(({ Given }) => {
    Given('a sandbox with debug off, retries 2 and name "demo"', () => {
      model = createSandboxModel(STARTING)
      error = undefined
    })
  })

  Scenario('Toggle a boolean', ({ When, Then, And }) => {
    When('I toggle "debug"', () => model.toggle('debug'))
    Then('"debug" is true', () => expect(model.state.debug).toBe(true))
    And('the history has 1 change', () => expect(model.history).toHaveLength(1))
  })

  Scenario('Step a number', ({ When, Then }) => {
    When('I step "retries" by 3', () => model.step('retries', 3))
    Then('"retries" is 5', () => expect(model.state.retries).toBe(5))
  })

  Scenario('Undo the last change', ({ When, And, Then }) => {
    When('I step "retries" by 3', () => model.step('retries', 3))
    And('I undo', () => model.undo())
    Then('"retries" is 2', () => expect(model.state.retries).toBe(2))
    And('the history is empty', () => expect(model.history).toHaveLength(0))
  })

  Scenario('Reset returns to the starting state', ({ When, And, Then }) => {
    When('I toggle "debug"', () => model.toggle('debug'))
    And('I set "name" to "live"', () => model.set('name', 'live'))
    And('I reset', () => model.reset())
    Then('the snapshot equals the starting state', () => {
      expect(JSON.parse(model.snapshot())).toEqual(STARTING)
    })
    And('the history is empty', () => expect(model.history).toHaveLength(0))
  })

  Scenario('Wrong types are rejected', ({ When, Then, And }) => {
    When('I try to toggle "retries"', () => {
      try {
        model.toggle('retries')
      }
      catch (caught) {
        error = caught
      }
    })
    Then('the sandbox refuses with "is not a boolean"', () => {
      expect(String(error)).toContain('is not a boolean')
    })
    And('"retries" is 2', () => expect(model.state.retries).toBe(2))
  })

  Scenario('Unknown keys are rejected', ({ When, Then }) => {
    When('I try to set "color" to "red"', () => {
      try {
        model.set('color', 'red')
      }
      catch (caught) {
        error = caught
      }
    })
    Then('the sandbox refuses with "Unknown sandbox key"', () => {
      expect(String(error)).toContain('Unknown sandbox key')
    })
  })

  Scenario('Setting the same value records nothing', ({ When, Then }) => {
    When('I set "name" to "demo"', () => model.set('name', 'demo'))
    Then('the history is empty', () => expect(model.history).toHaveLength(0))
  })

  Scenario('History keeps only the newest changes', ({ Given, When, Then, And }) => {
    Given('the history limit is 3', () => {
      model = createSandboxModel(STARTING, { historyLimit: 3 })
    })
    When('I step "retries" by 1 five times', () => {
      for (let i = 0; i < 5; i++)
        model.step('retries', 1)
    })
    Then('the history has 3 changes', () => expect(model.history).toHaveLength(3))
    And('the oldest change goes from 4 to 5', () => {
      expect(model.history[0]).toEqual({ key: 'retries', from: 4, to: 5 })
    })
  })
})
