import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { vueOptions } from '../packages/components/src/compiler-options'

const feature = await loadFeature('./compiler-options.feature')

describeFeature(feature, ({ ScenarioOutline }) => {
  ScenarioOutline('Classify a template tag', ({ Given, When, Then }, variables) => {
    let classify: (tag: string) => boolean
    let result: boolean
    Given('the Deyslide Vue compiler options', () => {
      classify = vueOptions.template.compilerOptions.isCustomElement
    })
    When('Vue meets the tag "<tag>"', () => {
      result = classify(variables.tag)
    })
    Then('it is treated as a custom element: <custom>', () => {
      expect(result).toBe(variables.custom === 'true')
    })
  })
})
