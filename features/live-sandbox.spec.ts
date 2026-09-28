import type { VueWrapper } from '@vue/test-utils'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { mount } from '@vue/test-utils'
import { expect } from 'vitest'
import { h } from 'vue'
import DeyslideLiveSandbox from '../packages/components/components/DeyslideLiveSandbox.vue'

const feature = await loadFeature('./live-sandbox.feature')

describeFeature(feature, ({ Background, Scenario }) => {
  let wrapper: VueWrapper

  Background(({ Given }) => {
    Given('the live sandbox is mounted with debug off and count 1', () => {
      wrapper = mount(DeyslideLiveSandbox, {
        props: { initial: { debug: false, count: 1 }, step: 0.5 },
        slots: {
          default: ({ state }: { state: Record<string, unknown> }) =>
            h('p', { 'data-testid': 'slot' }, `debug is ${state.debug ? 'on' : 'off'}`),
        },
      })
    })
  })

  const switchFor = (key: string) => wrapper.get(`[data-testid="toggle-${key}"]`)
  const clickButton = (label: string) => wrapper.get(`[data-testid="sandbox-${label.toLowerCase()}"]`).trigger('click')

  Scenario('Flip a switch', ({ When, Then, And }) => {
    When('I click the "debug" switch', () => switchFor('debug').trigger('click'))
    Then('the "debug" switch is on', () => {
      expect(switchFor('debug').attributes('aria-checked')).toBe('true')
    })
    And('the inspector shows "debug": true', () => {
      expect(wrapper.get('[data-testid="sandbox-json"]').text()).toContain('"debug": true')
    })
    And('a change event reports "debug" going from false to true', () => {
      const [change] = wrapper.emitted('change')!.at(-1)!
      expect(change).toEqual({ key: 'debug', from: false, to: true })
    })
  })

  Scenario('Step a counter with the configured step', ({ When, Then }) => {
    When('I click the plus button for "count"', () => wrapper.get('[data-testid="inc-count"]').trigger('click'))
    Then('the "count" value reads 1.5', () => {
      expect(wrapper.get('[data-testid="value-count"]').text()).toBe('1.5')
    })
  })

  Scenario('Undo and reset from the header', ({ When, And, Then }) => {
    When('I click the plus button for "count"', () => wrapper.get('[data-testid="inc-count"]').trigger('click'))
    And('I click "Undo"', () => clickButton('Undo'))
    Then('the "count" value reads 1', () => {
      expect(wrapper.get('[data-testid="value-count"]').text()).toBe('1')
    })
    When('I click the "debug" switch', () => switchFor('debug').trigger('click'))
    And('I click "Reset"', () => clickButton('Reset'))
    Then('the "debug" switch is off', () => {
      expect(switchFor('debug').attributes('aria-checked')).toBe('false')
    })
  })

  Scenario('Slot content reads the live state', ({ Then, When }) => {
    Then('the slot shows "debug is off"', () => {
      expect(wrapper.get('[data-testid="slot"]').text()).toBe('debug is off')
    })
    When('I click the "debug" switch', () => switchFor('debug').trigger('click'))
    Then('the slot shows "debug is on"', () => {
      expect(wrapper.get('[data-testid="slot"]').text()).toBe('debug is on')
    })
  })
})
