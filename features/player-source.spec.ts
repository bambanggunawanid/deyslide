import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { resolvePlayerSrc } from '../src/algo-player/controller'

const feature = await loadFeature('./player-source.feature')

describeFeature(feature, ({ ScenarioOutline }) => {
  ScenarioOutline('Resolve the player source', ({ Given, When, Then }, variables) => {
    let base: string
    let page: string
    let url: string
    Given('the deck is served from "<base>" on "<page>"', () => {
      base = variables.base
      page = variables.page
    })
    When('the player source is "<src>"', () => {
      url = resolvePlayerSrc(variables.src, base, page)
    })
    Then('the player imports "<url>"', () => {
      expect(url).toBe(variables.url)
    })
  })
})
