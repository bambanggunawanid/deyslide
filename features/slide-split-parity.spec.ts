// @vitest-environment node
import type { RustSplit } from './support/local-mcp'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { parseSync } from '@slidev/parser/core'
import { expect } from 'vitest'
import { frontmatterErrors, joinSlides, slideTexts, splitSlides } from '../packages/deck-model/src'
import { demoDeckMarkdown } from './support/deck-content'
import { joinWithRust, splitWithRust } from './support/local-mcp'

const feature = await loadFeature('./slide-split-parity.feature')

const EVERY_SLIDE = '---\ntitle: Deck\nfonts:\n  sans: Inter\n  mono: JetBrains Mono\ntransition: slide-left\n---\n\n# One\n\n---\nlayout: center\nclass: text-center\nclicks: 2\n---\n\n# Two\n\n---\nlayout: end\n---\n\n# Bye\n'

/**
 * The decks each example splits. They live here rather than in the
 * feature, because Gherkin reads lines starting with # or three backticks
 * in a doc string as a comment or a delimiter.
 */
const SAMPLES: Record<string, string> = {
  'frontmatter on every slide': EVERY_SLIDE,
  'code fences holding --- lines': '# Code\n\n```yaml\n---\nkey: value\n---\n```\n\n````md\n```\n---\n```\n````\n\n  ```ts\n  ---\n  ```\n\n---\n\n# After\n',
  'HTML comments holding --- lines': '# One\n\n<!--\n---\nnot a slide\n---\n-->\n\nText <!-- inline --> and <!-- a comment\n---\nthat ends later -->\n\n---\n\n# Two\n',
  'speaker notes': '# One\n\n<!-- not a note -->\n\nText\n\n<!--\nSay hello\n[click] Then this\n-->\n\n---\n\n# Two\n\n<!-- short note -->\n\n---\nlayout: center\n---\n\n# Three\n<!---->\n',
  'Magic Move': '---\nlayout: default\n---\n\n# Steps\n\n````md magic-move\n```ts\nlet a = 1\n```\n```ts\nconst a = 1\n```\n````\n\n<!--\nWalk through each step\n-->\n',
  'empty slides': '# One\n\n---\n\n---\n\n\n---\n\n# Four\n---\n',
  'a leading empty slide': '\n---\n\n# Two\n\n---\nlayout: end\n---\n',
  'Windows line endings': EVERY_SLIDE.replaceAll('\n', '\r\n'),
  'frontmatter in a yaml code block': '```yaml\nlayout: center\n```\n\n# One\n\n---\n\n  ```yml\nclass: big\n```\n# Two\n',
  'four dashes and unclosed fences': '# One\n\n----\nlayout: center\n\n---\n\n```ts\nlet a = 1\n---\n# Three\n',
  'separators with trailing spaces': '# One\n---  \nlayout: center\n---\t\n# Two\n--- \n\n# Three\n',
  'broken frontmatter': '---\ntitle: [oops\n---\n\n# One\n\n---\nlayout: center\n---\n\n# Two\n\n---\nkey: value: other\n---\n\n# Three\n',
  'an unclosed HTML comment': '# One\n\n<!--\n---\n\n# Two\n\n---\n\n# Three\n',
  'the demo deck': demoDeckMarkdown(),
}

/**
 * Frontmatter shapes where the YAML reader under the Rust port, libyaml,
 * and the `yaml` package Slidev uses could part ways.
 */
const FRONTMATTER: Record<string, string> = {
  'a tab on an empty line': 'theme: default\n\t\nclass: big',
  'a comment line indented with a tab': 'fonts:\n  sans: Inter\n\t# mono later',
  'a tab on an empty line inside a block scalar': 'info: |\n  ## Slidev\n\t\n  Text',
  'a tab after the indentation inside a block scalar': 'info: |\n  ## Slidev\n  \t\n  Text',
  'a quoted title that goes on to an unindented line': 'title: "A long\ntitle"',
  'a quoted title that goes on to an indented line': 'title: "A long\n  title"',
  'a single quoted title that goes on to an unindented line': 'title: \'A long\ntitle\'',
  'a list that goes on to an unindented line': 'transition: [slide-left,\nfade]',
  'a list whose closing bracket sits under its key': 'transition: [slide-left,\n  fade,\n]',
  'a map that goes on to an unindented line': 'fonts: { sans: Inter,\nmono: Fira }',
  'a nested value that goes on to a line under its key': 'fonts:\n  sans: "Inter\n  Tight"',
  'a list item that goes on to a line under its dash': 'tags:\n  - "slides\n  talks"',
  'a quoted value that goes on to a line indented by a tab': 'title: "A long\n\ttitle"',
  'an escaped quote before the line break': 'title: "Say \\"hi\\"\nagain"',
  'a plain value that goes on with a dash and brackets': 'title: Steps\n  - [one,\n  two]',
  'a tab line inside a plain value that goes on': 'title: A long\n\t\n  title',
  'a tab line after a key with no value': 'fonts:\n\t\ntheme: default',
  'a tab line before nested values': 'fonts:\n\t\n  sans: Inter',
  'a number too long for 64 bits': 'seed: 99999999999999999999',
  'a bell character': 'title: Ding\u0007',
  'a line separator character': 'title: One\u2028Two',
  'a next line character': 'title: One\u0085Two',
  'a carriage return on its own': 'title: One\rTwo',
  'duplicate keys': 'layout: cover\nlayout: center',
  'an anchor and an alias': 'base: &base Inter\nfonts:\n  sans: *base',
  'a custom tag': 'theme: !custom default',
  'lists nested 200 levels deep': `nested: ${'['.repeat(200)}${']'.repeat(200)}`,
  'a key left empty': ': value',
  'a tab between the indentation and a value under a key with no value': 'title:\n \tSorting',
  'the keys 1 and 01': '1: a\n01: b',
}

/** The parts of each slide both sides report, in the same shape. */
function slidevSlides(markdown: string) {
  return parseSync(markdown, 'slides.md').slides.map(slide => ({
    index: slide.index,
    start: slide.start,
    contentStart: slide.contentStart,
    end: slide.end,
    raw: slide.raw,
    content: slide.content,
    note: slide.note ?? null,
    frontmatterStyle: slide.frontmatterStyle ?? null,
    frontmatterRaw: slide.frontmatterRaw ?? null,
    broken: (slide.frontmatterDoc?.errors.length ?? 0) > 0,
    // Slidev keeps what it could read of broken YAML; the Rust side keeps nothing, so only valid frontmatter is compared.
    frontmatter: (slide.frontmatterDoc?.errors.length ?? 0) > 0 ? null : JSON.parse(JSON.stringify(slide.frontmatter)) as unknown,
  }))
}

function rustSlides(split: RustSplit) {
  return split.slides.map(({ frontmatterError, frontmatter, ...slide }) => ({
    ...slide,
    broken: frontmatterError !== null,
    frontmatter: frontmatterError === null ? frontmatter : null,
  }))
}

/** "Slide N" of each frontmatter problem, since the two YAML readers word their errors differently. */
const brokenSlides = (problems: string[]) => problems.map(problem => problem.slice(0, problem.indexOf(':')))

/** How each side reads one frontmatter block. */
function readFrontmatter(yaml: string) {
  const markdown = `---\n${yaml}\n---\n\n# One\n`
  const [slidev] = parseSync(markdown, 'slides.md').slides
  const [rust] = splitWithRust(markdown).slides
  return {
    slidev: { broken: (slidev.frontmatterDoc?.errors.length ?? 0) > 0, values: JSON.parse(JSON.stringify(slidev.frontmatter)) as unknown },
    rust: { broken: rust.frontmatterError !== null, values: rust.frontmatter },
  }
}

describeFeature(feature, ({ Scenario, ScenarioOutline }) => {
  ScenarioOutline('Tricky decks split the same in Rust and in Slidev', ({ Given, When, Then, And }, variables) => {
    let markdown: string
    let rust: RustSplit
    Given('the sample deck with <sample>', () => {
      markdown = SAMPLES[variables.sample]
      expect(markdown, variables.sample).toBeDefined()
    })
    When('deyslide-mcp and Slidev\'s parser split it', () => {
      rust = splitWithRust(markdown)
    })
    Then('both find the same slides, lines, frontmatter, content and speaker notes', () => {
      expect(rustSlides(rust)).toEqual(slidevSlides(markdown))
      expect(rust.slides.length).toBeGreaterThan(0)
    })
    And('both report broken frontmatter on the same slides', () => {
      expect(brokenSlides(rust.frontmatterErrors)).toEqual(brokenSlides(frontmatterErrors(markdown)))
    })
    And('joining the slide texts gives the same Markdown as deck-model\'s joinSlides', () => {
      expect(rust.joined).toBe(joinSlides(slideTexts(markdown)))
    })
  })

  Scenario('Joining slides with an empty first slide matches deck-model', ({ Given, When, Then, And }) => {
    let texts: string[]
    let rust: string
    let model: string
    Given('the slide texts of a deck whose first slide is empty', () => {
      texts = ['', '# Two\n', '---\nlayout: end\n---\n\n# Bye\n']
    })
    When('deyslide-mcp and deck-model\'s joinSlides join them', () => {
      rust = joinWithRust(texts)
      model = joinSlides(texts)
    })
    Then('both give the same Markdown', () => {
      expect(rust).toBe(model)
      expect(rust).toBe('---\n\n# Two\n\n---\nlayout: end\n---\n\n# Bye\n')
    })
    And('splitting that Markdown leaves out the empty first slide in both, as Slidev does', () => {
      expect(splitWithRust(rust).slides.map(slide => slide.content)).toEqual(splitSlides(model).map(slide => slide.content))
      expect(splitSlides(model)).toHaveLength(2)
    })
  })

  ScenarioOutline('Frontmatter YAML is accepted or refused like Slidev', ({ Given, When, Then, And }, variables) => {
    let yaml: string
    let read: ReturnType<typeof readFrontmatter>
    Given('frontmatter with <shape>', () => {
      yaml = FRONTMATTER[variables.shape]
      expect(yaml, variables.shape).toBeDefined()
    })
    When('deyslide-mcp and Slidev\'s parser read it', () => {
      read = readFrontmatter(yaml)
    })
    Then('deyslide-mcp accepts it exactly when Slidev does', () => {
      expect(read.rust.broken, variables.shape).toBe(read.slidev.broken)
    })
    And('where Slidev accepts it, the two read the same values', () => {
      if (!read.slidev.broken)
        expect(read.rust.values, variables.shape).toEqual(read.slidev.values)
    })
  })

  ScenarioOutline('A few rare shapes are still read differently', ({ Given, When, Then }, variables) => {
    let yaml: string
    let read: ReturnType<typeof readFrontmatter>
    Given('frontmatter with <shape>', () => {
      yaml = FRONTMATTER[variables.shape]
      expect(yaml, variables.shape).toBeDefined()
    })
    When('deyslide-mcp and Slidev\'s parser read it', () => {
      read = readFrontmatter(yaml)
    })
    Then('deyslide-mcp <rust> it and Slidev <slidev> it', () => {
      expect(read.rust.broken ? 'refuses' : 'accepts', 'deyslide-mcp').toBe(variables.rust)
      expect(read.slidev.broken ? 'refuses' : 'accepts', 'Slidev').toBe(variables.slidev)
    })
  })
})
