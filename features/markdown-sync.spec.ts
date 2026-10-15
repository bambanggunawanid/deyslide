import type { DeckSession } from '../apps/web/src/deck/session'
import type { MarkdownBinding } from '../apps/web/src/editor/markdown-sync'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect, vi } from 'vitest'
import { CAPTURE_TIMEOUT_MS } from '../apps/web/src/deck/session'
import { createMarkdownBinding, HOLD_MESSAGE, MERGE_DELAY_MS, NOT_KEPT_MESSAGE, PATCH_INTERVAL_MS, TYPING_WAITING_HINT, WAITING_HINT } from '../apps/web/src/editor/markdown-sync'
import { CloudStore } from '../apps/web/src/projects/cloud-store'
import { deckMarkdown, elementText, readDeckDoc, slideAtLine, splitSlides } from '../packages/deck-model/src'
import { accountDeck, changeSlide, EditorModel, openReady, setSlides, slidesOf } from './support/live-decks'
import { FakeProjectApi } from './support/project-api'

const feature = await loadFeature('./markdown-sync.feature')

/** Five slides, the fourth with a code block. */
const SORTING = [
  '---\ntitle: Sorting\n---\n\n# Sorting\n',
  '---\n\n# Bubble sort\n',
  '---\n\n# Merge sort\n',
  '---\n\n# Heap sort\n\n```js\nheapify(items)\n```\n',
  '---\n\n# Summary\n',
].join('\n')

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
/** Long enough for typing to merge. */
const AFTER_MERGE = MERGE_DELAY_MS + 150

/** How many times `part` appears in `text`. */
const count = (text: string, part: string) => text.split(part).length - 1

describeFeature(feature, ({ Background, Scenario, AfterEachScenario }) => {
  let api: FakeProjectApi
  let deckId: string
  let ana: DeckSession
  let budi: DeckSession
  let binding: MarkdownBinding
  let editor: EditorModel
  /** The live deck's slides when the scenario started. */
  let original: string[]
  let originalText: string

  AfterEachScenario(() => {
    editor?.close()
    binding?.destroy()
    ana?.close()
    budi?.close()
  })

  const room = () => api.rooms.get(deckId)!
  const roomSlides = () => slidesOf(room())
  /** The slides of Ana's editor text, as Slidev reads them. */
  const editorSlides = () => splitSlides(editor.text).map(slide => slide.content)
  /** The 0 based line of the cursor in Ana's editor. */
  const cursorLine = () => editor.text.slice(0, editor.cursor).split('\n').length - 1

  Background(({ Given }) => {
    Given('Ana and Budi have the account deck "Sorting" of five slides open, Ana in the Markdown view', async () => {
      api = new FakeProjectApi()
      const { projectId, deckId: id } = await accountDeck(api, SORTING)
      deckId = id
      // Two browsers: each has its own store and its own copy of the deck.
      ana = await openReady(await CloudStore.open(api), projectId, deckId)
      budi = await openReady(await CloudStore.open(api), projectId, deckId)
      binding = createMarkdownBinding(ana)
      editor = new EditorModel(binding)
      original = roomSlides()
      originalText = editor.text
      expect(original).toHaveLength(5)
    })
  })

  Scenario('Typing reaches the deck and the other person', ({ When, Then, And }) => {
    When('Ana types "# Bubble sort, slowly" in place of the heading of slide 2', () => {
      editor.replace('# Bubble sort', '# Bubble sort, slowly')
    })
    Then('a moment later the live deck has "# Bubble sort, slowly" on slide 2', async () => {
      expect(roomSlides()[1]).toBe(original[1])
      await vi.waitFor(() => expect(roomSlides()[1]).toBe('\n# Bubble sort, slowly\n'))
    })
    And('Budi\'s deck has it too', () => {
      expect(slidesOf(budi.doc)[1]).toBe('\n# Bubble sort, slowly\n')
    })
  })

  Scenario('A change to another slide edits only that slide and keeps the cursor', ({ Given, When, Then, And }) => {
    Given('Ana\'s cursor is at the end of the heading on slide 1', () => {
      editor.placeAfter('# Sorting')
    })
    When('Budi changes the heading of slide 3 to "# Quick sort"', () => {
      changeSlide(budi, 3, markdown => markdown.replace('# Merge sort', '# Quick sort'))
    })
    Then('Ana\'s editor shows "# Quick sort" on slide 3', async () => {
      await vi.waitFor(() => expect(editorSlides()[2]).toBe('# Quick sort'))
      expect(editor.text).toBe(binding.text.value)
    })
    And('every edit to Ana\'s editor lies inside slide 3', () => {
      expect(editor.patches.length).toBeGreaterThan(0)
      for (const { before, changes } of editor.patches) {
        const third = splitSlides(before)[2]
        const lines = before.split('\n')
        const from = lines.slice(0, third.start).join('\n').length + 1
        const to = lines.slice(0, third.end).join('\n').length
        for (const change of changes) {
          expect(change.from).toBeGreaterThanOrEqual(from)
          expect(change.to).toBeLessThanOrEqual(to)
        }
      }
    })
    And('Ana\'s cursor is still at the end of the heading on slide 1', () => {
      expect(editor.text.slice(0, editor.cursor).endsWith('# Sorting')).toBe(true)
      expect(binding.slideIdAtLine(cursorLine())).toBe(readDeckDoc(ana.doc).slides[0].id)
      expect(slideAtLine(splitSlides(editor.text), cursorLine())).toBe(0)
    })
  })

  Scenario('Someone typing in the slide being edited leaves the cursor in place', ({ Given, When, Then, And }) => {
    Given('Ana\'s cursor is right after "Bubble" in the heading on slide 2', () => {
      editor.placeAfter('# Bubble')
    })
    When('Budi types "Slow " at the start of that heading and " fast" at its end', () => {
      const slide = readDeckDoc(budi.doc).slides[1]
      const text = elementText(budi.doc, slide.id, slide.elements[0].id)
      budi.transact(() => text.insert(text.toString().indexOf('# Bubble sort') + '# Bubble sort'.length, ' fast'))
      budi.transact(() => text.insert(text.toString().indexOf('Bubble'), 'Slow '))
    })
    Then('Ana\'s editor shows "# Slow Bubble sort fast" on slide 2', async () => {
      await vi.waitFor(() => expect(editorSlides()[1]).toBe('# Slow Bubble sort fast'))
    })
    And('Ana\'s cursor is still right after "Bubble"', () => {
      expect(editor.text.slice(0, editor.cursor).endsWith('# Slow Bubble')).toBe(true)
      expect(editor.afterCursor(10)).toBe(' sort fast')
    })
  })

  Scenario('Typing on slide 1 while a change lands on slide 2 keeps both', ({ When, And, Then }) => {
    When('Ana types "# Sorting, live" in place of the heading of slide 1', () => {
      editor.replace('# Sorting', '# Sorting, live')
    })
    And('Budi changes the heading of slide 2 to "# Bubble sort, by Budi" before Ana\'s typing is merged', () => {
      expect(roomSlides()[0]).toBe(original[0])
      changeSlide(budi, 2, markdown => markdown.replace('# Bubble sort', '# Bubble sort, by Budi'))
    })
    Then('the live deck has both changes, each once, on five slides', async () => {
      await vi.waitFor(() => expect(roomSlides()).toEqual([
        original[0].replace('# Sorting', '# Sorting, live'),
        '\n# Bubble sort, by Budi\n',
        ...original.slice(2),
      ]))
      expect(count(deckMarkdown(room()), 'by Budi')).toBe(1)
      expect(count(deckMarkdown(room()), ', live')).toBe(1)
    })
    And('Ana\'s editor shows both changes', async () => {
      await vi.waitFor(() => expect(editorSlides().slice(0, 2)).toEqual(['# Sorting, live', '# Bubble sort, by Budi']))
      expect(editor.text).toBe(deckMarkdown(ana.doc))
    })
  })

  Scenario('An open HTML comment changes nothing until it is closed', ({ When, Then, And }) => {
    When('Ana starts an HTML comment after the heading of slide 1', () => {
      editor.replace('# Sorting\n', '# Sorting\n\n<!--')
    })
    Then('the live deck still has its five slides as they were', async () => {
      await sleep(AFTER_MERGE)
      expect(roomSlides()).toEqual(original)
      expect(slidesOf(ana.doc)).toEqual(original)
    })
    And('Ana sees the soft note "Slide 1 has an HTML comment that is not closed. Close it with -->."', () => {
      expect(binding.problem.value).toEqual({ kind: 'typing', message: 'Slide 1 has an HTML comment that is not closed. Close it with -->.' })
    })
    When('Ana closes the comment', () => {
      editor.replace('<!--', '<!-- the cover -->')
    })
    Then('the live deck has five slides, with the comment on slide 1', async () => {
      await vi.waitFor(() => expect(roomSlides()[0]).toContain('the cover'))
      expect(roomSlides()).toHaveLength(5)
      expect(roomSlides().slice(1)).toEqual(original.slice(1))
      expect(binding.problem.value).toBeUndefined()
    })
  })

  Scenario('A comment that would run into another slide waits until it is closed', ({ Given, When, Then, And }) => {
    let before: string[]
    Given('Budi wrote "Split --> merge" on slide 3, and Ana\'s editor shows it', async () => {
      changeSlide(budi, 3, markdown => markdown.replace('# Merge sort\n', '# Merge sort\n\nSplit --> merge\n'))
      await vi.waitFor(() => expect(editorSlides()[2]).toBe('# Merge sort\n\nSplit --> merge'))
      before = roomSlides()
    })
    When('Ana starts an HTML comment after the heading of slide 1, which would end at the arrow on slide 3', () => {
      editor.replace('# Sorting\n', '# Sorting\n\n<!--')
      // Slidev would read slides 1 to 3 as one slide, with a comment up to the arrow.
      expect(splitSlides(editor.text)).toHaveLength(3)
    })
    Then('the live deck still has its five slides', async () => {
      await sleep(AFTER_MERGE)
      expect(roomSlides()).toEqual(before)
    })
    And('Ana sees a soft note that the change would join slides Ana did not edit', () => {
      expect(binding.problem.value).toEqual({ kind: 'typing', message: HOLD_MESSAGE })
    })
    When('Ana closes the comment', () => {
      editor.replace('<!--', '<!-- the cover -->')
    })
    Then('the live deck has five slides, with the comment on slide 1 and the arrow still on slide 3', async () => {
      await vi.waitFor(() => expect(roomSlides()[0]).toContain('the cover'))
      expect(roomSlides()).toHaveLength(5)
      expect(roomSlides().slice(1)).toEqual(before.slice(1))
      expect(binding.problem.value).toBeUndefined()
    })
  })

  Scenario('A held comment stays held while Ana types on another slide too', ({ Given, When, And, Then }) => {
    let before: string[]
    Given('Budi wrote "Split --> merge" on slide 3, and Ana\'s editor shows it', async () => {
      changeSlide(budi, 3, markdown => markdown.replace('# Merge sort\n', '# Merge sort\n\nSplit --> merge\n'))
      await vi.waitFor(() => expect(editorSlides()[2]).toBe('# Merge sort\n\nSplit --> merge'))
      before = roomSlides()
    })
    When('Ana starts an HTML comment after the heading of slide 1, which would end at the arrow on slide 3', () => {
      editor.replace('# Sorting\n', '# Sorting\n\n<!--')
    })
    And('Ana changes the heading of slide 5 to "# Summary of it all"', () => {
      // A second, separate edit far below the comment.
      editor.replace('# Summary', '# Summary of it all')
    })
    Then('the live deck still has its five slides', async () => {
      await sleep(AFTER_MERGE)
      expect(roomSlides()).toEqual(before)
    })
    And('Ana sees a soft note that the change would join slides Ana did not edit', () => {
      expect(binding.problem.value).toEqual({ kind: 'typing', message: HOLD_MESSAGE })
    })
    When('Budi changes the heading of slide 4 to "# Heap sort, in place"', () => {
      changeSlide(budi, 4, markdown => markdown.replace('# Heap sort', '# Heap sort, in place'))
    })
    Then('the note ends with "Finish this change to see others\' changes."', async () => {
      expect(TYPING_WAITING_HINT).toBe('Finish this change to see others\' changes.')
      await vi.waitFor(() => expect(binding.problem.value?.message).toBe(`${HOLD_MESSAGE} ${TYPING_WAITING_HINT}`))
      expect(binding.problem.value?.kind).toBe('typing')
    })
    When('Ana closes the comment', () => {
      editor.replace('<!--', '<!-- the cover -->')
    })
    Then('the live deck has five slides: the comment on slide 1, the arrow on slide 3, Budi\'s heading on slide 4 and Ana\'s on slide 5', async () => {
      await vi.waitFor(() => expect(roomSlides()[0]).toContain('the cover'))
      expect(roomSlides()[0]).toContain('# Sorting\n')
      expect(roomSlides().slice(1)).toEqual([
        before[1],
        before[2],
        before[3].replace('# Heap sort', '# Heap sort, in place'),
        before[4].replace('# Summary', '# Summary of it all'),
      ])
      // Ana's editor shows Budi's heading too, and keeps Ana's own way of writing the comment.
      await vi.waitFor(() => expect(editorSlides()[3]).toContain('# Heap sort, in place'))
      expect(editorSlides()).toHaveLength(5)
      expect(editor.text).toContain('<!-- the cover -->')
      expect(editorSlides()[4]).toBe('# Summary of it all')
      expect(binding.problem.value).toBeUndefined()
    })
  })

  Scenario('A change made while Ana\'s YAML is broken is neither lost nor duplicated', ({ Given, When, Then, And }) => {
    Given('Ana broke the YAML of the deck\'s frontmatter', async () => {
      editor.replace('title: Sorting', 'title: [Sorting')
      await vi.waitFor(() => expect(binding.problem.value?.kind).toBe('invalid'))
    })
    When('Budi changes the heading of slide 4 to "# Heap sort, in place"', () => {
      changeSlide(budi, 4, markdown => markdown.replace('# Heap sort', '# Heap sort, in place'))
    })
    Then('Ana\'s editor still shows slide 4 as it was, and says "Fix the error to see others\' changes."', async () => {
      await vi.waitFor(() => expect(binding.problem.value?.message).toMatch(new RegExp(`${WAITING_HINT.replace('.', '\\.')}$`)))
      expect(WAITING_HINT).toBe('Fix the error to see others\' changes.')
      expect(editor.text).toContain('# Heap sort\n')
      expect(editor.text).not.toContain('in place')
      expect(roomSlides()[3]).toContain('# Heap sort, in place')
    })
    When('Ana fixes the YAML with the title "Sorted"', () => {
      editor.replace('title: [Sorting', 'title: Sorted')
    })
    Then('the live deck has "# Heap sort, in place" once, the title "Sorted" and five slides', async () => {
      await vi.waitFor(() => expect(roomSlides()[0]).toContain('title: Sorted'))
      const markdown = deckMarkdown(room())
      expect(count(markdown, 'in place')).toBe(1)
      expect(roomSlides()).toHaveLength(5)
      expect(roomSlides()[3]).toBe(original[3].replace('# Heap sort', '# Heap sort, in place'))
    })
    And('Ana\'s editor shows "# Heap sort, in place" on slide 4', async () => {
      await vi.waitFor(() => expect(editorSlides()[3]).toContain('# Heap sort, in place'))
      expect(count(editor.text, 'in place')).toBe(1)
      expect(binding.problem.value).toBeUndefined()
    })
  })

  Scenario('Taking back a broken edit by hand shows the change that waited', ({ Given, When, And, Then }) => {
    Given('Ana broke the YAML of the deck\'s frontmatter', async () => {
      editor.replace('title: Sorting', 'title: [Sorting')
      await vi.waitFor(() => expect(binding.problem.value?.kind).toBe('invalid'))
    })
    When('Budi changes the heading of slide 4 to "# Heap sort, in place"', async () => {
      changeSlide(budi, 4, markdown => markdown.replace('# Heap sort', '# Heap sort, in place'))
      await vi.waitFor(() => expect(binding.problem.value?.message).toContain(WAITING_HINT))
    })
    And('Ana takes the broken edit back by hand', () => {
      editor.replace('title: [Sorting', 'title: Sorting')
    })
    Then('Ana\'s editor shows "# Heap sort, in place" on slide 4, with no note', async () => {
      await vi.waitFor(() => expect(editorSlides()[3]).toContain('# Heap sort, in place'))
      expect(binding.problem.value).toBeUndefined()
      expect(editor.text).toBe(deckMarkdown(ana.doc))
      expect(roomSlides()[0]).toBe(original[0])
    })
  })

  Scenario('Undo right after typing restores the text from before', ({ When, And, Then }) => {
    When('Ana types "# Oops" in place of the heading of slide 2', () => {
      editor.replace('# Bubble sort', '# Oops')
    })
    And('Ana undoes at once', () => {
      ana.undoStep()
    })
    Then('Ana\'s editor holds the deck as it was', async () => {
      await vi.waitFor(() => expect(editor.text).toBe(originalText))
    })
    And('the live deck is as it was', async () => {
      await vi.waitFor(() => expect(roomSlides()).toEqual(original))
      expect(slidesOf(budi.doc)).toEqual(original)
    })
  })

  const paragraph = 'Compare neighbours and swap.'
  const wroteParagraph = (Given: (title: string, run: () => Promise<void>) => void) =>
    Given('Ana wrote "Compare neighbours and swap." on slide 2, and it is in the live deck', async () => {
      editor.replace('# Bubble sort\n', `# Bubble sort\n\n${paragraph}\n`)
      await vi.waitFor(() => expect(roomSlides()[1]).toContain(paragraph))
      // Later changes make an undo step of their own.
      await sleep(CAPTURE_TIMEOUT_MS + 100)
    })

  Scenario('Undo while a comment is held back removes the comment, not earlier work', ({ Given, When, And, Then }) => {
    wroteParagraph(Given)
    When('Ana starts an HTML comment after the heading of slide 1', async () => {
      editor.replace('# Sorting\n', '# Sorting\n\n<!--\n')
      await vi.waitFor(() => expect(binding.problem.value?.kind).toBe('typing'))
    })
    And('Ana undoes', () => {
      ana.undoStep()
    })
    Then('Ana\'s editor no longer has the comment and still has "Compare neighbours and swap."', () => {
      expect(editor.text).not.toContain('<!--')
      expect(editor.text).toContain(paragraph)
      expect(binding.problem.value).toBeUndefined()
    })
    And('the live deck still has "Compare neighbours and swap." on slide 2', async () => {
      await sleep(AFTER_MERGE)
      expect(roomSlides()[1]).toContain(paragraph)
      expect(editor.text).toBe(deckMarkdown(ana.doc))
    })
    When('Ana undoes again', () => {
      ana.undoStep()
    })
    Then('"Compare neighbours and swap." is gone from the live deck and from Ana\'s editor', async () => {
      await vi.waitFor(() => expect(editor.text).toBe(originalText))
      expect(roomSlides()).toEqual(original)
    })
  })

  Scenario('Undo right after breaking the YAML removes only the break', ({ Given, When, Then, And }) => {
    let written: string
    wroteParagraph(Given)
    When('Ana breaks the YAML of the deck\'s frontmatter and undoes at once', () => {
      written = editor.text
      editor.replace('title: Sorting', 'title: [Sorting')
      ana.undoStep()
    })
    Then('Ana\'s editor has the YAML as it was, with no note, and still has "Compare neighbours and swap."', () => {
      expect(editor.text).toBe(written)
      expect(binding.problem.value).toBeUndefined()
    })
    And('the live deck still has "Compare neighbours and swap." on slide 2', async () => {
      await sleep(AFTER_MERGE)
      expect(roomSlides()[1]).toContain(paragraph)
      expect(roomSlides()[0]).toBe(original[0])
      expect(editor.text).toBe(written)
    })
  })

  Scenario('Typing that waits when Ana can only view the deck now is dropped, and others\' changes still show', ({ When, And, Then }) => {
    When('Ana types "# Sorting, typed" in place of the heading of slide 1', () => {
      editor.replace('# Sorting\n', '# Sorting, typed\n')
    })
    And('Ana becomes a viewer of the deck before the typing is merged', async () => {
      api.rejoinAs(ana.doc, 'viewer')
      await vi.waitFor(() => expect(ana.readOnly.value).toBe(true))
    })
    Then('Ana\'s editor shows the deck again, with the note "Your last change was not saved, because this deck is read only now."', async () => {
      expect(NOT_KEPT_MESSAGE).toBe('Your last change was not saved, because this deck is read only now.')
      await vi.waitFor(() => expect(binding.problem.value).toEqual({ kind: 'invalid', message: NOT_KEPT_MESSAGE }))
      expect(editor.text).toBe(originalText)
      expect(ana.readOnly.value).toBe(true)
    })
    When('Budi changes the heading of slide 3 to "# Quick sort"', () => {
      changeSlide(budi, 3, markdown => markdown.replace('# Merge sort', '# Quick sort'))
    })
    Then('Ana\'s editor shows "# Quick sort" on slide 3', async () => {
      await vi.waitFor(() => expect(editorSlides()[2]).toBe('# Quick sort'))
      expect(binding.problem.value?.message).toBe(NOT_KEPT_MESSAGE)
    })
    And('the live deck never had Ana\'s typing', async () => {
      await sleep(AFTER_MERGE)
      expect(deckMarkdown(room())).not.toContain('typed')
      expect(deckMarkdown(ana.doc)).not.toContain('typed')
    })
  })

  Scenario('Slides others add or remove come and go without touching the rest', ({ Given, When, Then, And }) => {
    const ownWay = '\n\n\n# Summary\n\n\n'
    Given('Ana wrote slide 5 with extra blank lines, and Ana\'s cursor is after its heading', async () => {
      editor.replace('\n# Summary\n', ownWay)
      editor.placeAfter('# Summary')
      await sleep(AFTER_MERGE)
      // Blank lines around a slide change nothing in the deck.
      expect(roomSlides()).toEqual(original)
      expect(editor.text.endsWith(ownWay)).toBe(true)
    })
    When('Budi deletes slide 2 and adds the slide "# Insertion sort" after slide 4', () => {
      const slides = slidesOf(budi.doc)
      // One change for both, as one write would make it.
      setSlides(budi, [slides[0], slides[2], slides[3], '\n# Insertion sort\n', slides[4]])
    })
    Then('Ana\'s editor has "# Insertion sort" and no longer "# Bubble sort"', async () => {
      await vi.waitFor(() => expect(editorSlides()).toEqual(['# Sorting', '# Merge sort', '# Heap sort\n\n```js\nheapify(items)\n```', '# Insertion sort', '# Summary']))
      expect(roomSlides()).toHaveLength(5)
    })
    And('slide 5 keeps Ana\'s own way of writing it, with the cursor after its heading', () => {
      expect(editor.text.endsWith(ownWay)).toBe(true)
      expect(editor.text.slice(0, editor.cursor).endsWith('# Summary')).toBe(true)
      expect(editor.afterCursor()).toBe('\n\n\n')
    })
  })

  Scenario('Many changes in a row reach the editor about ten times a second at most', ({ When, Then, And }) => {
    let started: number
    let finished: number
    When('Budi changes the heading of slide 3 thirty times, one change every 10 ms', async () => {
      started = Date.now()
      for (let round = 1; round <= 30; round++) {
        changeSlide(budi, 3, markdown => markdown.replace(/# Merge sort.*/, `# Merge sort ${round}`))
        await sleep(10)
      }
    })
    Then('Ana\'s editor shows the last change', async () => {
      await vi.waitFor(() => expect(editorSlides()[2]).toBe('# Merge sort 30'))
      finished = Date.now()
    })
    And('Ana\'s editor received far fewer edits than changes, about ten a second at most', () => {
      expect(editor.patches.length).toBeLessThan(30)
      expect(editor.patches.length).toBeLessThanOrEqual(Math.ceil((finished - started) / PATCH_INTERVAL_MS) + 1)
    })
  })
})
