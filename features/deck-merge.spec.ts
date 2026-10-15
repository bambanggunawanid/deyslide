import type { MarkdownFork, MergeResult, MergeWriter } from '../packages/deck-model/src'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import * as Y from 'yjs'
import {
  applyMarkdown,
  DeckMarkdownError,
  deckMarkdown,
  DeckNotLoadedError,
  deleteSlide,
  elementText,
  forkMarkdown,
  joinSlides,
  mergeMarkdown,
  moveElement,
  moveSlide,
  newMergeWriter,
  readDeckDoc,
  slideTexts,
} from '../packages/deck-model/src'

const feature = await loadFeature('./deck-merge.feature')

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

---

# Thanks
`

const TITLE = '# Intro to Graphs'
const slideIds = (doc: Y.Doc) => readDeckDoc(doc).slides.map(slide => slide.id)
const stateVectorSize = (doc: Y.Doc) => Y.decodeStateVector(Y.encodeStateVector(doc)).size
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, index) => byte === b[index])

function copyOf(state: Uint8Array) {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  return doc
}

describeFeature(feature, ({ Background, Scenario }) => {
  let live: Y.Doc
  let budi: Y.Doc
  let ids: string[]
  let text: string
  let base: Uint8Array
  let before: Uint8Array
  let result: MergeResult | undefined
  let error: unknown

  const element = (doc: Y.Doc, id: string) => readDeckDoc(doc).slides.flatMap(slide => slide.elements).find(item => item.id === id)
  const titleOf = (doc: Y.Doc) => (element(doc, 'title') as { markdown: string }).markdown
  const bodyOf = (doc: Y.Doc) => (element(doc, 'body') as { markdown: string }).markdown
  const boxOf = (doc: Y.Doc) => element(doc, 'box') as { pos: { x: number } }

  /** Budi edits their copy, and the change reaches the live deck. */
  function budiDoes(change: (doc: Y.Doc) => void) {
    change(budi)
    Y.applyUpdate(live, Y.encodeStateAsUpdate(budi, Y.encodeStateVector(live)), 'remote')
  }

  function merge(markdown: string, from = base, options: { writer?: MergeWriter, origin?: string } = {}) {
    before = Y.encodeStateAsUpdate(live)
    result = undefined
    error = undefined
    try {
      result = mergeMarkdown(live, from, markdown, options.origin ?? 'markdown', { writer: options.writer })
    }
    catch (caught) {
      error = caught
    }
  }

  /** What a two way apply of the same Markdown would have made of the live deck. */
  function appliedDirectly(markdown: string) {
    const doc = copyOf(before)
    applyMarkdown(doc, markdown, 'markdown')
    return doc
  }

  Background(({ Given, And }) => {
    Given('the live deck "Graphs" with a title, notes, a body box and a closing slide', () => {
      live = new Y.Doc()
      applyMarkdown(live, DECK, 'file', { create: true })
      ids = slideIds(live)
      budi = copyOf(Y.encodeStateAsUpdate(live))
    })
    And('Ana reads its Markdown and keeps that state as their base', () => {
      text = deckMarkdown(live)
      expect(text).toBe(DECK)
      base = Y.encodeStateAsUpdate(live)
    })
  })

  Scenario('A change that only deletes is kept when older Markdown merges', ({ Given, And, When, Then, But }) => {
    const ana = () => text.replace(TITLE, `${TITLE}!`)
    Given('Budi deletes the closing slide and the words " and edges" from the body box', () => {
      budiDoes((doc) => {
        deleteSlide(doc, ids[2])
        elementText(doc, ids[1], 'body').delete(5, 10)
      })
    })
    And('the live state vector is still the one in Ana\'s base', () => {
      expect(sameBytes(Y.encodeStateVector(live), Y.encodeStateVectorFromUpdate(base))).toBe(true)
    })
    When('Ana merges their Markdown with "!" added to the title', () => merge(ana()))
    Then('the live deck has 2 slides and the body box reads "Nodes"', () => {
      expect(slideIds(live)).toEqual([ids[0], ids[1]])
      expect(bodyOf(live)).toBe('Nodes')
    })
    And('the title reads "# Intro to Graphs!"', () => {
      expect(titleOf(live)).toBe('# Intro to Graphs!')
    })
    But('applying Ana\'s Markdown directly would have brought the deleted content back', () => {
      const direct = appliedDirectly(ana())
      expect(slideIds(direct)).toHaveLength(3)
      expect(bodyOf(direct)).toBe('Nodes and edges')
    })
  })

  Scenario('Edits others made since the base survive the merge', ({ Given, When, Then, And, But }) => {
    const ana = () => text.replace(TITLE, '# Intro to Trees')
    Given('Budi moves the shape box to x 600 and types " today" after "Nodes and edges"', () => {
      budiDoes((doc) => {
        moveElement(doc, ids[1], 'box', { x: 600 })
        elementText(doc, ids[1], 'body').insert(15, ' today')
      })
    })
    When('Ana merges their Markdown with the title changed to "# Intro to Trees"', () => merge(ana()))
    Then('the live deck has the title "# Intro to Trees"', () => {
      expect(titleOf(live)).toBe('# Intro to Trees')
    })
    And('the shape box is at x 600 and the body box reads "Nodes and edges today"', () => {
      expect(boxOf(live).pos.x).toBe(600)
      expect(bodyOf(live)).toBe('Nodes and edges today')
    })
    But('applying Ana\'s Markdown directly would have put the box and the text back', () => {
      const direct = appliedDirectly(ana())
      expect(boxOf(direct).pos.x).toBe(500)
      expect(bodyOf(direct)).toBe('Nodes and edges')
    })
  })

  Scenario('Typing in the same box merges by character', ({ Given, When, Then }) => {
    Given('Budi types "Big " into the title after "# "', () => {
      budiDoes(doc => elementText(doc, ids[0], 'title').insert(2, 'Big '))
    })
    When('Ana merges their Markdown with " today" added to the end of the title', () => {
      merge(text.replace(TITLE, `${TITLE} today`))
    })
    Then('the title reads "# Big Intro to Graphs today"', () => {
      expect(titleOf(live)).toBe('# Big Intro to Graphs today')
    })
  })

  Scenario('Markdown that cannot be read is refused before anything changes', ({ When, Then, And }) => {
    When('Ana merges their Markdown with "<!--" typed in the title', () => {
      merge(text.replace(TITLE, '# Intro <!--to Graphs'))
    })
    Then('the merge fails as "typing"', () => {
      expect(error).toBeInstanceOf(DeckMarkdownError)
      expect((error as DeckMarkdownError).kind).toBe('typing')
    })
    And('the live deck did not change', () => {
      expect(sameBytes(Y.encodeStateAsUpdate(live), before)).toBe(true)
    })
  })

  Scenario('A base the live deck does not contain falls back to applying the Markdown', ({ Given, When, Then, And }) => {
    const ana = () => text.replace(TITLE, '# Intro to Trees')
    Given('Ana\'s base holds an edit the live deck never received', () => {
      const elsewhere = copyOf(base)
      elementText(elsewhere, ids[1], 'body').insert(0, 'Unsaved ')
      base = Y.encodeStateAsUpdate(elsewhere)
    })
    When('Ana merges their Markdown with the title changed to "# Intro to Trees"', () => merge(ana()))
    Then('the merge says it fell back', () => {
      expect(error).toBeUndefined()
      expect(result!.fallback).toBe(true)
    })
    And('the live deck holds exactly Ana\'s Markdown, with nothing left pending', () => {
      expect(deckMarkdown(live)).toBe(ana())
      expect(live.store.pendingStructs).toBeNull()
      expect(sameBytes(result!.liveState, Y.encodeStateAsUpdate(live))).toBe(true)
    })
  })

  Scenario('A writer that keeps the merge\'s text base does not revert others on its next merge', ({ Given, When, And, Then, But }) => {
    let first: MergeResult
    let second: string
    let beforeSecond: Uint8Array
    Given('Budi types " today" after "Nodes and edges"', () => {
      budiDoes(doc => elementText(doc, ids[1], 'body').insert(15, ' today'))
    })
    When('Ana merges their Markdown with the title changed to "# Intro to Trees"', () => {
      text = text.replace(TITLE, '# Intro to Trees')
      merge(text)
      first = result!
    })
    And('Ana changes their own Markdown again, adding the notes line "Ask about cycles."', () => {
      second = text.replace('Welcome everyone.', 'Welcome everyone.\nAsk about cycles.')
    })
    And('Ana merges it from the text base of their first merge', () => {
      beforeSecond = Y.encodeStateAsUpdate(live)
      merge(second, first.textBase)
    })
    Then('the body box reads "Nodes and edges today"', () => {
      expect(bodyOf(live)).toBe('Nodes and edges today')
    })
    And('the title reads "# Intro to Trees" and the notes end with "Ask about cycles."', () => {
      expect(titleOf(live)).toBe('# Intro to Trees')
      expect(readDeckDoc(live).slides[0].notes).toBe('Welcome everyone.\nAsk about cycles.')
    })
    But('merging it from the live state after their first merge would have reverted Budi\'s words', () => {
      const other = copyOf(beforeSecond)
      mergeMarkdown(other, first.liveState, second, 'markdown')
      expect(bodyOf(other)).toBe('Nodes and edges')
    })
  })

  Scenario('The assistant\'s cumulative versions insert a new slide once', ({ Given, And, When, Then }) => {
    let reply: MarkdownFork
    let version: string
    Given('the assistant starts a reply from the live deck', () => {
      reply = forkMarkdown(live, Y.encodeStateAsUpdate(live), 'assistant')
      expect(reply.fallback).toBe(false)
    })
    And('Budi types " today" after "Nodes and edges" during the reply', () => {
      budiDoes(doc => elementText(doc, ids[1], 'body').insert(15, ' today'))
    })
    When('the reply sends a version that adds a slide "# Summary" at the end', () => {
      version = joinSlides([...slideTexts(text), '\n# Summary\n'])
      reply.apply(version)
    })
    And('the reply sends a version that also changes the title to "# Intro to Trees"', () => {
      version = version.replace(TITLE, '# Intro to Trees')
      reply.apply(version)
    })
    And('the reply sends a version that also adds "- Edges join nodes" to the summary', () => {
      version = version.replace('# Summary\n', '# Summary\n\n- Edges join nodes\n')
      reply.apply(version)
    })
    Then('the live deck has one "# Summary" slide, reading "# Summary\\n\\n- Edges join nodes"', () => {
      const slides = readDeckDoc(live).slides
      expect(slides).toHaveLength(4)
      const summaries = slides.filter(slide => slide.elements.some(item => item.type === 'raw' && item.markdown.startsWith('# Summary')))
      expect(summaries).toHaveLength(1)
      expect(summaries[0].elements).toMatchObject([{ type: 'raw', markdown: '# Summary\n\n- Edges join nodes' }])
      expect(slides[3]).toBe(summaries[0])
    })
    And('the title reads "# Intro to Trees"', () => {
      expect(titleOf(live)).toBe('# Intro to Trees')
    })
    And('the body box reads "Nodes and edges today"', () => {
      expect(bodyOf(live)).toBe('Nodes and edges today')
    })
  })

  Scenario('One writer id keeps the state vector small over many merges', ({ When, Then }) => {
    function edits(count: number, writer?: MergeWriter) {
      let from = Y.encodeStateAsUpdate(live)
      for (let index = 0; index < count; index++) {
        const markdown = deckMarkdown(live).replace(/^# .*$/m, `# Intro ${index}`)
        from = mergeMarkdown(live, from, markdown, 'markdown', { writer }).liveState
      }
    }
    When('the Markdown view merges 100 edits with one writer id, each from the live state after the last', () => {
      expect(stateVectorSize(live)).toBe(1)
      edits(100, newMergeWriter())
      expect(titleOf(live)).toBe('# Intro 99')
    })
    Then('the live state vector has 2 entries', () => {
      expect(stateVectorSize(live)).toBe(2)
    })
    When('another 100 edits are merged without a writer id', () => {
      edits(100)
    })
    Then('the live state vector has 102 entries', () => {
      expect(stateVectorSize(live)).toBe(102)
    })
  })

  Scenario('A writer merging twice from the same base lands both changes', ({ When, And, Then }) => {
    const writer = newMergeWriter()
    When('Ana merges their Markdown with the title changed to "# Intro to Trees" as the writer "view"', () => {
      merge(text.replace(TITLE, '# Intro to Trees'), base, { writer })
    })
    And('the writer "view" merges their Markdown with the body changed to "Vertices" from the same base', () => {
      merge(text.replace('Nodes and edges', 'Vertices'), base, { writer })
    })
    Then('the title reads "# Intro to Trees"', () => {
      expect(error).toBeUndefined()
      expect(titleOf(live)).toBe('# Intro to Trees')
    })
    And('the body box reads "Vertices"', () => {
      expect(bodyOf(live)).toBe('Vertices')
    })
  })

  Scenario('A writer cannot use the live deck\'s own client id', ({ When, Then, And }) => {
    When('Ana merges their Markdown as a writer with the live deck\'s client id', () => {
      merge(text.replace(TITLE, '# Intro to Trees'), base, { writer: { clientID: live.clientID } })
    })
    Then('the merge fails with "A merge writer cannot use the client id of the document it merges into"', () => {
      expect((error as Error).message).toBe('A merge writer cannot use the client id of the document it merges into')
    })
    And('the live deck did not change', () => {
      expect(sameBytes(Y.encodeStateAsUpdate(live), before)).toBe(true)
    })
  })

  Scenario('Editing a slide that someone moves keeps one copy of it', ({ Given, When, Then, And }) => {
    Given('Budi moves the first slide to the end', () => {
      budiDoes(doc => moveSlide(doc, ids[0], 2))
    })
    When('Ana merges their Markdown with the title changed to "# Intro to Trees"', () => {
      merge(text.replace(TITLE, '# Intro to Trees'))
    })
    Then('the live deck has 3 slides in Budi\'s order, each id once', () => {
      expect(slideIds(live)).toEqual([ids[1], ids[2], ids[0]])
    })
    And('the moved slide kept its old title, since edits to a slide during a move are lost', () => {
      expect(titleOf(live)).toBe(TITLE)
    })
  })

  Scenario('Undoing a merge restores the deck and keeps others\' edits', ({ Given, And, When, Then }) => {
    let undo: Y.UndoManager
    Given('an undo manager that tracks the origin "markdown"', () => {
      undo = new Y.UndoManager(live.getMap('deck'), { trackedOrigins: new Set(['markdown']) })
    })
    And('Budi moves the shape box to x 600 and types " today" after "Nodes and edges"', () => {
      budiDoes((doc) => {
        moveElement(doc, ids[1], 'box', { x: 600 })
        elementText(doc, ids[1], 'body').insert(15, ' today')
      })
    })
    When('Ana merges their Markdown with the title changed to "# Intro to Trees" with the origin "markdown"', () => {
      merge(text.replace(TITLE, '# Intro to Trees'), base, { origin: 'markdown' })
      expect(titleOf(live)).toBe('# Intro to Trees')
    })
    And('the merge is undone', () => {
      undo.undo()
    })
    Then('the title reads "# Intro to Graphs"', () => {
      expect(titleOf(live)).toBe(TITLE)
    })
    And('the shape box is at x 600 and the body box reads "Nodes and edges today"', () => {
      expect(boxOf(live).pos.x).toBe(600)
      expect(bodyOf(live)).toBe('Nodes and edges today')
    })
  })

  Scenario('A merge into a deck that waits for an update from Budi lands and keeps waiting', ({ Given, When, Then }) => {
    let first: Uint8Array
    Given('Budi\'s next two edits reach the live deck in the wrong order, so it waits for the first one', () => {
      const edits: Uint8Array[] = []
      budi.on('update', (update: Uint8Array) => edits.push(update))
      moveElement(budi, ids[1], 'box', { x: 600 })
      elementText(budi, ids[1], 'body').insert(15, ' today')
      expect(edits).toHaveLength(2)
      first = edits[0]
      Y.applyUpdate(live, edits[1], 'remote')
      expect(live.store.pendingStructs).not.toBeNull()
    })
    When('Ana merges their Markdown with the title changed to "# Intro to Trees"', () => {
      merge(text.replace(TITLE, '# Intro to Trees'))
    })
    Then('the title reads "# Intro to Trees" and the live deck still waits for Budi\'s first edit', () => {
      expect(error).toBeUndefined()
      expect(titleOf(live)).toBe('# Intro to Trees')
      expect(live.store.pendingStructs).not.toBeNull()
      expect(bodyOf(live)).toBe('Nodes and edges')
    })
    When('Budi\'s first edit arrives', () => {
      Y.applyUpdate(live, first, 'remote')
    })
    Then('the live deck holds both of Budi\'s edits, with nothing left waiting', () => {
      expect(live.store.pendingStructs).toBeNull()
      expect(boxOf(live).pos.x).toBe(600)
      expect(bodyOf(live)).toBe('Nodes and edges today')
      expect(titleOf(live)).toBe('# Intro to Trees')
    })
  })

  Scenario('A base taken before the deck loaded is refused', ({ When, Then, And }) => {
    const empty = Y.encodeStateAsUpdate(new Y.Doc())
    When('Ana merges their Markdown from a base taken before the deck loaded', () => {
      merge(text.replace(TITLE, '# Intro to Trees'), empty)
    })
    Then('the merge fails with "The deck is not loaded yet"', () => {
      expect(error).toBeInstanceOf(DeckNotLoadedError)
      expect((error as Error).message).toBe('The deck is not loaded yet')
    })
    And('the live deck did not change', () => {
      expect(sameBytes(Y.encodeStateAsUpdate(live), before)).toBe(true)
    })
    And('a reply that starts from that base fails the same way', () => {
      expect(() => forkMarkdown(live, empty, 'assistant')).toThrow(DeckNotLoadedError)
      expect(sameBytes(Y.encodeStateAsUpdate(live), before)).toBe(true)
    })
  })

  Scenario('A merge waits until the document has a deck', ({ Given, When, Then }) => {
    Given('a live document that has not loaded its deck', () => {
      live = new Y.Doc()
    })
    When('Ana merges their Markdown into it from an empty base', () => {
      merge(text, Y.encodeStateAsUpdate(new Y.Doc()))
    })
    Then('the merge fails with "The deck is not loaded yet"', () => {
      expect((error as Error).message).toBe('The deck is not loaded yet')
    })
  })
})
