import type { Deck } from '../packages/deck-model/src'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { safeParseDeck } from '../packages/deck-model/src'
import { sampleDeck } from './support/decks'

const feature = await loadFeature('./deck-schema.feature')

type Mutable = Record<string, any>

const CHANGES: Record<string, (deck: Mutable) => void> = {
  'the deck has no slides': (deck) => { deck.slides = [] },
  'the title has a negative width': (deck) => { deck.slides[0].elements[0].pos.w = -1 },
  'the 3D scene has an unknown prop "color"': (deck) => { deck.slides[0].elements[1].props.color = 'red' },
  'the image has an empty src': (deck) => { deck.slides[1].elements[0].src = '' },
  'the code block has no steps': (deck) => { deck.slides[1].elements[2].steps = [] },
  'an element has the unknown type "video"': (deck) => { deck.slides[0].elements[0].type = 'video' },
  'a Magic Move step has a line starting with a fence': (deck) => { deck.slides[1].elements[2].steps[1].code = 'a\n```\nb' },
}

describeFeature(feature, ({ Scenario, ScenarioOutline }) => {
  let deck: Deck
  let result: ReturnType<typeof safeParseDeck>

  Scenario('A complete deck is accepted', ({ Given, When, Then }) => {
    Given('a deck with every element type', () => {
      deck = sampleDeck()
    })
    When('it is validated', () => {
      result = safeParseDeck(deck)
    })
    Then('it is accepted', () => {
      expect(result.success).toBe(true)
    })
  })

  ScenarioOutline('A broken deck is rejected', ({ Given, And, When, Then }, variables) => {
    Given('a deck with every element type', () => {
      deck = sampleDeck()
    })
    And('<change>', () => {
      CHANGES[variables.change](deck as unknown as Mutable)
    })
    When('it is validated', () => {
      result = safeParseDeck(deck)
    })
    Then('it is rejected at "<path>"', () => {
      expect(result.success).toBe(false)
      const paths = result.error!.issues.map(issue => issue.path.join('.'))
      expect(paths).toContain(variables.path)
    })
  })
})
