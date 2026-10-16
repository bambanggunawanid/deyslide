import type { Deck, DeckElement, ParsedDeck } from '../packages/deck-model/src'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import * as Y from 'yjs'
import {
  applyDeck,
  applyMarkdown,
  DeckMarkdownError,
  DeckNotLoadedError,
  deckMarkdown,
  deckToYDoc,
  elementText,
  findSlide,
  fromMarkdown,
  insertElement,
  joinSlides,
  moveElement,
  parseMarkdown,
  readDeckDoc,
  setFrontmatter,
  setNotes,
  slideMarkdowns,
  slideTexts,
  toMarkdown,
  updateElement,
} from '../packages/deck-model/src'
import demoMarkdown from '../apps/deck/slides.md?raw'

const feature = await loadFeature('./deck-reconcile.feature')

/** Three slides as people write them: no slide ids, boxes with data-ids. */
const DECK = `---
layout: cover
---

<v-drag pos="120,80,600,NaN,0" data-id="title">

# Intro to Graphs

</v-drag>

<!--
Welcome everyone.
-->

---

<v-drag pos="40,40,400,NaN,0" data-id="body">

Nodes and edges

</v-drag>

<v-drag pos="500,300,200,100,0" data-id="box">

<DeyslideShape shape="rect" fill="#f472b6" />

</v-drag>

<v-drag pos="40,200,500,NaN,0" data-id="steps">

\`\`\`\`md magic-move
\`\`\`ts
let total = 0
\`\`\`
\`\`\`ts
const total = sum(prices)
\`\`\`
\`\`\`\`

</v-drag>

---

# Thanks

Questions?
`

const pos = { x: 40, y: 400, w: 300, h: null, rotate: 0 }

function sync(a: Y.Doc, b: Y.Doc) {
  const fromA = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b))
  const fromB = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a))
  Y.applyUpdate(b, fromA)
  Y.applyUpdate(a, fromB)
}

const slideIds = (doc: Y.Doc) => readDeckDoc(doc).slides.map(slide => slide.id)
const elementOf = (doc: Y.Doc, slide: number, id: string) => readDeckDoc(doc).slides[slide].elements.find(element => element.id === id)
const slidesMap = (doc: Y.Doc) => doc.getMap('deck').get('slides') as Y.Array<Y.Map<unknown>>
/** What a deck holds besides its raw Markdown: frontmatter, notes, and its boxes with their ids. */
const shape = (deck: Deck) => deck.slides.map(slide => ({
  frontmatter: slide.frontmatter,
  notes: slide.notes,
  boxes: slide.elements.filter(element => element.type !== 'raw').map(element => [element.type, element.id]),
}))

/** v-drag tags that raw Markdown closes itself, so Vue reads them as they are. */
const TAGS: Record<string, string> = {
  'a v-drag closed on its own line': '<v-drag pos="100,50,200,40">Hello</v-drag>',
  'a v-drag closed at the end of a line of text': '<v-drag pos="100,50,200,40">\nHello</v-drag>',
  'a self closing v-drag': '<v-drag pos="100,50,200,40" />',
}

/** Content that would split a slide or change its structure if it were written as it is. */
const HAZARDS: Record<string, (doc: Y.Doc, slideId: string) => void> = {
  'a text box with a line "---"': (doc, slide) => updateElement(doc, slide, 'body', { markdown: 'Nodes\n---\nand edges' }),
  'a text box with a line "</v-drag>"': (doc, slide) => updateElement(doc, slide, 'body', { markdown: 'Write\n</v-drag>\nto close a box' }),
  'speaker notes with "-->"': (doc, slide) => setNotes(doc, slide, 'Ask: does a --> b mean an edge?'),
  'speaker notes with "&lt;!--" and "--&gt;" typed as text': (doc, slide) => setNotes(doc, slide, 'HTML writes &lt;!-- and --&gt; for a comment shown as text.'),
  'a text box that reads like an image': (doc, slide) => updateElement(doc, slide, 'body', { markdown: '<img src="https://example.com/graph.png">' }),
  'a text box that reads like a code block': (doc, slide) => updateElement(doc, slide, 'body', { markdown: '```ts\nconst edges = []\n```' }),
  'a text box that reads like a component': (doc, slide) => updateElement(doc, slide, 'body', { markdown: '<DeyslideShape shape="ellipse" />' }),
  'a text box with an HTML comment left open': (doc, slide) => updateElement(doc, slide, 'body', { markdown: 'Nodes <!-- and edges' }),
  'a text box with a code block left open': (doc, slide) => updateElement(doc, slide, 'body', { markdown: '```js\nconst nodes = [' }),
  'a text box with "</v-drag>" inside a line': (doc, slide) => updateElement(doc, slide, 'body', { markdown: 'Close a box with </v-drag> on its own line' }),
  'a text box with "</v-drag>" as inline code': (doc, slide) => updateElement(doc, slide, 'body', { markdown: 'Close a box with `</v-drag>` on its own line' }),
  'a text box with a v-drag opening it never closes': (doc, slide) => updateElement(doc, slide, 'body', { markdown: 'Start a box with <v-drag pos="10,10,100"> here' }),
  'a text box holding a v-drag box of its own': (doc, slide) => updateElement(doc, slide, 'body', { markdown: '<v-drag pos="10,10,100">\n\nInner\n\n</v-drag>' }),
  'a text box whose v-drag box closes on an indented line': (doc, slide) => updateElement(doc, slide, 'body', { markdown: '<v-drag pos="10,10,100">\n\nInner\n\n </v-drag>' }),
  'a text box with a v-drag tag cut short by a closing tag': (doc, slide) => updateElement(doc, slide, 'body', { markdown: '<v-drag pos="10,\nInner</v-drag>' }),
  'a text box with a v-drag tag cut short by a code block': (doc, slide) => updateElement(doc, slide, 'body', { markdown: '<v-drag pos="10,\n```\nq>\nInner</v-drag>\n```' }),
  'a code box with a line "</v-drag>"': (doc, slide) => insertElement(doc, slide, 3, { id: 'syntax', type: 'code', pos, steps: [{ lang: 'md', code: '<v-drag pos="0,0,100">\n\nHello\n\n</v-drag>' }] }),
  'a code box with "<!--" and speaker notes': (doc, slide) => {
    insertElement(doc, slide, 3, { id: 'html', type: 'code', pos, steps: [{ lang: 'html', code: '<!-- a comment starts like this' }] })
    setNotes(doc, slide, 'Explain HTML comments.')
  },
  'a shape and a sandbox whose values hold "</v-drag>"': (doc, slide) => {
    updateElement(doc, slide, 'box', { props: { shape: 'rect', fill: '</v-drag>' } })
    insertElement(doc, slide, 3, { id: 'sandbox', type: 'sandbox', pos, props: { initial: { '</v-drag>': '<v-drag pos="1,2,3"> and </v-drag>' } } })
  },
  'a raw block that starts with "---"': (doc, slide) => insertElement(doc, slide, 0, { id: 'rule', type: 'raw', markdown: '---\n\nAfter a rule' }),
  'a raw block that ends with an HTML comment': (doc, slide) => insertElement(doc, slide, 3, { id: 'hidden', type: 'raw', markdown: 'Visible\n\n<!-- hidden -->' }),
  'a raw block that starts with a YAML code block': (doc, slide) => insertElement(doc, slide, 0, { id: 'yaml', type: 'raw', markdown: '```yaml\nnodes: 3\n```' }),
  'a raw block with a v-drag closed on its own line': (doc, slide) => insertElement(doc, slide, 3, { id: 'tag', type: 'raw', markdown: TAGS['a v-drag closed on its own line'] }),
  'a raw block with a v-drag closed at the end of a line': (doc, slide) => insertElement(doc, slide, 3, { id: 'tag', type: 'raw', markdown: TAGS['a v-drag closed at the end of a line of text'] }),
  'an image whose alt text has a line "---"': (doc, slide) => insertElement(doc, slide, 3, { id: 'graph', type: 'image', pos, src: 'https://example.com/graph.png', alt: 'A graph\n---\nwith three nodes' }),
  'a frontmatter value with "---"': (doc, slide) => setFrontmatter(doc, slide, { title: 'Part 1 --- Basics' }),
}

/** How the boxes of a deck read back, when writing them changes them on purpose. */
const READINGS: Record<string, (boxes: DeckElement[]) => DeckElement[]> = {
  'as they were': boxes => boxes,
  'with the comment opening written as "&lt;!--"': boxes => boxes.map(box => box.id === 'body' ? { ...box, markdown: 'Nodes &lt;!-- and edges' } : box),
  'with the code block closed': boxes => boxes.map(box => box.id === 'body' ? { ...box, markdown: '```js\nconst nodes = [\n```' } : box),
  'with that tag written as "&lt;/v-drag>"': boxes => boxes.map(box => box.id === 'body' ? { ...box, markdown: 'Close a box with &lt;/v-drag> on its own line' } : box),
  'with that tag written as "&lt;v-drag"': boxes => boxes.map(box => box.id === 'body' ? { ...box, markdown: 'Start a box with &lt;v-drag pos="10,10,100"> here' } : box),
  'with that closing line not indented': boxes => boxes.map(box => box.id === 'body' ? { ...box, markdown: '<v-drag pos="10,10,100">\n\nInner\n\n</v-drag>' } : box),
  'with both tags written with "&lt;"': boxes => boxes.map(box => box.id === 'body' ? { ...box, markdown: '&lt;v-drag pos="10,\nInner&lt;/v-drag>' } : box),
  // Markdown reads the fence as code, so the tag before it never ends.
  'with the cut short tag written with "&lt;"': boxes => boxes.map(box => box.id === 'body' ? { ...box, markdown: '&lt;v-drag pos="10,\n```\nq>\nInner</v-drag>\n```' } : box),
}

/** YAML whose aliases expand to ten thousand values. */
const ALIASES = [
  'a: &a [x, x, x, x, x, x, x, x, x, x]',
  'b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]',
  'c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]',
  'd: [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]',
].join('\n')

/** Edits to the deck's Markdown that leave it half typed or broken. */
const CHANGES: Record<string, (markdown: string) => string> = {
  '"<!--" is typed in the title': markdown => markdown.replace('# Intro to Graphs', '# Intro <!--to Graphs'),
  '"<!--" is typed in the body box': markdown => markdown.replace('Nodes and edges', 'Nodes <!-- and edges'),
  'a code fence is opened at the end of the last slide': markdown => markdown.replace('Questions?', 'Questions?\n\n```js'),
  'a code fence is opened in the body box': markdown => markdown.replace('Nodes and edges', 'Nodes and edges\n```js'),
  // Slidev pairs the fence with the one in the notes, so only the box itself shows it open.
  'a code fence is opened in the title above a fence in the notes': markdown => markdown
    .replace('# Intro to Graphs', '# Intro to Graphs\n```js')
    .replace('Welcome everyone.', 'Welcome everyone.\n```'),
  'a v-drag is opened above the body box': markdown => markdown.replace('<v-drag pos="40,40,400,NaN,0" data-id="body">', '<v-drag pos="10,10,100">\n<v-drag pos="40,40,400,NaN,0" data-id="body">'),
  'a v-drag tag is typed inside the body box': markdown => markdown.replace('Nodes and edges', 'Nodes <v-drag pos="1,2,3"> and edges'),
  'half a v-drag tag is typed above the body box': markdown => markdown.replace('<v-drag pos="40,40,400,NaN,0" data-id="body">', '<v-drag pos="10,\n<v-drag pos="40,40,400,NaN,0" data-id="body">'),
  '"---" is typed above a list item': markdown => markdown.replace('</v-drag>\n\n---\n\n# Thanks', '</v-drag>\n---\n- item: one\n\n---\n\n# Thanks'),
  'the first slide\'s YAML is broken': markdown => markdown.replace('layout: cover', 'layout: [cover'),
  'the first slide\'s YAML expands aliases too far': markdown => markdown.replace('layout: cover', `layout: cover\n${ALIASES}`),
}

describeFeature(feature, ({ Background, Scenario, ScenarioOutline }) => {
  let doc: Y.Doc
  let budi: Y.Doc
  let markdown: string
  let ids: string[]
  let shared: { title: Y.Text, notes: Y.Text, body: Y.Text }
  let updates: unknown[]
  let error: unknown

  function apply(text: string) {
    error = undefined
    try {
      applyMarkdown(doc, text, 'markdown')
    }
    catch (caught) {
      error = caught
    }
  }

  function edit(change: (markdown: string) => string) {
    const next = change(markdown)
    expect(next).not.toBe(markdown)
    apply(next)
    expect(error).toBeUndefined()
  }

  function listen() {
    updates = []
    doc.on('update', (_: Uint8Array, origin: unknown) => updates.push(origin))
  }

  /**
   * Budi's copy. When both sides set one value at once (a map key), Yjs
   * keeps the one from the higher client id, so the Markdown side has the
   * higher one: a value it rewrites without need would win over Budi's.
   */
  function budiWithMarkdownWinning() {
    doc.clientID = 0xFFFFFFF0
    budi = new Y.Doc()
    budi.clientID = 1
    Y.applyUpdate(budi, Y.encodeStateAsUpdate(doc))
  }

  Background(({ Given }) => {
    Given('a live document loaded from a three slide deck written as Markdown', () => {
      doc = new Y.Doc()
      applyMarkdown(doc, DECK, 'file', { create: true })
      markdown = deckMarkdown(doc)
      expect(markdown).toBe(DECK)
      ids = slideIds(doc)
      shared = {
        title: elementText(doc, ids[0], 'title'),
        notes: findSlide(doc, ids[0])!.get('notes') as Y.Text,
        body: elementText(doc, ids[1], 'body'),
      }
      listen()
    })
  })

  Scenario('Applying the deck\'s own Markdown changes nothing', ({ When, Then }) => {
    When('the deck\'s Markdown is applied back', () => apply(markdown))
    Then('the document did not change', () => {
      expect(updates).toEqual([])
    })
  })

  Scenario('Inserting a slide at the top keeps every other slide as it was', ({ When, Then, And }) => {
    When('a slide "# Agenda" is typed above the first slide and applied', () => {
      edit(text => `# Agenda\n\n${text}`)
    })
    Then('there are 4 slides and the first one has a new id', () => {
      const [first, ...rest] = slideIds(doc)
      expect(rest).toHaveLength(3)
      expect(first).toMatch(/^s-/)
      expect(ids).not.toContain(first)
    })
    And('the other slides kept their ids', () => {
      expect(slideIds(doc).slice(1)).toEqual(ids)
    })
    And('the title, the notes and the body text are still the same shared texts', () => {
      expect(elementText(doc, ids[0], 'title')).toBe(shared.title)
      expect(findSlide(doc, ids[0])!.get('notes')).toBe(shared.notes)
      expect(elementText(doc, ids[1], 'body')).toBe(shared.body)
    })
  })

  Scenario('Editing a slide while someone moves a box on another slide keeps both', ({ Given, When, And, Then }) => {
    Given('Budi has a copy of the document', () => {
      budi = new Y.Doc()
      Y.applyUpdate(budi, Y.encodeStateAsUpdate(doc))
    })
    When('the title is changed to "# Intro to Trees" in the Markdown and applied', () => {
      edit(text => text.replace('# Intro to Graphs', '# Intro to Trees'))
    })
    And('Budi moves the body box to x 300 at the same time', () => {
      moveElement(budi, ids[1], 'body', { x: 300 })
    })
    And('the two documents sync', () => sync(doc, budi))
    Then('both documents have the title "# Intro to Trees"', () => {
      for (const replica of [doc, budi])
        expect(elementOf(replica, 0, 'title')).toMatchObject({ markdown: '# Intro to Trees' })
    })
    And('both documents have the body box at x 300', () => {
      for (const replica of [doc, budi])
        expect(elementOf(replica, 1, 'body')).toMatchObject({ pos: { x: 300, y: 40 }, markdown: 'Nodes and edges' })
    })
  })

  Scenario('Typing in the same box from Markdown and from the canvas merges by character', ({ Given, When, And, Then }) => {
    Given('Budi has a copy of the document', () => {
      budi = new Y.Doc()
      Y.applyUpdate(budi, Y.encodeStateAsUpdate(doc))
    })
    When('" today" is added to the end of the title in the Markdown and applied', () => {
      edit(text => text.replace('# Intro to Graphs', '# Intro to Graphs today'))
    })
    And('Budi types "Big " into the title after "# " at the same time', () => {
      elementText(budi, ids[0], 'title').insert(2, 'Big ')
    })
    And('the two documents sync', () => sync(doc, budi))
    Then('both documents have the title "# Big Intro to Graphs today"', () => {
      for (const replica of [doc, budi])
        expect(elementOf(replica, 0, 'title')).toMatchObject({ markdown: '# Big Intro to Graphs today' })
    })
  })

  Scenario('A Markdown edit and canvas edits to the same slide keep each other\'s fields', ({ Given, When, And, Then }) => {
    Given('Budi has a copy of the document, and a value both sides set at once would take the Markdown side', budiWithMarkdownWinning)
    When('the title is changed to "# Intro to Trees" in the Markdown and applied', () => {
      edit(text => text.replace('# Intro to Graphs', '# Intro to Trees'))
    })
    And('Budi moves the title box to x 300 and sets the first slide\'s layout to "center" at the same time', () => {
      moveElement(budi, ids[0], 'title', { x: 300 })
      setFrontmatter(budi, ids[0], { layout: 'center' })
    })
    And('the two documents sync', () => sync(doc, budi))
    Then('both documents have the title "# Intro to Trees" at x 300', () => {
      for (const replica of [doc, budi])
        expect(elementOf(replica, 0, 'title')).toMatchObject({ markdown: '# Intro to Trees', pos: { x: 300, y: 80, w: 600 } })
    })
    And('both documents have the first slide\'s layout "center"', () => {
      for (const replica of [doc, budi])
        expect(readDeckDoc(replica).slides[0].frontmatter).toEqual({ layout: 'center' })
    })
  })

  Scenario('Moving a shape in the Markdown keeps the fill someone changed on the canvas', ({ Given, When, And, Then }) => {
    Given('Budi has a copy of the document, and a value both sides set at once would take the Markdown side', budiWithMarkdownWinning)
    When('the shape box is moved to x 600 in the Markdown and applied', () => {
      edit(text => text.replace('pos="500,300,200,100,0" data-id="box"', 'pos="600,300,200,100,0" data-id="box"'))
    })
    And('Budi changes the shape\'s fill to "#22d3ee" at the same time', () => {
      updateElement(budi, ids[1], 'box', { props: { shape: 'rect', fill: '#22d3ee' } })
    })
    And('the two documents sync', () => sync(doc, budi))
    Then('both documents have the shape at x 600 with the fill "#22d3ee"', () => {
      for (const replica of [doc, budi])
        expect(elementOf(replica, 1, 'box')).toMatchObject({ pos: { x: 600, y: 300 }, props: { shape: 'rect', fill: '#22d3ee' } })
    })
  })

  Scenario('Notes changed in the Markdown merge with someone typing in them', ({ Given, When, And, Then }) => {
    Given('Budi has a copy of the document, and a value both sides set at once would take the Markdown side', budiWithMarkdownWinning)
    When('the first slide\'s notes are changed to "Welcome everyone, and thanks for coming." in the Markdown and applied', () => {
      edit(text => text.replace('Welcome everyone.', 'Welcome everyone, and thanks for coming.'))
    })
    And('Budi types "Hello! " at the start of the first slide\'s notes at the same time', () => {
      (findSlide(budi, ids[0])!.get('notes') as Y.Text).insert(0, 'Hello! ')
    })
    And('the two documents sync', () => sync(doc, budi))
    Then('both documents have the notes "Hello! Welcome everyone, and thanks for coming." in the same shared text', () => {
      for (const replica of [doc, budi])
        expect(readDeckDoc(replica).slides[0].notes).toBe('Hello! Welcome everyone, and thanks for coming.')
      expect(findSlide(doc, ids[0])!.get('notes')).toBe(shared.notes)
    })
  })

  Scenario('Notes the Markdown leaves alone keep the trailing space someone just typed', ({ Given, When, Then }) => {
    Given('someone typed a space after "Welcome everyone." in the first slide\'s notes', () => {
      shared.notes.insert(shared.notes.length, ' ')
      expect(deckMarkdown(doc)).toBe(markdown)
    })
    When('the title is changed to "# Intro to Trees" in the Markdown and applied', () => {
      edit(text => text.replace('# Intro to Graphs', '# Intro to Trees'))
    })
    Then('the notes read "Welcome everyone. " with the trailing space, in the same shared text', () => {
      expect(elementOf(doc, 0, 'title')).toMatchObject({ markdown: '# Intro to Trees' })
      expect(findSlide(doc, ids[0])!.get('notes')).toBe(shared.notes)
      expect(shared.notes.toString()).toBe('Welcome everyone. ')
    })
  })

  Scenario('Changing frontmatter replaces it and leaves the boxes alone', ({ When, Then, And }) => {
    When('the first slide\'s layout is changed to "center" in the Markdown and applied', () => {
      edit(text => text.replace('layout: cover', 'layout: center'))
    })
    Then('the first slide\'s frontmatter is layout "center"', () => {
      expect(readDeckDoc(doc).slides[0].frontmatter).toEqual({ layout: 'center' })
    })
    And('the first slide kept its id and the title is still the same shared text', () => {
      expect(slideIds(doc)).toEqual(ids)
      expect(elementText(doc, ids[0], 'title')).toBe(shared.title)
    })
  })

  Scenario('Reordering slides in the Markdown moves them under their ids', ({ When, Then, And }) => {
    When('the last slide is moved to the top in the Markdown and applied', () => {
      const [first, second, third] = slideTexts(markdown)
      edit(() => joinSlides([third, first, second]))
    })
    Then('the slides are the third, the first and the second, with their ids', () => {
      expect(slideIds(doc)).toEqual([ids[2], ids[0], ids[1]])
    })
    And('the moved slide still reads "# Thanks"', () => {
      expect(readDeckDoc(doc).slides[0].elements).toMatchObject([{ type: 'raw', markdown: '# Thanks\n\nQuestions?' }])
    })
  })

  Scenario('Deleting a slide in the Markdown deletes only that slide', ({ When, Then, And }) => {
    When('the second slide is removed from the Markdown and applied', () => {
      const [first, , third] = slideTexts(markdown)
      edit(() => joinSlides([first, third]))
    })
    Then('the slides are the first and the third, with their ids', () => {
      expect(slideIds(doc)).toEqual([ids[0], ids[2]])
    })
    And('the title and the notes are still the same shared texts', () => {
      expect(elementText(doc, ids[0], 'title')).toBe(shared.title)
      expect(findSlide(doc, ids[0])!.get('notes')).toBe(shared.notes)
    })
  })

  Scenario('Editing a Magic Move step changes only that box\'s steps', ({ When, Then, And }) => {
    When('"sum(prices)" is changed to "total(prices)" in the second Magic Move step and applied', () => {
      edit(text => text.replace('sum(prices)', 'total(prices)'))
    })
    Then('the box "steps" has the steps "let total = 0" and "const total = total(prices)"', () => {
      expect(elementOf(doc, 1, 'steps')).toMatchObject({
        type: 'code',
        steps: [{ lang: 'ts', code: 'let total = 0' }, { lang: 'ts', code: 'const total = total(prices)' }],
      })
    })
    And('the box "steps" kept its position', () => {
      expect(elementOf(doc, 1, 'steps')).toMatchObject({ pos: { x: 40, y: 200, w: 500, h: null, rotate: 0 } })
    })
    And('the body text is still the same shared text', () => {
      expect(elementText(doc, ids[1], 'body')).toBe(shared.body)
    })
  })

  Scenario('A box typed without data-id above an older box keeps the older box\'s text', ({ Given, When, Then, And }) => {
    let older: Y.Text
    Given('the second slide has a box saved with the data-id "slide-2:el:1"', () => {
      doc = new Y.Doc()
      applyMarkdown(doc, DECK.replace('data-id="body">\n\nNodes and edges', 'data-id="slide-2:el:1">\n\nOld box someone is editing'), 'file', { create: true })
      ids = slideIds(doc)
      older = elementText(doc, ids[1], 'slide-2:el:1')
      markdown = deckMarkdown(doc)
      listen()
    })
    When('a new box without data-id is typed above it in the Markdown and applied', () => {
      edit(text => text.replace('<v-drag pos="40,40,400,NaN,0" data-id="slide-2:el:1">', '<v-drag pos="10,10,100,NaN,0">\n\nNew box typed by hand\n\n</v-drag>\n\n<v-drag pos="40,40,400,NaN,0" data-id="slide-2:el:1">'))
    })
    Then('the box "slide-2:el:1" is still the same shared text with its own words', () => {
      expect(elementText(doc, ids[1], 'slide-2:el:1')).toBe(older)
      expect(older.toString()).toBe('Old box someone is editing')
    })
    And('the new box has a fresh id and reads "New box typed by hand"', () => {
      const [first, second] = readDeckDoc(doc).slides[1].elements
      expect(first).toMatchObject({ type: 'text', markdown: 'New box typed by hand', pos: { x: 10, y: 10 } })
      expect(first.id).toMatch(/^e-/)
      expect(second.id).toBe('slide-2:el:1')
    })
  })

  Scenario('Reordering boxes in the Markdown restacks them under their ids', ({ When, Then }) => {
    When('the body box and the shape box swap places in the Markdown and applied', () => {
      const body = '<v-drag pos="40,40,400,NaN,0" data-id="body">\n\nNodes and edges\n\n</v-drag>'
      const box = '<v-drag pos="500,300,200,100,0" data-id="box">\n\n<DeyslideShape shape="rect" fill="#f472b6" />\n\n</v-drag>'
      edit(text => text.replace(`${body}\n\n${box}`, `${box}\n\n${body}`))
    })
    Then('the boxes of the second slide are "box", "body" and "steps"', () => {
      expect(readDeckDoc(doc).slides[1].elements.map(element => element.id)).toEqual(['box', 'body', 'steps'])
      expect(elementOf(doc, 1, 'body')).toMatchObject({ type: 'text', markdown: 'Nodes and edges' })
    })
  })

  Scenario('A box whose content becomes an image is replaced under the same id', ({ When, Then }) => {
    When('the body text is replaced by an image tag in the Markdown and applied', () => {
      edit(text => text.replace('Nodes and edges', '<img src="https://example.com/graph.png" alt="A graph">'))
    })
    Then('the box "body" is an image of "https://example.com/graph.png"', () => {
      expect(elementOf(doc, 1, 'body')).toEqual({ id: 'body', type: 'image', pos: { x: 40, y: 40, w: 400, h: null, rotate: 0 }, src: 'https://example.com/graph.png', alt: 'A graph' })
    })
  })

  Scenario('A copied box keeps the original and gives the copy a fresh id', ({ When, Then, And }) => {
    let original: Y.Map<unknown>
    When('the shape box is copied with its data-id and moved to x 600 in the Markdown and applied', () => {
      original = (slidesMap(doc).get(1).get('elements') as Y.Array<Y.Map<unknown>>).get(1)
      const box = '<v-drag pos="500,300,200,100,0" data-id="box">\n\n<DeyslideShape shape="rect" fill="#f472b6" />\n\n</v-drag>'
      edit(text => text.replace(box, `${box}\n\n${box.replace('500,300', '600,300')}`))
    })
    Then('the box "box" is still the same shape at x 500', () => {
      const elements = slidesMap(doc).get(1).get('elements') as Y.Array<Y.Map<unknown>>
      expect(elements.get(1)).toBe(original)
      expect(elementOf(doc, 1, 'box')).toMatchObject({ type: 'shape', pos: { x: 500 } })
    })
    And('a second shape at x 600 has a fresh id', () => {
      const copy = readDeckDoc(doc).slides[1].elements[2] as Extract<DeckElement, { type: 'shape' }>
      expect(copy).toMatchObject({ type: 'shape', pos: { x: 600 }, props: { shape: 'rect', fill: '#f472b6' } })
      expect(copy.id).toMatch(/^e-/)
    })
  })

  Scenario('Slide ids in the frontmatter pair a slide that moved and changed', ({ When, Then, And }) => {
    When('the deck is written with slide ids, its last slide moved to the top and its text changed, and applied', () => {
      const [first, second, third] = slideTexts(toMarkdown(readDeckDoc(doc)))
      apply(joinSlides([third.replace('# Thanks', '# Thanks a lot'), first, second]))
      expect(error).toBeUndefined()
    })
    Then('the slides are the third, the first and the second, with their ids', () => {
      expect(slideIds(doc)).toEqual([ids[2], ids[0], ids[1]])
    })
    And('the first slide reads "# Thanks a lot"', () => {
      expect(readDeckDoc(doc).slides[0].elements).toMatchObject([{ type: 'raw', markdown: '# Thanks a lot\n\nQuestions?' }])
    })
  })

  Scenario('A deck from an older client with place based ids keeps the slide ids', ({ When, Then, And }) => {
    When('an older client saves the deck with a slide inserted at the top and slide ids "slide-1" to "slide-4"', () => {
      const deck = fromMarkdown(`# Agenda\n\n${markdown}`)
      expect(deck.slides.map(slide => slide.id)).toEqual(['slide-1', 'slide-2', 'slide-3', 'slide-4'])
      applyDeck(doc, deck, 'old client')
    })
    Then('there are 4 slides and the first one has a new id', () => {
      const [first, ...rest] = slideIds(doc)
      expect(rest).toHaveLength(3)
      expect(first).toMatch(/^s-/)
      expect(ids).not.toContain(first)
    })
    And('the other slides kept their ids', () => {
      expect(slideIds(doc).slice(1)).toEqual(ids)
      expect(elementText(doc, ids[1], 'body')).toBe(shared.body)
    })
  })

  Scenario('New slides and boxes keep an id written in the Markdown when it is free', ({ When, Then }) => {
    let loaded: Y.Doc
    When('a slide with the id "summary" holding a copy of the shape box with its data-id is added at the end of the Markdown and applied', () => {
      const box = '<v-drag pos="500,300,200,100,0" data-id="box">\n\n<DeyslideShape shape="rect" fill="#f472b6" />\n\n</v-drag>'
      edit(text => `${text}\n---\nid: summary\n---\n\n${box}\n`)
    })
    Then('the last slide has the id "summary" and its shape has the id "box"', () => {
      const { slides } = readDeckDoc(doc)
      expect(slides.map(slide => slide.id)).toEqual([...ids, 'summary'])
      expect(slides[3].elements).toMatchObject([{ id: 'box', type: 'shape', pos: { x: 500 } }])
      expect(elementOf(doc, 1, 'box')).toMatchObject({ type: 'shape' })
    })
    When('the deck is written with slide ids and loaded into a new document as a new deck', () => {
      loaded = new Y.Doc()
      applyMarkdown(loaded, toMarkdown(readDeckDoc(doc)), 'file', { create: true })
    })
    Then('the new document has the same slide ids', () => {
      expect(slideIds(loaded)).toEqual([...ids, 'summary'])
    })
  })

  Scenario('A rewrite too big to align in full still keeps the slides that did not change', ({ Given, When, Then, And }) => {
    let next: string
    Given('a live document with 1200 one line slides', () => {
      doc = new Y.Doc()
      applyMarkdown(doc, `${Array.from({ length: 1200 }, (_, index) => `# Slide ${index}`).join('\n\n---\n\n')}\n`, 'file', { create: true })
      ids = slideIds(doc)
      markdown = deckMarkdown(doc)
      listen()
    })
    When('every other slide is rewritten and the last slide is moved to the top in the Markdown and applied', () => {
      const texts = slideTexts(markdown).map((text, index) => index % 2 === 0 ? text.replace(`# Slide ${index}`, `# Slide ${index} again`) : text)
      next = joinSlides([texts.at(-1)!, ...texts.slice(0, -1)])
      apply(next)
      expect(error).toBeUndefined()
    })
    Then('the document holds that Markdown', () => {
      const fresh = new Y.Doc()
      applyMarkdown(fresh, next, 'file', { create: true })
      expect(deckMarkdown(doc)).toBe(deckMarkdown(fresh))
      expect(readDeckDoc(doc).slides[1].elements).toMatchObject([{ type: 'raw', markdown: '# Slide 0 again' }])
    })
    And('every slide kept its id, the moved one too', () => {
      expect(slideIds(doc)).toEqual([ids[1199], ...ids.slice(0, 1199)])
    })
  })

  Scenario('Text someone is typing keeps its trailing space when Markdown changes elsewhere', ({ Given, When, Then }) => {
    Given('someone on the canvas typed "Nodes and edges " with a trailing space in the body box', () => {
      shared.body.insert(shared.body.length, ' ')
      markdown = deckMarkdown(doc)
    })
    When('the title is changed to "# Intro to Trees" in the Markdown and applied', () => {
      edit(text => text.replace('# Intro to Graphs', '# Intro to Trees'))
    })
    Then('the body box reads "Nodes and edges " with the trailing space', () => {
      expect(shared.body.toString()).toBe('Nodes and edges ')
      expect(elementOf(doc, 0, 'title')).toMatchObject({ markdown: '# Intro to Trees' })
    })
  })

  ScenarioOutline('Content that could split a slide survives the Markdown round trip', ({ Given, When, Then, And }, variables) => {
    let parsed: ParsedDeck
    let touched: boolean
    let second: Y.Map<unknown>
    Given('the second slide holds <content>', () => {
      HAZARDS[variables.content](doc, ids[1])
    })
    When('the deck is written as Markdown and applied back', () => {
      markdown = deckMarkdown(doc)
      parsed = parseMarkdown(markdown)
      listen()
      apply(markdown)
      expect(error).toBeUndefined()
    })
    Then('the deck reads back with the same slides and the same boxes', () => {
      expect(shape(parsed.deck)).toEqual(shape(readDeckDoc(doc)))
      expect(toMarkdown(parsed.deck, { ids: false })).toBe(markdown)
    })
    And('the boxes read back <reading>', () => {
      const boxes = (deck: Deck) => deck.slides.flatMap(slide => slide.elements.filter(element => element.type !== 'raw'))
      expect(boxes(parsed.deck)).toEqual(READINGS[variables.reading](boxes(readDeckDoc(doc))))
    })
    And('the document did not change', () => {
      expect(updates).toEqual([])
    })
    When('the title is changed to "# Intro to Trees" in that Markdown and applied', () => {
      second = slidesMap(doc).get(1)
      touched = false
      second.observeDeep(() => {
        touched = true
      })
      edit(text => text.replace('# Intro to Graphs', '# Intro to Trees'))
      expect(elementOf(doc, 0, 'title')).toMatchObject({ markdown: '# Intro to Trees' })
    })
    Then('the second slide was not touched', () => {
      expect(touched).toBe(false)
      expect(slidesMap(doc).get(1)).toBe(second)
    })
  })

  ScenarioOutline('A v-drag that raw Markdown closes itself is kept as it was typed', ({ When, Then, And }, variables) => {
    When('<tag> is typed at the end of the last slide and applied', () => {
      edit(text => `${text}\n${TAGS[variables.tag]}\n`)
    })
    Then('the deck\'s Markdown holds it as it was typed', () => {
      expect(deckMarkdown(doc)).toBe(`${markdown}\n${TAGS[variables.tag]}\n`)
    })
    And('it is part of the last slide\'s raw Markdown', () => {
      expect(readDeckDoc(doc).slides[2].elements).toMatchObject([{ type: 'raw', markdown: `# Thanks\n\nQuestions?\n\n${TAGS[variables.tag]}` }])
      expect(readDeckDoc(doc).slides[2].elements).toHaveLength(1)
    })
  })

  Scenario('A leading empty slide survives the round trip', ({ Given, When, Then, And }) => {
    let deck: Deck
    let written: string
    let read: Deck
    Given('a deck whose first slide is empty', () => {
      deck = {
        version: 1,
        slides: [
          { id: 'cover', frontmatter: {}, elements: [] },
          { id: 'next', frontmatter: { layout: 'center' }, elements: [{ id: 'hello', type: 'text', pos, markdown: 'Hello' }] },
        ],
      }
    })
    When('it is written as Markdown without ids and read back', () => {
      written = toMarkdown(deck, { ids: false })
      read = fromMarkdown(written)
    })
    Then('it still has 2 slides and the first one is empty', () => {
      expect(read.slides).toHaveLength(2)
      expect(read.slides[0]).toMatchObject({ frontmatter: {}, elements: [] })
      expect(read.slides[0].notes).toBeUndefined()
      expect(read.slides[1].elements).toEqual(deck.slides[1].elements)
    })
    And('applying that Markdown to its live document changes nothing', () => {
      doc = deckToYDoc(deck)
      listen()
      apply(written)
      expect(error).toBeUndefined()
      expect(updates).toEqual([])
      expect(deckMarkdown(doc)).toBe(written)
    })
  })

  Scenario('Each slide\'s Markdown is the text Slidev splits from the deck', ({ Given, Then, And }) => {
    let docs: Y.Doc[]
    Given('the demo deck, and a deck with empty slides first, in the middle and last', () => {
      const demo = new Y.Doc()
      applyMarkdown(demo, demoMarkdown, null, { create: true })
      const empty = (id: string) => ({ id, frontmatter: {}, elements: [] })
      const text = (id: string) => ({ id, frontmatter: {}, elements: [{ id: `${id}-text`, type: 'text' as const, pos, markdown: id }] })
      docs = [demo, deckToYDoc({ version: 1, slides: [empty('a'), text('b'), empty('c'), text('d'), empty('e')] })]
    })
    Then('each slide\'s Markdown joins into the deck\'s Markdown', () => {
      for (const each of docs)
        expect(joinSlides(slideMarkdowns(each).map(slide => slide.markdown))).toBe(deckMarkdown(each))
    })
    And('each one equals the slide text Slidev reads from the deck\'s Markdown', () => {
      for (const each of docs) {
        expect(slideMarkdowns(each).map(slide => slide.markdown)).toEqual(slideTexts(deckMarkdown(each)))
        expect(slideMarkdowns(each).map(slide => slide.id)).toEqual(slideIds(each))
      }
    })
  })

  ScenarioOutline('Half typed Markdown is refused softly and changes nothing', ({ When, And, Then }, variables) => {
    When('<change> in the Markdown', () => {
      markdown = CHANGES[variables.change](markdown)
    })
    And('the Markdown is applied', () => apply(markdown))
    Then('it fails as "<kind>" with "<message>"', () => {
      expect(error).toBeInstanceOf(DeckMarkdownError)
      expect((error as DeckMarkdownError).kind).toBe(variables.kind)
      expect((error as Error).message).toContain(variables.message)
    })
    And('the document did not change', () => {
      expect(updates).toEqual([])
    })
  })

  Scenario('Markdown waits until the document has a deck', ({ Given, When, Then }) => {
    Given('a live document that has not loaded its deck', () => {
      doc = new Y.Doc()
    })
    When('the deck\'s Markdown is applied to it', () => apply(markdown))
    Then('it fails with "The deck is not loaded yet" and the document is still empty', () => {
      expect(error).toBeInstanceOf(DeckNotLoadedError)
      expect((error as Error).message).toBe('The deck is not loaded yet')
      expect(Y.decodeStateVector(Y.encodeStateVector(doc)).size).toBe(0)
    })
    When('the deck\'s Markdown is applied to it as a new deck', () => {
      applyMarkdown(doc, markdown, 'file', { create: true })
    })
    Then('it holds the 3 slides with fresh slide ids', () => {
      expect(deckMarkdown(doc)).toBe(markdown)
      const fresh = slideIds(doc)
      expect(fresh).toHaveLength(3)
      for (const id of fresh)
        expect(id).toMatch(/^s-/)
      expect(fresh).not.toEqual(ids)
    })
  })
})
