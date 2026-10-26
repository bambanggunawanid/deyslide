import type { Deck, DeckElement, Slide } from '../packages/deck-model/src'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import * as Y from 'yjs'
import {
  checkDeckDoc,
  deckMarkdown,
  deckToYDoc,
  findElement,
  findSlide,
  fromMarkdown,
  mergeMarkdown,
  moveSlide,
  readDeckDoc,
  repairDeckDoc,
  setFrontmatter,
  slideMarkdowns,
  toMarkdown,
  updateElement,
  upgradeDeckDoc,
  yDocToDeck,
} from '../packages/deck-model/src'
import demoMarkdown from '../apps/deck/slides.md?raw'
import { sampleDeck } from './support/decks'
import { legacyDoc } from './support/legacy-deck'

const feature = await loadFeature('./deck-settings.feature')

/** The sample deck, with the box on "details" as a rectangle. */
function shapesDeck(): Deck {
  const deck = sampleDeck()
  const box = deck.slides[1].elements.find(element => element.id === 'box') as Extract<DeckElement, { type: 'shape' }>
  box.props = { shape: 'rect', fill: '#f472b6' }
  return deck
}

/**
 * The deck in two documents with set client ids. When both write the same
 * field at once, Yjs keeps the write of the higher id, here Ana's: a value
 * she wrote back unchanged would undo Budi's change every time.
 */
function openedInOrder(): [Y.Doc, Y.Doc] {
  const first = new Y.Doc()
  first.clientID = 2
  deckToYDoc(shapesDeck(), first)
  const second = new Y.Doc()
  second.clientID = 1
  Y.applyUpdate(second, Y.encodeStateAsUpdate(first))
  return [first, second]
}

function sync(a: Y.Doc, b: Y.Doc) {
  const fromA = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b))
  const fromB = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a))
  Y.applyUpdate(b, fromA)
  Y.applyUpdate(a, fromB)
}

function copyOf(doc: Y.Doc) {
  const copy = new Y.Doc()
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
  return copy
}

const slideOf = (doc: Y.Doc, id: string): Slide => readDeckDoc(doc).slides.find(slide => slide.id === id)!
const elementOf = (doc: Y.Doc, slideId: string, id: string) => slideOf(doc, slideId).elements.find(element => element.id === id)!
const props = (doc: Y.Doc, slideId: string, id: string) => (elementOf(doc, slideId, id) as Extract<DeckElement, { props: unknown }>).props as Record<string, unknown>
const setProps = (doc: Y.Doc, slideId: string, id: string, change: Record<string, unknown>) =>
  updateElement(doc, slideId, id, { props: { ...props(doc, slideId, id), ...change } })
const setKeys = (doc: Y.Doc, slideId: string, change: Record<string, unknown>) =>
  setFrontmatter(doc, slideId, { ...slideOf(doc, slideId).frontmatter, ...change })
/** The frontmatter keys of a slide's Markdown, in the order they are written. */
const markdownKeys = (doc: Y.Doc, slideId: string) => {
  const markdown = slideMarkdowns(doc).find(slide => slide.id === slideId)!.markdown
  const yaml = markdown.split('---\n')[1] ?? ''
  return [...yaml.matchAll(/^(\w+):/gm)].map(match => match[1])
}
const slideMarkdown = (doc: Y.Doc, slideId: string) => slideMarkdowns(doc).find(slide => slide.id === slideId)!.markdown

describeFeature(feature, ({ Background, Scenario }) => {
  let ana: Y.Doc
  let budi: Y.Doc

  Background(({ Given }) => {
    Given('Ana and Budi have the same deck open', () => {
      ana = deckToYDoc(shapesDeck())
      budi = copyOf(ana)
    })
  })

  Scenario('Two people change different settings of one shape', ({ When, And, Then }) => {
    When('Ana changes a rectangle\'s fill and Budi changes its stroke at the same time', () => {
      setProps(ana, 'details', 'box', { fill: '#22d3ee' })
      setProps(budi, 'details', 'box', { stroke: '#0f172a' })
    })
    And('their documents sync', () => sync(ana, budi))
    Then('the rectangle has Ana\'s fill and Budi\'s stroke for both of them', () => {
      for (const doc of [ana, budi])
        expect(props(doc, 'details', 'box')).toEqual({ shape: 'rect', fill: '#22d3ee', stroke: '#0f172a' })
      expect(deckMarkdown(budi)).toBe(deckMarkdown(ana))
    })
  })

  Scenario('Two people change different settings of a 3D scene through the canvas and through Markdown', ({ When, And, Then }) => {
    let base: Uint8Array
    let markdown: string
    When('Ana changes the 3D scene\'s zoom in the canvas', () => {
      base = Y.encodeStateAsUpdate(ana)
      markdown = deckMarkdown(ana)
      setProps(ana, 'intro', 'db-scene', { zoomLevel: 3 })
    })
    And('Claude writes Markdown, read before Ana\'s change, that moves the 3D scene\'s camera', () => {
      expect(markdown).toContain('[8,6,-7]')
      mergeMarkdown(budi, base, markdown.replace('[8,6,-7]', '[1,2,3]'), 'claude')
    })
    And('their documents sync', () => sync(ana, budi))
    Then('the 3D scene has Ana\'s zoom and Claude\'s camera for both of them', () => {
      for (const doc of [ana, budi])
        expect(props(doc, 'intro', 'db-scene')).toEqual({ cameraPosition: [1, 2, 3], focus: 'database', zoomLevel: 3 })
    })
  })

  Scenario('Changing the layout and the transition at the same time keeps both', ({ When, And, Then }) => {
    When('Ana changes the layout of slide "details" and Budi adds a transition to it at the same time', () => {
      setKeys(ana, 'details', { layout: 'center' })
      setKeys(budi, 'details', { transition: 'fade' })
    })
    And('their documents sync', () => sync(ana, budi))
    Then('slide "details" has Ana\'s layout and Budi\'s transition for both of them', () => {
      for (const doc of [ana, budi])
        expect(slideOf(doc, 'details').frontmatter).toEqual({ layout: 'center', transition: 'fade' })
    })
    And('both write the same Markdown for it', () => {
      expect(slideMarkdown(ana, 'details')).toContain('layout: center\ntransition: fade\n')
      expect(slideMarkdown(budi, 'details')).toBe(slideMarkdown(ana, 'details'))
    })
  })

  Scenario('Only the settings that changed are written, and removed ones are deleted', ({ When, Then, And }) => {
    const changes: Record<string, string>[] = []
    When('the shape "box" is updated with an outline width and without its fill', () => {
      const map = findElement(ana, 'details', 'box')!.get('props') as Y.Map<unknown>
      map.observe(event => changes.push(Object.fromEntries([...event.changes.keys].map(([key, change]) => [key, change.action]))))
      updateElement(ana, 'details', 'box', { props: { shape: 'rect', strokeWidth: 4 } })
    })
    Then('the change wrote only the outline width and the removal of the fill', () => {
      expect(changes).toEqual([{ strokeWidth: 'add', fill: 'delete' }])
    })
    And('the shape "box" reads as a rectangle with that outline width and no fill', () => {
      expect(props(ana, 'details', 'box')).toEqual({ shape: 'rect', strokeWidth: 4 })
    })
  })

  Scenario('Frontmatter keeps the order it is written in', ({ When, Then, And }) => {
    When('the frontmatter of "intro" gets a key "class" first and a key "info" after "theme"', () => {
      setFrontmatter(ana, 'intro', { class: 'text-left', theme: 'default', info: 'Graphs', title: 'Intro to Graphs', layout: 'cover' })
    })
    Then('the Markdown of "intro" lists class, theme, info, title and layout in that order', () => {
      expect(markdownKeys(ana, 'intro')).toEqual(['class', 'theme', 'info', 'title', 'layout'])
      expect(Object.keys(slideOf(ana, 'intro').frontmatter)).toEqual(['class', 'theme', 'info', 'title', 'layout'])
    })
    And('Budi\'s copy writes the same Markdown once the documents sync', () => {
      sync(ana, budi)
      expect(deckMarkdown(budi)).toBe(deckMarkdown(ana))
      expect(deckMarkdown(copyOf(ana))).toBe(deckMarkdown(ana))
    })
    When('the frontmatter of "intro" is written with layout first', () => {
      setFrontmatter(ana, 'intro', { layout: 'cover', class: 'text-left', theme: 'default', info: 'Graphs', title: 'Intro to Graphs' })
    })
    Then('the Markdown of "intro" lists layout, class, theme, info and title in that order', () => {
      expect(markdownKeys(ana, 'intro')).toEqual(['layout', 'class', 'theme', 'info', 'title'])
      sync(ana, budi)
      expect(deckMarkdown(budi)).toBe(deckMarkdown(ana))
    })
  })

  Scenario('Two people adding frontmatter keys at once write the same Markdown', ({ When, And, Then }) => {
    When('Ana adds the key "class" and Budi adds the key "clicks" to slide "details" at the same time', () => {
      setKeys(ana, 'details', { class: 'text-left' })
      setKeys(budi, 'details', { clicks: 2 })
    })
    And('their documents sync', () => sync(ana, budi))
    Then('slide "details" has the keys layout, class and clicks for both of them, in the same order', () => {
      for (const doc of [ana, budi]) {
        expect(slideOf(doc, 'details').frontmatter).toEqual({ layout: 'default', class: 'text-left', clicks: 2 })
        expect(markdownKeys(doc, 'details')).toEqual(['layout', 'class', 'clicks'])
      }
      expect(deckMarkdown(budi)).toBe(deckMarkdown(ana))
    })
  })

  Scenario('Two people who added keys at once still keep their later changes to different keys', ({ When, And, Then }) => {
    When('Ana adds the key "class" and Budi adds the key "clicks" to slide "details" at the same time', () => {
      [ana, budi] = openedInOrder()
      setKeys(ana, 'details', { class: 'text-left' })
      setKeys(budi, 'details', { clicks: 2 })
    })
    And('their documents sync', () => sync(ana, budi))
    And('Ana changes the layout of slide "details" while Budi changes its clicks to 5', () => {
      setKeys(ana, 'details', { layout: 'center' })
      setKeys(budi, 'details', { clicks: 5 })
    })
    And('their documents sync once more', () => sync(ana, budi))
    Then('slide "details" has Ana\'s layout and Budi\'s clicks for both of them', () => {
      for (const doc of [ana, budi]) {
        expect(slideOf(doc, 'details').frontmatter).toEqual({ layout: 'center', class: 'text-left', clicks: 5 })
        expect(markdownKeys(doc, 'details')).toEqual(['layout', 'class', 'clicks'])
      }
    })
  })

  Scenario('Moving frontmatter keys at the same time as a change to one of them keeps both', ({ When, And, Then }) => {
    let base: Uint8Array
    let markdown: string
    When('Ana changes the layout of slide "intro" in the canvas', () => {
      [ana, budi] = openedInOrder()
      base = Y.encodeStateAsUpdate(ana)
      markdown = deckMarkdown(ana)
      setKeys(ana, 'intro', { layout: 'center' })
    })
    And('Claude writes Markdown, read before Ana\'s change, that lists the layout first and adds a transition', () => {
      const before = '---\ntheme: default\ntitle: Intro to Graphs\nlayout: cover\n---\n'
      expect(markdown.startsWith(before)).toBe(true)
      mergeMarkdown(budi, base, `---\nlayout: cover\ntheme: default\ntitle: Intro to Graphs\ntransition: fade\n---\n${markdown.slice(before.length)}`, 'claude')
    })
    And('their documents sync', () => sync(ana, budi))
    Then('slide "intro" has Ana\'s layout and Claude\'s transition, with the layout first, for both of them', () => {
      for (const doc of [ana, budi]) {
        expect(slideOf(doc, 'intro').frontmatter).toEqual({ layout: 'center', theme: 'default', title: 'Intro to Graphs', transition: 'fade' })
        expect(markdownKeys(doc, 'intro')).toEqual(['layout', 'theme', 'title', 'transition'])
      }
      expect(deckMarkdown(budi)).toBe(deckMarkdown(ana))
    })
  })

  Scenario('Moving frontmatter keys writes only their places', ({ When, Then }) => {
    const changes: string[] = []
    When('the frontmatter of "intro" is written with layout first', () => {
      const map = findSlide(ana, 'intro')!.get('frontmatter') as Y.Map<unknown>
      map.observeDeep((events) => {
        for (const event of events) {
          const where = event.target === map ? 'keys' : 'fields'
          for (const [key, change] of event.changes.keys)
            changes.push(`${where} ${key} ${change.action}`)
        }
      })
      setFrontmatter(ana, 'intro', { layout: 'cover', theme: 'default', title: 'Intro to Graphs' })
      expect(markdownKeys(ana, 'intro')).toEqual(['layout', 'theme', 'title'])
    })
    Then('the change wrote only the order of the keys, and no value', () => {
      expect(changes.sort()).toEqual(['fields order update', 'fields order update', 'fields order update'])
    })
  })

  Scenario('An older deck keeps working', ({ Given, Then, When, And }) => {
    let before: Deck
    Given('a deck stored before settings were split', () => {
      ana = legacyDoc(shapesDeck())
    })
    Then('it reads as before and writes the same Markdown', () => {
      before = readDeckDoc(ana)
      expect(before).toEqual(shapesDeck())
      expect(yDocToDeck(ana)).toEqual(shapesDeck())
      expect(checkDeckDoc(ana)).toEqual({ ok: true, deck: shapesDeck() })
      expect(deckMarkdown(ana)).toBe(toMarkdown(shapesDeck(), { ids: false }))
    })
    When('Ana changes a shape\'s fill', () => setProps(ana, 'details', 'box', { fill: '#22d3ee' }))
    Then('the deck reads as before with the new fill', () => {
      const expected = shapesDeck()
      const shape = expected.slides[1].elements[1] as Extract<DeckElement, { type: 'shape' }>
      shape.props.fill = '#22d3ee'
      expect(readDeckDoc(ana)).toEqual(expected)
      expect(checkDeckDoc(ana).ok).toBe(true)
      before = expected
    })
    And('the shape\'s settings are now stored one by one, and the frontmatter is still stored as before', () => {
      expect(findElement(ana, 'details', 'box')!.get('props')).toBeInstanceOf(Y.Map)
      expect(findElement(ana, 'intro', 'db-scene')!.get('props')).not.toBeInstanceOf(Y.Map)
      expect(findSlide(ana, 'details')!.get('frontmatter')).toEqual({ layout: 'default' })
    })
    When('Ana changes the layout of slide "details"', () => setKeys(ana, 'details', { layout: 'center' }))
    Then('the frontmatter is stored one key at a time too, and the deck reads as before with the new layout', () => {
      expect(findSlide(ana, 'details')!.get('frontmatter')).toBeInstanceOf(Y.Map)
      before.slides[1].frontmatter = { layout: 'center' }
      expect(readDeckDoc(ana)).toEqual(before)
      expect(yDocToDeck(ana)).toEqual(before)
      expect(deckMarkdown(ana)).toBe(toMarkdown(before, { ids: false }))
    })
    When('Ana moves slide "intro" after "details"', () => moveSlide(ana, 'intro', 1))
    Then('its frontmatter and its 3D scene\'s settings are stored key by key, and the deck reads as before in the new order', () => {
      expect(findSlide(ana, 'intro')!.get('frontmatter')).toBeInstanceOf(Y.Map)
      expect(findElement(ana, 'intro', 'db-scene')!.get('props')).toBeInstanceOf(Y.Map)
      const moved = { ...before, slides: [before.slides[1], before.slides[0]] }
      expect(readDeckDoc(ana)).toEqual(moved)
      expect(deckMarkdown(ana)).toBe(toMarkdown(moved, { ids: false }))
    })
  })

  Scenario('Two people change different settings of an older deck after it was converted', ({ Given, When, And, Then }) => {
    Given('a deck stored before settings were split', () => {
      ana = legacyDoc(shapesDeck())
      budi = copyOf(ana)
    })
    When('Ana changes the shape\'s fill, which stores its settings one by one', () => {
      setProps(ana, 'details', 'box', { fill: '#a3e635' })
    })
    And('their documents sync', () => sync(ana, budi))
    And('Ana changes the shape\'s fill again while Budi changes its stroke', () => {
      setProps(ana, 'details', 'box', { fill: '#22d3ee' })
      setProps(budi, 'details', 'box', { stroke: '#0f172a' })
    })
    And('their documents sync once more', () => sync(ana, budi))
    Then('the rectangle has Ana\'s fill and Budi\'s stroke for both of them', () => {
      for (const doc of [ana, budi])
        expect(props(doc, 'details', 'box')).toEqual({ shape: 'rect', fill: '#22d3ee', stroke: '#0f172a' })
    })
  })

  Scenario('An older deck converted all at once merges from the first change', ({ Given, When, Then, And }) => {
    Given('a deck stored before settings were split', () => {
      ana = legacyDoc(shapesDeck())
    })
    When('the server converts it', () => {
      expect(upgradeDeckDoc(ana)).toBe(true)
      budi = copyOf(ana)
    })
    Then('every frontmatter and every block\'s settings are stored key by key, and the deck reads and writes as before', () => {
      for (const slide of ['intro', 'details'])
        expect(findSlide(ana, slide)!.get('frontmatter')).toBeInstanceOf(Y.Map)
      for (const [slide, element] of [['intro', 'db-scene'], ['details', 'box'], ['details', 'sandbox']])
        expect(findElement(ana, slide, element)!.get('props')).toBeInstanceOf(Y.Map)
      expect(readDeckDoc(ana)).toEqual(shapesDeck())
      expect(checkDeckDoc(ana)).toEqual({ ok: true, deck: shapesDeck() })
      expect(deckMarkdown(ana)).toBe(toMarkdown(shapesDeck(), { ids: false }))
    })
    And('converting it again changes nothing', () => {
      expect(upgradeDeckDoc(ana)).toBe(false)
      expect(upgradeDeckDoc(deckToYDoc(shapesDeck()))).toBe(false)
    })
    When('Ana changes the shape\'s fill while Budi changes its stroke', () => {
      setProps(ana, 'details', 'box', { fill: '#22d3ee' })
      setProps(budi, 'details', 'box', { stroke: '#0f172a' })
    })
    And('their documents sync', () => sync(ana, budi))
    Then('the rectangle has Ana\'s fill and Budi\'s stroke for both of them', () => {
      for (const doc of [ana, budi])
        expect(props(doc, 'details', 'box')).toEqual({ shape: 'rect', fill: '#22d3ee', stroke: '#0f172a' })
    })
  })

  Scenario('The demo deck writes the same Markdown in both shapes', ({ Given, Then, And }) => {
    let decks: Deck[]
    Given('the demo deck and the sample deck', () => {
      decks = [fromMarkdown(demoMarkdown), sampleDeck()]
    })
    Then('a live document of each writes the same Markdown as the deck itself', () => {
      for (const deck of decks)
        expect(deckMarkdown(deckToYDoc(deck))).toBe(toMarkdown(deck, { ids: false }))
    })
    And('so does a document of each stored before settings were split', () => {
      for (const deck of decks) {
        expect(deckMarkdown(legacyDoc(deck))).toBe(toMarkdown(deck, { ids: false }))
        expect(yDocToDeck(legacyDoc(deck))).toEqual(yDocToDeck(deckToYDoc(deck)))
      }
    })
  })

  Scenario('Frontmatter entries stored the wrong way are found and repaired', ({ When, And, Then }) => {
    When('Budi stores the key "class" of slide "details" as a plain value and the key "count" as a BigInt', () => {
      const frontmatter = findSlide(budi, 'details')!.get('frontmatter') as Y.Map<unknown>
      frontmatter.set('class', { value: 'text-left', order: 4 })
      const count = new Y.Map<unknown>()
      count.set('value', 3n)
      count.set('order', 5)
      frontmatter.set('count', count)
    })
    And('their documents sync', () => sync(ana, budi))
    Then('reading Ana\'s document shows slide "details" with layout "default" only', () => {
      expect(slideOf(ana, 'details').frontmatter).toEqual({ layout: 'default' })
      expect(slideMarkdown(ana, 'details')).toMatch(/^---\nlayout: default\n---\n/)
    })
    And('the check fails because the frontmatter of slide 2 is not stored the right way', () => {
      expect(checkDeckDoc(ana)).toEqual({ ok: false, message: 'Slide 2 has frontmatter that is not stored the right way' })
      expect(() => yDocToDeck(ana)).toThrow('The frontmatter of slide "details" is not stored the right way')
    })
    When('the server repairs Ana\'s document', () => {
      expect(repairDeckDoc(ana)).toBe(true)
    })
    Then('the check passes and slide "details" still has layout "default" only', () => {
      expect(checkDeckDoc(ana).ok).toBe(true)
      expect(slideOf(ana, 'details').frontmatter).toEqual({ layout: 'default' })
      expect([...(findSlide(ana, 'details')!.get('frontmatter') as Y.Map<unknown>).keys()]).toEqual(['layout'])
      expect(repairDeckDoc(ana)).toBe(false)
    })
  })
})
