import type { Deck, DeckCheck } from '../packages/deck-model/src'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import * as Y from 'yjs'
import {
  checkDeckDoc,
  deckMarkdown,
  deckToYDoc,
  deleteSlide,
  elementText,
  findElement,
  findSlide,
  moveElementInStack,
  moveSlide,
  readDeckDoc,
  repairDeckDoc,
} from '../packages/deck-model/src'

const feature = await loadFeature('./deck-repair.feature')

const pos = { x: 10, y: 10, w: 200, h: null, rotate: 0 }

function threeSlides(): Deck {
  return {
    version: 1,
    slides: [
      {
        id: 'a',
        frontmatter: {},
        elements: [
          { id: 'w', type: 'text', pos, markdown: 'Box w' },
          { id: 'x', type: 'text', pos, markdown: 'Box x' },
          { id: 'y', type: 'text', pos, markdown: 'Box y' },
        ],
      },
      { id: 'b', frontmatter: { layout: 'center' }, elements: [{ id: 'words', type: 'raw', markdown: 'Plain words' }] },
      { id: 'c', frontmatter: {}, elements: [], notes: 'The end.' },
    ],
  }
}

function sync(a: Y.Doc, b: Y.Doc) {
  const fromA = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b))
  const fromB = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a))
  Y.applyUpdate(b, fromA)
  Y.applyUpdate(a, fromB)
}

const slideIds = (doc: Y.Doc) => (doc.getMap('deck').get('slides') as Y.Array<Y.Map<unknown>>).map(slide => slide.get('id'))
const elementIds = (doc: Y.Doc, slideId: string) => (findSlide(doc, slideId)!.get('elements') as Y.Array<Y.Map<unknown>>).map(element => element.get('id'))
const failure = (check: DeckCheck) => check.ok ? 'passes' : check.message

describeFeature(feature, ({ Background, Scenario }) => {
  let ana: Y.Doc
  let budi: Y.Doc
  let changed: boolean
  let updates: unknown[]

  function listen() {
    updates = []
    ana.on('update', (_: Uint8Array, origin: unknown) => updates.push(origin))
  }

  function bothDelete() {
    deleteSlide(ana, 'a')
    deleteSlide(budi, 'b')
  }

  function onlyTwoSlides() {
    deleteSlide(ana, 'c')
    sync(ana, budi)
  }

  Background(({ Given }) => {
    Given('Ana and Budi each have a live document loaded from the same three slide deck', () => {
      ana = deckToYDoc(threeSlides())
      budi = new Y.Doc()
      Y.applyUpdate(budi, Y.encodeStateAsUpdate(ana))
    })
  })

  Scenario('Deleting both slides of a two slide deck at once leaves a deck that reads as one empty slide', ({ Given, When, And, Then }) => {
    Given('the deck has only the slides "a" and "b"', onlyTwoSlides)
    When('Ana deletes "a" and Budi deletes "b" at the same time', bothDelete)
    And('their documents sync', () => sync(ana, budi))
    Then('both documents read as one empty slide', () => {
      for (const doc of [ana, budi]) {
        expect(slideIds(doc)).toEqual([])
        expect(readDeckDoc(doc).slides).toEqual([{ id: 'slide-1', frontmatter: {}, elements: [] }])
      }
    })
    And('the check says the deck has too few slides', () => {
      expect(failure(checkDeckDoc(ana))).toMatch(/^slides: /)
    })
  })

  Scenario('Repair adds one slide after both slides were deleted', ({ Given, And, When, Then }) => {
    Given('the deck has only the slides "a" and "b"', onlyTwoSlides)
    And('Ana deletes "a" and Budi deletes "b" at the same time', bothDelete)
    And('their documents sync', () => sync(ana, budi))
    When('the server repairs Ana\'s document with the origin "server"', () => {
      listen()
      changed = repairDeckDoc(ana, 'server')
    })
    Then('the repair says it changed the deck, in one change with the origin "server"', () => {
      expect(changed).toBe(true)
      expect(updates).toEqual(['server'])
    })
    And('after syncing both documents have one empty slide with a new id', () => {
      sync(ana, budi)
      for (const doc of [ana, budi]) {
        const [slide, ...rest] = readDeckDoc(doc).slides
        expect(rest).toEqual([])
        expect(slide.id).toMatch(/^s-/)
        expect(slide).toMatchObject({ frontmatter: {}, elements: [] })
      }
    })
    And('the check passes', () => {
      expect(failure(checkDeckDoc(ana))).toBe('passes')
      expect(failure(checkDeckDoc(budi))).toBe('passes')
    })
  })

  Scenario('Repair removes the extra copy left when two people move the same slide', ({ When, And, Then }) => {
    When('Ana moves "a" to the end and Budi moves "a" to the middle at the same time', () => {
      moveSlide(ana, 'a', 2)
      moveSlide(budi, 'a', 1)
    })
    And('their documents sync', () => sync(ana, budi))
    Then('the slide "a" appears twice', () => {
      expect(slideIds(ana).filter(id => id === 'a')).toHaveLength(2)
    })
    And('the check says two slides have the same id', () => {
      expect(failure(checkDeckDoc(ana))).toMatch(/^Slide \d has the same id as another slide$/)
    })
    When('the server repairs Ana\'s document', () => {
      changed = repairDeckDoc(ana)
    })
    Then('the slide "a" appears once and the check passes', () => {
      expect(changed).toBe(true)
      expect(slideIds(ana).filter(id => id === 'a')).toHaveLength(1)
      expect([...slideIds(ana)].sort()).toEqual(['a', 'b', 'c'])
      expect(failure(checkDeckDoc(ana))).toBe('passes')
    })
  })

  Scenario('Repair gives a fresh id to a different slide with the same id', ({ Given, When, Then }) => {
    Given('Ana\'s document has a second, different slide with the id "b"', () => {
      const slide = new Y.Map<unknown>()
      slide.set('id', 'b')
      slide.set('frontmatter', {})
      slide.set('notes', new Y.Text('Another slide'))
      slide.set('elements', new Y.Array())
      ;(ana.getMap('deck').get('slides') as Y.Array<Y.Map<unknown>>).push([slide])
    })
    When('the server repairs Ana\'s document', () => {
      changed = repairDeckDoc(ana)
    })
    Then('the first "b" keeps its id and the other one has a new id with the same content', () => {
      const slides = readDeckDoc(ana).slides
      expect(slides.map(slide => slide.id).slice(0, 3)).toEqual(['a', 'b', 'c'])
      expect(slides[1].elements).toEqual(threeSlides().slides[1].elements)
      expect(slides[3].id).toMatch(/^s-/)
      expect(slides[3]).toMatchObject({ frontmatter: {}, elements: [], notes: 'Another slide' })
      expect(failure(checkDeckDoc(ana))).toBe('passes')
    })
  })

  Scenario('Repair removes the extra copy left when two people restack the same box', ({ When, And, Then }) => {
    When('Ana moves the box "x" to the top of the stack and Budi moves it to the bottom at the same time', () => {
      moveElementInStack(ana, 'a', 'x', 2)
      moveElementInStack(budi, 'a', 'x', 0)
    })
    And('their documents sync', () => sync(ana, budi))
    Then('the box "x" appears twice on slide "a"', () => {
      expect(elementIds(ana, 'a').filter(id => id === 'x')).toHaveLength(2)
      expect(failure(checkDeckDoc(ana))).toBe('Slide 1 has two elements with the id "x"')
    })
    When('the server repairs Ana\'s document', () => {
      changed = repairDeckDoc(ana)
    })
    Then('the box "x" appears once on slide "a" and the check passes', () => {
      expect(changed).toBe(true)
      expect([...elementIds(ana, 'a')].sort()).toEqual(['w', 'x', 'y'])
      expect(failure(checkDeckDoc(ana))).toBe('passes')
    })
  })

  Scenario('A box with a negative width is clamped', ({ Given, Then, When, And }) => {
    Given('an older client set the width of the box "x" to -40', () => {
      (findElement(ana, 'a', 'x')!.get('pos') as Y.Map<number>).set('w', -40)
    })
    Then('reading the deck leaves the box "x" out and the check fails at its width', () => {
      expect(readDeckDoc(ana).slides[0].elements.map(element => element.id)).toEqual(['w', 'y'])
      expect(failure(checkDeckDoc(ana))).toMatch(/^slides\.0\.elements\.1\.pos\.w: /)
    })
    When('the server repairs Ana\'s document', () => {
      changed = repairDeckDoc(ana)
    })
    Then('the box "x" has a width of 0 and is read again', () => {
      expect(changed).toBe(true)
      expect(readDeckDoc(ana).slides[0].elements[1]).toEqual({ id: 'x', type: 'text', pos: { ...pos, w: 0 }, markdown: 'Box x' })
    })
    And('the check passes', () => {
      expect(failure(checkDeckDoc(ana))).toBe('passes')
    })
  })

  Scenario('A box that cannot be fixed is removed', ({ Given, Then, When }) => {
    Given('Ana\'s document has a box "clip" of the unknown type "video" on slide "b"', () => {
      const clip = new Y.Map<unknown>()
      clip.set('id', 'clip')
      clip.set('type', 'video')
      clip.set('src', 'https://example.com/clip.mp4')
      ;(findSlide(ana, 'b')!.get('elements') as Y.Array<Y.Map<unknown>>).push([clip])
    })
    Then('reading the deck leaves the box "clip" out', () => {
      expect(readDeckDoc(ana).slides[1].elements.map(element => element.id)).toEqual(['words'])
      expect(failure(checkDeckDoc(ana))).not.toBe('passes')
    })
    When('the server repairs Ana\'s document', () => {
      changed = repairDeckDoc(ana)
    })
    Then('the slide "b" no longer holds the box "clip" and the check passes', () => {
      expect(changed).toBe(true)
      expect(elementIds(ana, 'b')).toEqual(['words'])
      expect(failure(checkDeckDoc(ana))).toBe('passes')
    })
  })

  Scenario('A text box stored without a shared text gets one back', ({ Given, Then, When }) => {
    Given('the text of the box "x" was stored as plain text', () => {
      findElement(ana, 'a', 'x')!.set('markdown', 'Box x')
    })
    Then('the check says the box "x" is not stored the right way', () => {
      expect(failure(checkDeckDoc(ana))).toBe('Slide 1, element 2 is not stored the right way')
    })
    When('the server repairs Ana\'s document', () => {
      changed = repairDeckDoc(ana)
    })
    Then('the box "x" has a shared text with the same words and the check passes', () => {
      expect(changed).toBe(true)
      expect(elementText(ana, 'a', 'x').toString()).toBe('Box x')
      expect(failure(checkDeckDoc(ana))).toBe('passes')
    })
  })

  Scenario('Frontmatter a peer stored with a value YAML cannot write is cleaned up', ({ Given, And, Then, When }) => {
    Given('Budi stored the frontmatter of slide "b" as layout "center" and a count held as a BigInt', () => {
      findSlide(budi, 'b')!.set('frontmatter', { layout: 'center', count: 3n })
    })
    And('their documents sync', () => sync(ana, budi))
    Then('reading Ana\'s document shows slide "b" with layout "center" only, and its Markdown can be written', () => {
      expect(readDeckDoc(ana).slides[1].frontmatter).toEqual({ layout: 'center' })
      expect(deckMarkdown(ana)).toContain('---\nlayout: center\n---\n\nPlain words')
    })
    And('the check fails at the frontmatter of slide "b"', () => {
      expect(failure(checkDeckDoc(ana))).toBe('slides.1.frontmatter: Frontmatter can only hold text, numbers, true or false, null, lists and maps')
    })
    When('the server repairs Ana\'s document', () => {
      changed = repairDeckDoc(ana)
    })
    Then('slide "b" has the frontmatter layout "center" and the check passes', () => {
      expect(changed).toBe(true)
      // The repair stores the frontmatter one key at a time, as every change does.
      expect(readDeckDoc(ana).slides[1].frontmatter).toEqual({ layout: 'center' })
      expect([...(findSlide(ana, 'b')!.get('frontmatter') as Y.Map<unknown>).keys()]).toEqual(['layout'])
      expect(failure(checkDeckDoc(ana))).toBe('passes')
    })
  })

  Scenario('A slides list that a peer replaced with something else is rebuilt', ({ Given, And, Then, When }) => {
    Given('Budi replaced the list of slides with a plain text', () => {
      budi.getMap('deck').set('slides', 'oops')
    })
    And('their documents sync', () => sync(ana, budi))
    Then('reading Ana\'s document shows one empty slide', () => {
      expect(readDeckDoc(ana).slides).toEqual([{ id: 'slide-1', frontmatter: {}, elements: [] }])
    })
    And('the check says "The deck has no list of slides"', () => {
      expect(checkDeckDoc(ana)).toEqual({ ok: false, message: 'The deck has no list of slides' })
    })
    When('the server repairs Ana\'s document', () => {
      changed = repairDeckDoc(ana)
    })
    Then('Ana\'s document has one empty slide with a new id and the check passes', () => {
      expect(changed).toBe(true)
      const [slide, ...rest] = readDeckDoc(ana).slides
      expect(rest).toEqual([])
      expect(slide.id).toMatch(/^s-/)
      expect(slide).toMatchObject({ frontmatter: {}, elements: [] })
      expect(failure(checkDeckDoc(ana))).toBe('passes')
    })
  })

  Scenario('A healthy deck needs no repair', ({ When, Then, And }) => {
    When('the server repairs Ana\'s document', () => {
      listen()
      changed = repairDeckDoc(ana)
    })
    Then('the repair says it changed nothing and the document did not change', () => {
      expect(changed).toBe(false)
      expect(updates).toEqual([])
    })
    And('the check passes', () => {
      const check = checkDeckDoc(ana)
      expect(check).toEqual({ ok: true, deck: threeSlides() })
    })
  })

  Scenario('A document without a deck cannot be read or repaired', ({ Given, Then, And }) => {
    let empty: Y.Doc
    Given('a live document that has not loaded its deck', () => {
      empty = new Y.Doc()
    })
    Then('reading it fails with "The deck is not loaded yet"', () => {
      expect(() => readDeckDoc(empty)).toThrow('The deck is not loaded yet')
    })
    And('the check says "The deck is not loaded yet"', () => {
      expect(checkDeckDoc(empty)).toEqual({ ok: false, message: 'The deck is not loaded yet' })
    })
    And('repairing it fails with "The deck is not loaded yet"', () => {
      expect(() => repairDeckDoc(empty)).toThrow('The deck is not loaded yet')
    })
  })
})
