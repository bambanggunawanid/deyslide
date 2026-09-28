import type { Deck, Position } from '../packages/deck-model/src'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { parseSync } from '@slidev/parser/core'
import { expect } from 'vitest'
import { fromMarkdown, parsePos, toMarkdown } from '../packages/deck-model/src'
import { sampleDeck } from './support/decks'

const feature = await loadFeature('./deck-markdown.feature')

function describePosition(pos: Position | undefined) {
  if (!pos)
    return 'rejected'
  const height = pos.h === null ? 'auto height' : `h ${pos.h}`
  return `x ${pos.x}, y ${pos.y}, w ${pos.w}, ${height}, ${pos.rotate} deg`
}

describeFeature(feature, ({ Scenario, ScenarioOutline }) => {
  Scenario('A deck survives a round trip through Markdown', ({ Given, When, Then }) => {
    let deck: Deck
    let result: Deck
    Given('a deck with every element type', () => {
      deck = sampleDeck()
    })
    When('it is converted to Slidev Markdown and back', () => {
      result = fromMarkdown(toMarkdown(deck))
    })
    Then('the result equals the original deck', () => {
      expect(result).toEqual(deck)
    })
  })

  Scenario('Positioned elements use Slidev\'s v-drag syntax', ({ Given, When, Then, And }) => {
    let markdown: string
    Given('a deck with every element type', () => {})
    When('it is converted to Slidev Markdown', () => {
      markdown = toMarkdown(sampleDeck())
    })
    Then('the title is written as a v-drag block at "120,80,600,NaN,0"', () => {
      expect(markdown).toContain('<v-drag pos="120,80,600,NaN,0" data-id="title">\n\n# Intro to Graphs\n\n</v-drag>')
    })
    And('the 3D scene is written as a DeyslideScene3D tag with bound JSON props', () => {
      expect(markdown).toContain(`<DeyslideScene3D :camera-position='[8,6,-7]' focus="database" :zoom-level='1.5' />`)
    })
    And('plain Slidev reads the Markdown as 2 slides with the notes on slide 1', () => {
      const parsed = parseSync(markdown, 'slides.md')
      expect(parsed.slides).toHaveLength(2)
      expect(parsed.slides[0].note).toBe('Welcome everyone.')
    })
  })

  Scenario('Code steps become a Slidev Magic Move', ({ Given, When, Then }) => {
    let markdown: string
    Given('a deck with every element type', () => {})
    When('it is converted to Slidev Markdown', () => {
      markdown = toMarkdown(sampleDeck())
    })
    Then('the two code steps are written inside a 4 backtick "md magic-move" fence with 3 backtick steps', () => {
      expect(markdown).toContain('````md magic-move\n```ts\nlet total = 0\n```\n```ts\nconst total = sum(prices)\n// uses ``` inside\n```\n````')
    })
  })

  Scenario('A single code block with fences inside gets a longer fence', ({ Given, When, Then, And }) => {
    const code = 'Write this in Markdown:\n```\nfenced\n```'
    let deck: Deck
    let markdown: string
    let result: Deck
    Given('a code element with one step whose code contains a line "```"', () => {
      deck = { version: 1, slides: [{ id: 's1', frontmatter: {}, elements: [
        { id: 'c1', type: 'code', pos: { x: 0, y: 0, w: 400, h: null, rotate: 0 }, steps: [{ lang: 'md', code }] },
      ] }] }
    })
    When('it is converted to Slidev Markdown and back', () => {
      markdown = toMarkdown(deck)
      result = fromMarkdown(markdown)
    })
    Then('it is written with a 4 backtick fence', () => {
      expect(markdown).toContain(`\`\`\`\`md\n${code}\n\`\`\`\``)
    })
    And('the code is unchanged', () => {
      expect(result).toEqual(deck)
    })
  })

  Scenario('Canonical Markdown converts back byte for byte', ({ Given, And, When, Then }) => {
    let canonical: string
    let again: string
    Given('a deck with every element type', () => {})
    And('it was converted to Slidev Markdown once', () => {
      canonical = toMarkdown(sampleDeck())
    })
    When('that Markdown is converted to a deck and back again', () => {
      again = toMarkdown(fromMarkdown(canonical))
    })
    Then('the Markdown is unchanged', () => {
      expect(again).toBe(canonical)
    })
  })

  Scenario('Markdown the model cannot represent is kept', ({ Given, When, Then }) => {
    const heading = '# Plain heading\n\nSome **intro** text.'
    const component = '<MyChart :data="points" class="h-40">\n  <template #title>Sales</template>\n</MyChart>'
    let markdown: string
    let result: string
    Given('Slidev Markdown with a custom Vue component and a heading', () => {
      markdown = `---\nid: s1\n---\n\n${heading}\n\n${component}\n`
    })
    When('it is converted to a deck and back', () => {
      result = toMarkdown(fromMarkdown(markdown))
    })
    Then('the component and the heading are kept as raw blocks, byte for byte', () => {
      const deck = fromMarkdown(markdown)
      expect(deck.slides[0].elements).toEqual([
        { id: 's1:raw:1', type: 'raw', markdown: `${heading}\n\n${component}` },
      ])
      expect(result).toBe(markdown)
    })
  })

  Scenario('A v-drag block with a JavaScript expression stays raw', ({ Given, When, Then }) => {
    const block = '<v-drag pos="10,10,200,NaN,0" data-id="chart">\n\n<DeyslideScene3D :zoom-level="level * 2" />\n\n</v-drag>'
    let deck: Deck
    Given('a v-drag block whose component binds a variable instead of JSON', () => {})
    When('the Markdown is converted to a deck', () => {
      deck = fromMarkdown(`---\nid: s1\n---\n\n${block}\n`)
    })
    Then('the whole v-drag block is kept as one raw element', () => {
      expect(deck.slides[0].elements).toEqual([{ id: 's1:raw:1', type: 'raw', markdown: block }])
    })
  })

  Scenario('Hand written Markdown gets stable ids', ({ Given, When, Then, And }) => {
    let markdown: string
    let first: Deck
    let second: Deck
    Given('Slidev Markdown with two slides, no ids, and a v-drag block without data-id', () => {
      markdown = '# One\n\n<v-drag pos="0,0,100,50">\n\nHello\n\n</v-drag>\n\n---\n\n# Two\n'
    })
    When('it is converted to a deck twice', () => {
      first = fromMarkdown(markdown)
      second = fromMarkdown(markdown)
    })
    Then('both conversions give the slides ids "slide-1" and "slide-2"', () => {
      expect(first.slides.map(slide => slide.id)).toEqual(['slide-1', 'slide-2'])
      expect(second.slides.map(slide => slide.id)).toEqual(['slide-1', 'slide-2'])
    })
    And('the v-drag element gets the id "slide-1:el:1" both times', () => {
      const pick = (deck: Deck) => deck.slides[0].elements.find(element => element.type === 'text')?.id
      expect(pick(first)).toBe('slide-1:el:1')
      expect(pick(second)).toBe('slide-1:el:1')
    })
  })

  ScenarioOutline('Read a v-drag position', ({ Given, When, Then }, variables) => {
    let raw: string
    let pos: Position | undefined
    Given('the v-drag position "<pos>"', () => {
      raw = variables.pos
    })
    When('the position is read', () => {
      pos = parsePos(raw)
    })
    Then('it is <result>', () => {
      expect(describePosition(pos)).toBe(variables.result)
    })
  })
})
