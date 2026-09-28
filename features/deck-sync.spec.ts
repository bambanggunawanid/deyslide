import type { Deck } from '../packages/deck-model/src'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import * as Y from 'yjs'
import { deckToYDoc, elementText, findSlide, moveElement, toMarkdown, yDocToDeck } from '../packages/deck-model/src'
import { sampleDeck } from './support/decks'

const feature = await loadFeature('./deck-sync.feature')

/** Two replicas of one document, as two browsers would hold after loading it. */
function twoReplicas() {
  const origin = deckToYDoc(sampleDeck())
  const state = Y.encodeStateAsUpdate(origin)
  const ana = new Y.Doc()
  const budi = new Y.Doc()
  Y.applyUpdate(ana, state)
  Y.applyUpdate(budi, state)
  return { ana, budi }
}

function sync(a: Y.Doc, b: Y.Doc) {
  const fromA = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b))
  const fromB = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a))
  Y.applyUpdate(b, fromA)
  Y.applyUpdate(a, fromB)
}

const title = (doc: Y.Doc) => yDocToDeck(doc).slides[0].elements[0]

describeFeature(feature, ({ Scenario }) => {
  Scenario('A deck survives a round trip through the live document', ({ Given, When, Then }) => {
    let deck: Deck
    let result: Deck
    Given('a deck with every element type', () => {
      deck = sampleDeck()
    })
    When('it is loaded into a live document and read back', () => {
      result = yDocToDeck(deckToYDoc(deck))
    })
    Then('the result equals the original deck', () => {
      expect(result).toEqual(deck)
    })
  })

  Scenario('One person moves a text box while another edits its text', ({ Given, When, And, Then }) => {
    let ana: Y.Doc
    let budi: Y.Doc
    Given('Ana and Budi each have a live document loaded from the same deck', () => {
      ({ ana, budi } = twoReplicas())
    })
    When('Ana moves the title to x 300 y 200', () => {
      moveElement(ana, 'intro', 'title', { x: 300, y: 200 })
    })
    And('Budi appends " and Trees" to the title text at the same time', () => {
      const text = elementText(budi, 'intro', 'title')
      text.insert(text.length, ' and Trees')
    })
    And('their documents sync', () => sync(ana, budi))
    Then('both documents have the title at x 300 y 200', () => {
      for (const doc of [ana, budi])
        expect(title(doc)).toMatchObject({ pos: { x: 300, y: 200 } })
    })
    And('both documents have the title text "# Intro to Graphs and Trees"', () => {
      for (const doc of [ana, budi])
        expect(title(doc)).toMatchObject({ markdown: '# Intro to Graphs and Trees' })
    })
  })

  Scenario('Two people move the same box on different axes', ({ Given, When, And, Then }) => {
    let ana: Y.Doc
    let budi: Y.Doc
    Given('Ana and Budi each have a live document loaded from the same deck', () => {
      ({ ana, budi } = twoReplicas())
    })
    When('Ana changes the title width to 700', () => {
      moveElement(ana, 'intro', 'title', { w: 700 })
    })
    And('Budi rotates the title by 10 degrees at the same time', () => {
      moveElement(budi, 'intro', 'title', { rotate: 10 })
    })
    And('their documents sync', () => sync(ana, budi))
    Then('both documents have the title with width 700 and rotation 10', () => {
      for (const doc of [ana, budi])
        expect(title(doc)).toMatchObject({ pos: { w: 700, rotate: 10 } })
    })
  })

  Scenario('Both people type in the same text box', ({ Given, When, And, Then }) => {
    let ana: Y.Doc
    let budi: Y.Doc
    const notes = (doc: Y.Doc) => findSlide(doc, 'intro')!.get('notes') as Y.Text
    Given('Ana and Budi each have a live document loaded from the same deck', () => {
      ({ ana, budi } = twoReplicas())
    })
    When('Ana types "Hello " at the start of the speaker notes on slide 1', () => {
      notes(ana).insert(0, 'Hello ')
    })
    And('Budi types " Thanks!" at the end of the same notes at the same time', () => {
      const text = notes(budi)
      text.insert(text.length, ' Thanks!')
    })
    And('their documents sync', () => sync(ana, budi))
    Then('both documents have the notes "Hello Welcome everyone. Thanks!"', () => {
      for (const doc of [ana, budi])
        expect(yDocToDeck(doc).slides[0].notes).toBe('Hello Welcome everyone. Thanks!')
    })
  })

  Scenario('The live document converts to the same Markdown as the deck', ({ Given, When, Then }) => {
    let fromDoc: string
    Given('a deck with every element type', () => {})
    When('it is loaded into a live document and written as Markdown', () => {
      fromDoc = toMarkdown(yDocToDeck(deckToYDoc(sampleDeck())))
    })
    Then('the Markdown equals the Markdown written straight from the deck', () => {
      expect(fromDoc).toBe(toMarkdown(sampleDeck()))
    })
  })
})
