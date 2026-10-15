import type { DeckElement, Slide } from '../packages/deck-model/src'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import * as Y from 'yjs'
import {
  applyTextDiff,
  deckToYDoc,
  deleteElement,
  deleteSlide,
  duplicateElement,
  duplicateSlide,
  elementText,
  findSlide,
  insertElement,
  insertSlide,
  makeMovable,
  moveElement,
  moveElementInStack,
  moveSlide,
  newId,
  readDeckDoc,
  setFrontmatter,
  setNotes,
  textChanges,
  updateElement,
} from '../packages/deck-model/src'
import { sampleDeck } from './support/decks'

const feature = await loadFeature('./deck-edit.feature')

function sync(a: Y.Doc, b: Y.Doc) {
  const fromA = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b))
  const fromB = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a))
  Y.applyUpdate(b, fromA)
  Y.applyUpdate(a, fromB)
}

const pos = { x: 0, y: 0, w: 100, h: null, rotate: 0 }
const slideIds = (doc: Y.Doc) => readDeckDoc(doc).slides.map(slide => slide.id)
const slideOf = (doc: Y.Doc, id: string) => readDeckDoc(doc).slides.find(slide => slide.id === id)!
const elementIds = (doc: Y.Doc, slideId: string) => slideOf(doc, slideId).elements.map(element => element.id)
const title = (doc: Y.Doc) => slideOf(doc, 'intro').elements[0] as Extract<DeckElement, { type: 'text' }>
const box = (doc: Y.Doc) => slideOf(doc, 'details').elements.find(element => element.id === 'box') as Extract<DeckElement, { type: 'shape' }>

describeFeature(feature, ({ Background, Scenario }) => {
  let doc: Y.Doc
  let budi: Y.Doc
  let error: unknown
  let snapshot: string
  let updates: unknown[]

  /** Runs an edit and keeps the error it throws, if any. */
  function attempt(edit: () => void) {
    error = undefined
    try {
      edit()
    }
    catch (caught) {
      error = caught
    }
  }

  function expectFailure(message: string) {
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain(message)
  }

  Background(({ Given }) => {
    Given('a live document with the slides "intro" and "details" from the sample deck', () => {
      doc = deckToYDoc(sampleDeck())
      snapshot = JSON.stringify(readDeckDoc(doc))
      updates = []
      doc.on('update', (_: Uint8Array, origin: unknown) => updates.push(origin))
    })
  })

  Scenario('New ids are short, URL safe and different every time', ({ When, Then, And }) => {
    let slides: string[]
    let elements: string[]
    When('1000 slide ids and 1000 element ids are made', () => {
      slides = Array.from({ length: 1000 }, () => newId('s'))
      elements = Array.from({ length: 1000 }, () => newId('e'))
    })
    Then('every slide id is "s-" and 10 URL safe characters', () => {
      for (const id of slides)
        expect(id).toMatch(/^s-[\w-]{10}$/)
    })
    And('every element id is "e-" and 10 URL safe characters', () => {
      for (const id of elements)
        expect(id).toMatch(/^e-[\w-]{10}$/)
    })
    And('no two ids are the same', () => {
      expect(new Set([...slides, ...elements]).size).toBe(2000)
    })
  })

  Scenario('Inserting a slide puts it where it is asked', ({ When, Then, And }) => {
    When('a slide "agenda" with one text box is inserted at position 1', () => {
      insertSlide(doc, 1, { id: 'agenda', frontmatter: {}, elements: [{ id: 'heading', type: 'text', pos, markdown: '# Agenda' }] })
    })
    Then('the slides are "intro", "agenda" and "details"', () => {
      expect(slideIds(doc)).toEqual(['intro', 'agenda', 'details'])
    })
    And('the text box of "agenda" reads "# Agenda"', () => {
      expect(elementText(doc, 'agenda', 'heading').toString()).toBe('# Agenda')
    })
  })

  Scenario('A slide that breaks the rules is refused and nothing changes', ({ When, Then, And }) => {
    When('a slide with the id "details" is inserted', () => {
      attempt(() => insertSlide(doc, 0, { id: 'details', frontmatter: {}, elements: [] }))
    })
    Then('the edit fails with "A slide with the id \\"details\\" already exists"', () => {
      expectFailure('A slide with the id "details" already exists')
    })
    When('a slide with an image without a source is inserted', () => {
      const image = { id: 'logo', type: 'image', pos, src: '', alt: '' } as DeckElement
      attempt(() => insertSlide(doc, 0, { id: 'broken', frontmatter: {}, elements: [image] }))
    })
    Then('the edit fails with "The slide is not valid"', () => {
      expectFailure('The slide is not valid')
    })
    When('a slide whose frontmatter holds the key "id" is inserted', () => {
      attempt(() => insertSlide(doc, 0, { id: 'other', frontmatter: { id: 'other' }, elements: [] }))
    })
    Then('the edit fails with "The frontmatter key \\"id\\" is kept for the slide id"', () => {
      expectFailure('The frontmatter key "id" is kept for the slide id')
    })
    And('the document did not change', () => {
      expect(JSON.stringify(readDeckDoc(doc))).toBe(snapshot)
      expect(updates).toEqual([])
    })
  })

  Scenario('The last slide cannot be deleted', ({ When, Then }) => {
    When('the slide "intro" is deleted', () => {
      deleteSlide(doc, 'intro')
    })
    Then('the slides are "details"', () => {
      expect(slideIds(doc)).toEqual(['details'])
    })
    When('the slide "details" is deleted', () => {
      attempt(() => deleteSlide(doc, 'details'))
    })
    Then('the edit fails with "A deck needs at least one slide"', () => {
      expectFailure('A deck needs at least one slide')
      expect(slideIds(doc)).toEqual(['details'])
    })
  })

  Scenario('Moving a slide keeps its id and content', ({ When, Then, And }) => {
    When('the slide "intro" is moved to position 1', () => {
      moveSlide(doc, 'intro', 1)
    })
    Then('the slides are "details" and "intro"', () => {
      expect(slideIds(doc)).toEqual(['details', 'intro'])
    })
    And('the slide "intro" still has its title, its 3D scene and its notes', () => {
      expect(slideOf(doc, 'intro')).toEqual(sampleDeck().slides[0])
    })
  })

  Scenario('Duplicating a slide gives the copy fresh ids', ({ When, Then, And }) => {
    let copyId: string
    When('the slide "details" is duplicated', () => {
      copyId = duplicateSlide(doc, 'details')
    })
    Then('there are 3 slides and the copy comes right after "details"', () => {
      expect(slideIds(doc)).toEqual(['intro', 'details', copyId])
    })
    And('the copy has the same content as "details" with new slide and element ids', () => {
      const original = slideOf(doc, 'details')
      const copy = slideOf(doc, copyId)
      expect(copyId).toMatch(/^s-/)
      expect(copy.elements.map(element => element.id).every(id => /^e-/.test(id))).toBe(true)
      const withoutIds = (slide: Slide) => ({ ...slide, id: '', elements: slide.elements.map(element => ({ ...element, id: '' })) })
      expect(withoutIds(copy)).toEqual(withoutIds(original))
    })
  })

  Scenario('Frontmatter is replaced as a whole', ({ When, Then }) => {
    When('the frontmatter of "details" is set to layout "center" and class "text-left"', () => {
      setFrontmatter(doc, 'details', { layout: 'center', class: 'text-left' })
    })
    Then('the frontmatter of "details" is layout "center" and class "text-left"', () => {
      expect(slideOf(doc, 'details').frontmatter).toEqual({ layout: 'center', class: 'text-left' })
    })
  })

  Scenario('Setting notes merges with someone typing in them', ({ Given, When, And, Then }) => {
    Given('Budi has a copy of the document', () => {
      budi = new Y.Doc()
      Y.applyUpdate(budi, Y.encodeStateAsUpdate(doc))
    })
    When('the notes of "intro" are set to "Welcome everyone, and thanks for coming."', () => {
      setNotes(doc, 'intro', 'Welcome everyone, and thanks for coming.')
    })
    And('Budi types "Hello! " at the start of the notes of "intro" at the same time', () => {
      (findSlide(budi, 'intro')!.get('notes') as Y.Text).insert(0, 'Hello! ')
    })
    And('the two documents sync', () => sync(doc, budi))
    Then('both documents have the notes "Hello! Welcome everyone, and thanks for coming."', () => {
      for (const replica of [doc, budi])
        expect(slideOf(replica, 'intro').notes).toBe('Hello! Welcome everyone, and thanks for coming.')
    })
  })

  Scenario('Elements are inserted, restacked and deleted', ({ When, Then }) => {
    When('a rectangle "card" is inserted at position 0 of "details"', () => {
      insertElement(doc, 'details', 0, { id: 'card', type: 'shape', pos, props: { shape: 'rect' } })
    })
    Then('the elements of "details" are "card", "logo", "box", "code", "player" and "sandbox"', () => {
      expect(elementIds(doc, 'details')).toEqual(['card', 'logo', 'box', 'code', 'player', 'sandbox'])
    })
    When('"card" is moved to position 5 in the stack of "details"', () => {
      moveElementInStack(doc, 'details', 'card', 5)
    })
    Then('the elements of "details" are "logo", "box", "code", "player", "sandbox" and "card"', () => {
      expect(elementIds(doc, 'details')).toEqual(['logo', 'box', 'code', 'player', 'sandbox', 'card'])
    })
    When('"box" is deleted from "details"', () => {
      deleteElement(doc, 'details', 'box')
    })
    Then('the elements of "details" are "logo", "code", "player", "sandbox" and "card"', () => {
      expect(elementIds(doc, 'details')).toEqual(['logo', 'code', 'player', 'sandbox', 'card'])
    })
  })

  Scenario('Frontmatter that YAML cannot write is refused', ({ When, Then, And }) => {
    When('the frontmatter of "details" is set to a count stored as a BigInt', () => {
      attempt(() => setFrontmatter(doc, 'details', { layout: 'default', count: 3n }))
    })
    Then('the edit fails with "Frontmatter can only hold text, numbers, true or false, null, lists and maps"', () => {
      expectFailure('Frontmatter can only hold text, numbers, true or false, null, lists and maps')
    })
    And('the document did not change', () => {
      expect(JSON.stringify(readDeckDoc(doc))).toBe(snapshot)
      expect(updates).toEqual([])
    })
  })

  Scenario('Duplicating an element offsets the copy', ({ When, Then }) => {
    let copyId: string
    When('"box" on "details" is duplicated with an offset of 20 and 30', () => {
      copyId = duplicateElement(doc, 'details', 'box', { x: 20, y: 30 })
    })
    Then('a copy of "box" with a new id sits right above it at x 220 y 330', () => {
      const ids = elementIds(doc, 'details')
      expect(ids.indexOf(copyId)).toBe(ids.indexOf('box') + 1)
      const copy = slideOf(doc, 'details').elements.find(element => element.id === copyId)!
      expect(copy).toEqual({ ...box(doc), id: copyId, pos: { ...box(doc).pos, x: 220, y: 330 } })
    })
  })

  Scenario('Duplicating an element refuses an offset that would break the copy', ({ When, Then, And }) => {
    When('"box" on "details" is duplicated with an offset that has no y', () => {
      attempt(() => duplicateElement(doc, 'details', 'box', { x: 20 } as { x: number, y: number }))
    })
    Then('the edit fails with "The offset field \\"y\\" must be a finite number"', () => {
      expectFailure('The offset field "y" must be a finite number')
    })
    When('"box" is moved to x 1.7e308 and duplicated with an offset of 1e308 and 0', () => {
      moveElement(doc, 'details', 'box', { x: 1.7e308 })
      updates = []
      attempt(() => duplicateElement(doc, 'details', 'box', { x: 1e308, y: 0 }))
    })
    Then('the edit fails with "The element is not valid"', () => {
      expectFailure('The element is not valid')
    })
    And('"details" still holds its five elements and no copy', () => {
      expect(elementIds(doc, 'details')).toEqual(['logo', 'box', 'code', 'player', 'sandbox'])
      expect(updates).toEqual([])
    })
  })

  Scenario('Updating an element changes only what is given', ({ Given, When, And, Then }) => {
    Given('Budi has a copy of the document', () => {
      budi = new Y.Doc()
      Y.applyUpdate(budi, Y.encodeStateAsUpdate(doc))
    })
    When('the title is updated with x 300 and the text "# Intro to Graphs!"', () => {
      updateElement(doc, 'intro', 'title', { pos: { x: 300 }, markdown: '# Intro to Graphs!' })
    })
    And('Budi types "Big " at the start of the title at the same time', () => {
      elementText(budi, 'intro', 'title').insert(0, 'Big ')
    })
    And('Budi changes the title width to 700 at the same time', () => {
      updateElement(budi, 'intro', 'title', { pos: { w: 700 } })
    })
    And('the two documents sync', () => sync(doc, budi))
    Then('both documents have the title at x 300 with width 700', () => {
      for (const replica of [doc, budi])
        expect(title(replica).pos).toMatchObject({ x: 300, y: 80, w: 700 })
    })
    And('both documents have the title text "Big # Intro to Graphs!"', () => {
      for (const replica of [doc, budi])
        expect(title(replica).markdown).toBe('Big # Intro to Graphs!')
    })
  })

  Scenario('Sizes are clamped and broken values are refused', ({ When, Then }) => {
    When('the title is moved to width -20 and height -5', () => {
      moveElement(doc, 'intro', 'title', { w: -20, h: -5 })
    })
    Then('the title has width 0 and height 0', () => {
      expect(title(doc).pos).toMatchObject({ w: 0, h: 0 })
    })
    When('the title is moved to x "Infinity"', () => {
      attempt(() => moveElement(doc, 'intro', 'title', { x: Infinity }))
    })
    Then('the edit fails with "The position field \\"x\\" must be a finite number"', () => {
      expectFailure('The position field "x" must be a finite number')
    })
    When('the type of the title is changed to "image"', () => {
      attempt(() => updateElement(doc, 'intro', 'title', { type: 'image' }))
    })
    Then('the edit fails with "An element cannot change its type from text to image"', () => {
      expectFailure('An element cannot change its type from text to image')
    })
    When('the title is updated with a "src"', () => {
      attempt(() => updateElement(doc, 'intro', 'title', { src: 'https://example.com/a.png' }))
    })
    Then('the edit fails with "A text element has no field \\"src\\""', () => {
      expectFailure('A text element has no field "src"')
    })
    When('the shape "box" gets the props of a 3D scene', () => {
      attempt(() => updateElement(doc, 'details', 'box', { props: { zoomLevel: 2 } }))
    })
    Then('the edit fails with "The element is not valid"', () => {
      expectFailure('The element is not valid')
      expect(box(doc).props).toEqual({ shape: 'ellipse', fill: '#f472b6' })
    })
  })

  Scenario('Props, sources and code steps change only when they differ', ({ When, Then }) => {
    When('the shape "box" is updated with the props it already has', () => {
      updateElement(doc, 'details', 'box', { props: { shape: 'ellipse', fill: '#f472b6' } })
    })
    Then('the document did not change', () => {
      expect(updates).toEqual([])
    })
    When('the shape "box" is updated with the fill "#22d3ee"', () => {
      updateElement(doc, 'details', 'box', { props: { shape: 'ellipse', fill: '#22d3ee' } })
    })
    Then('the shape "box" has the fill "#22d3ee"', () => {
      expect(box(doc).props).toEqual({ shape: 'ellipse', fill: '#22d3ee' })
    })
  })

  Scenario('A raw block becomes a movable text box', ({ Given, When, Then, And }) => {
    let movableId: string
    Given('the slide "details" starts with a raw block "## Notes for later"', () => {
      insertElement(doc, 'details', 0, { id: 'later', type: 'raw', markdown: '## Notes for later' })
    })
    When('the raw block is made movable at x 40 y 60 with width 300', () => {
      movableId = makeMovable(doc, 'details', 'later', { x: 40, y: 60, w: 300, h: null, rotate: 0 })
    })
    Then('the first element of "details" is a text box with a new id reading "## Notes for later"', () => {
      const [first] = slideOf(doc, 'details').elements
      expect(movableId).toMatch(/^e-/)
      expect(first).toMatchObject({ id: movableId, type: 'text', markdown: '## Notes for later' })
      expect(elementIds(doc, 'details')).toHaveLength(6)
    })
    And('the text box sits at x 40 y 60 with width 300 and auto height', () => {
      expect(slideOf(doc, 'details').elements[0]).toMatchObject({ pos: { x: 40, y: 60, w: 300, h: null, rotate: 0 } })
    })
  })

  Scenario('Every edit runs as one change with the caller\'s origin', ({ When, Then }) => {
    const changes: Record<string, unknown[]> = {}
    When('each kind of edit runs once with the origin "canvas"', () => {
      const edits: Record<string, () => unknown> = {
        insertSlide: () => insertSlide(doc, 2, { id: 'extra', frontmatter: {}, elements: [{ id: 'note', type: 'raw', markdown: 'Extra' }] }, 'canvas'),
        moveSlide: () => moveSlide(doc, 'extra', 0, 'canvas'),
        duplicateSlide: () => duplicateSlide(doc, 'details', 'canvas'),
        setFrontmatter: () => setFrontmatter(doc, 'details', { layout: 'center' }, 'canvas'),
        setNotes: () => setNotes(doc, 'details', 'Show the code.', 'canvas'),
        insertElement: () => insertElement(doc, 'details', 0, { id: 'card', type: 'shape', pos, props: { shape: 'rect' } }, 'canvas'),
        moveElementInStack: () => moveElementInStack(doc, 'details', 'card', 3, 'canvas'),
        duplicateElement: () => duplicateElement(doc, 'details', 'card', { x: 10, y: 10 }, 'canvas'),
        updateElement: () => updateElement(doc, 'details', 'card', { pos: { x: 40, w: 200 }, props: { shape: 'ellipse' } }, 'canvas'),
        moveElement: () => moveElement(doc, 'details', 'card', { y: 80, rotate: 30 }, 'canvas'),
        makeMovable: () => makeMovable(doc, 'extra', 'note', pos, 'canvas'),
        deleteElement: () => deleteElement(doc, 'details', 'card', 'canvas'),
        deleteSlide: () => deleteSlide(doc, 'extra', 'canvas'),
      }
      for (const [name, edit] of Object.entries(edits)) {
        updates = []
        edit()
        changes[name] = updates
      }
    })
    Then('each one changed the document once, with the origin "canvas"', () => {
      expect(Object.keys(changes)).toHaveLength(13)
      for (const [name, origins] of Object.entries(changes))
        expect({ name, origins }).toEqual({ name, origins: ['canvas'] })
    })
  })

  Scenario('A document without a deck refuses every edit', ({ Given, Then, And }) => {
    let empty: Y.Doc
    const failures = (edits: (() => unknown)[]) => edits.map((edit) => {
      try {
        edit()
        return 'no error'
      }
      catch (caught) {
        return (caught as Error).message
      }
    })
    Given('a live document that has not loaded its deck', () => {
      empty = new Y.Doc()
    })
    Then('inserting a slide fails with "The deck is not loaded yet"', () => {
      expect(failures([() => insertSlide(empty, 0, { id: 'a', frontmatter: {}, elements: [] })])).toEqual(['The deck is not loaded yet'])
    })
    And('deleting, moving and duplicating a slide fail with "The deck is not loaded yet"', () => {
      expect(new Set(failures([() => deleteSlide(empty, 'a'), () => moveSlide(empty, 'a', 0), () => duplicateSlide(empty, 'a')]))).toEqual(new Set(['The deck is not loaded yet']))
    })
    And('setting frontmatter and notes fail with "The deck is not loaded yet"', () => {
      expect(new Set(failures([() => setFrontmatter(empty, 'a', {}), () => setNotes(empty, 'a', 'x')]))).toEqual(new Set(['The deck is not loaded yet']))
    })
    And('inserting, deleting, moving, duplicating and updating an element fail with "The deck is not loaded yet"', () => {
      expect(new Set(failures([
        () => insertElement(empty, 'a', 0, { id: 'b', type: 'raw', markdown: 'x' }),
        () => deleteElement(empty, 'a', 'b'),
        () => moveElementInStack(empty, 'a', 'b', 0),
        () => duplicateElement(empty, 'a', 'b', { x: 1, y: 1 }),
        () => updateElement(empty, 'a', 'b', { markdown: 'y' }),
        () => moveElement(empty, 'a', 'b', { x: 1 }),
      ]))).toEqual(new Set(['The deck is not loaded yet']))
    })
    And('making a raw block movable fails with "The deck is not loaded yet"', () => {
      expect(failures([() => makeMovable(empty, 'a', 'b', pos)])).toEqual(['The deck is not loaded yet'])
      expect(Y.decodeStateVector(Y.encodeStateVector(empty)).size).toBe(0)
    })
  })

  Scenario('A text change never splits an emoji', ({ Given, When, Then, And }) => {
    let text: Y.Text
    let before: string
    Given('a shared text "I like 😀 a lot"', () => {
      const textDoc = new Y.Doc()
      text = textDoc.getText('t')
      text.insert(0, 'I like 😀 a lot')
      before = text.toString()
    })
    When('it is changed to "I like 😃 a lot"', () => {
      text.doc!.transact(() => applyTextDiff(text, 'I like 😃 a lot'))
    })
    Then('the shared text reads "I like 😃 a lot"', () => {
      expect(text.toString()).toBe('I like 😃 a lot')
    })
    And('the change replaced the whole emoji', () => {
      expect(textChanges(before, 'I like 😃 a lot')).toEqual([{ from: 7, to: 9, insert: '😃' }])
    })
  })

  Scenario('Text changes for an editor are small and in order', ({ When, Then }) => {
    let changes: ReturnType<typeof textChanges>
    When('the changes from "The quick brown fox" to "The slow brown cat" are listed', () => {
      changes = textChanges('The quick brown fox', 'The slow brown cat')
    })
    Then('they are "quick" to "slow" at 4 and "fox" to "cat" at 16', () => {
      expect(changes).toEqual([{ from: 4, to: 9, insert: 'slow' }, { from: 16, to: 19, insert: 'cat' }])
    })
  })
})
