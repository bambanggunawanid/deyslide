import type { VueWrapper } from '@vue/test-utils'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { mount } from '@vue/test-utils'
import { expect } from 'vitest'
import DeyslideShape from '../packages/components/components/DeyslideShape.vue'

const feature = await loadFeature('./shape.feature')

describeFeature(feature, ({ ScenarioOutline }) => {
  ScenarioOutline('Draw a shape', ({ Given, When, Then, And }, variables) => {
    let props: { shape: 'rect' | 'ellipse', fill: string, stroke: string, strokeWidth: number }
    let wrapper: VueWrapper
    const style = () => (wrapper.element as HTMLElement).style

    Given('a <shape> shape filled with "<fill>" and a <width> pixel "<stroke>" border', () => {
      props = { shape: variables.shape as 'rect' | 'ellipse', fill: variables.fill, stroke: variables.stroke, strokeWidth: Number(variables.width) }
    })
    When('it is rendered', () => {
      wrapper = mount(DeyslideShape, { props })
    })
    Then('its background is "<fill>"', () => {
      expect(wrapper.attributes('style')).toContain(`background: ${variables.fill}`)
    })
    And('its corner radius is "<radius>"', () => {
      expect(style().borderRadius).toBe(variables.radius)
    })
    And('its border is "<border>"', () => {
      expect(wrapper.attributes('style')).toContain(`border: ${variables.border}`)
    })
  })
})
