import type { RenderRequest } from '../apps/web/src/preview/protocol'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect, vi } from 'vitest'
import { resolveTransition, slideTransition } from '../apps/web/src/preview/transitions'
import { PreviewFrame } from './support/preview-app'
import { FakeResizeObserver } from './support/resize-observer'

const feature = await loadFeature('./preview-transitions.feature')

const CLICKS = '<v-clicks>\n\n- One\n- Two\n\n</v-clicks>'
const COUNTED = `${CLICKS}\n\n<p class="count">{{ $clicks }}</p>`

/**
 * Every class each slide wrapper wore, even for a moment. Vue adds a
 * transition's classes and takes them off a frame or two later.
 */
function recordClasses(root: Element) {
  const seen = new Map<Element, Set<string>>()
  const note = (element: Element, classes: string | null | undefined) => {
    if (!element.classList?.contains('preview-slide') && !classes?.includes('preview-slide'))
      return
    const set = seen.get(element) ?? new Set<string>()
    for (const name of (classes ?? '').split(/\s+/).filter(Boolean))
      set.add(name)
    seen.set(element, set)
  }
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') {
        note(mutation.target as Element, mutation.oldValue)
        note(mutation.target as Element, (mutation.target as Element).className)
      }
      for (const node of mutation.addedNodes) {
        if (node instanceof Element)
          note(node, node.className)
      }
    }
  })
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: ['class'] })
  return {
    /** The classes of the slide wrapper that showed this text. */
    of: (text: string) => {
      const entry = [...seen].find(([element]) => element.textContent?.includes(text))
      return [...(entry?.[1] ?? [])]
    },
    all: () => [...seen.values()].flatMap(set => [...set]),
    stop: () => observer.disconnect(),
  }
}

describeFeature(feature, ({ Scenario, ScenarioOutline, AfterEachScenario }) => {
  let frame: PreviewFrame
  let classes: ReturnType<typeof recordClasses>
  let headmatter: Record<string, unknown> = {}

  AfterEachScenario(() => {
    classes?.stop()
    frame?.close()
    headmatter = {}
    vi.unstubAllGlobals()
    delete (document as { visibilityState?: unknown }).visibilityState
  })

  /** The scale the slide is drawn at. */
  const scaleOf = () => Number(/scale\(([\d.]+)\)/.exec(frame.find('[data-testid="slide"]')!.style.transform)?.[1])

  async function present(content: string, options: Partial<RenderRequest> = {}, frontmatter: Record<string, unknown> = {}) {
    frame = await new PreviewFrame().open()
    await frame.render({ content, frontmatter }, { mode: 'present', headmatter, ...options })
    classes = recordClasses(frame.find('[data-testid="slide"]')!)
  }

  async function settle() {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  }

  ScenarioOutline('Transition names play the way Slidev plays them', ({ When, Then }, variables) => {
    let played: string | undefined
    When('the transition "<name>" plays <direction>', () => {
      played = resolveTransition(variables.name, variables.direction === 'back')
    })
    Then('the preview plays "<played>"', () => {
      expect(played ?? 'nothing').toBe(variables.played)
    })
  })

  Scenario('A slide\'s own transition comes before the deck\'s', ({ Given, Then, And }) => {
    Given('a deck whose transition is "fade"', () => {
      headmatter = { transition: 'fade' }
    })
    Then('a slide without a transition uses "fade"', () => {
      expect(slideTransition({}, headmatter)).toBe('fade')
    })
    And('a slide whose transition is "slide-up" uses "slide-up"', () => {
      expect(slideTransition({ transition: 'slide-up' }, headmatter)).toBe('slide-up')
    })
  })

  Scenario('Moving to another slide while presenting plays the transition', ({ Given, When, Then, And }) => {
    Given('the preview frame presents a slide titled "One"', () => present('# One'))
    When('the presenter moves forward to "Two" with the transition "slide-left"', async () => {
      await frame.render({ content: '# Two' }, { mode: 'present', transition: { name: 'slide-left', back: false } })
      await settle()
    })
    Then('"Two" enters with "slide-left"', () => {
      expect(classes.of('Two')).toContain('slide-left-enter-active')
    })
    And('"One" leaves with "slide-left"', () => {
      expect(classes.of('One')).toContain('slide-left-leave-active')
    })
  })

  Scenario('Moving back plays the transition in reverse', ({ Given, When, Then }) => {
    Given('the preview frame presents a slide titled "Two"', () => present('# Two'))
    When('the presenter moves back to "One" with the transition "slide-left"', async () => {
      await frame.render({ content: '# One' }, { mode: 'present', transition: { name: 'slide-left', back: true } })
      await settle()
    })
    Then('"One" enters with "slide-right"', () => {
      expect(classes.of('One')).toContain('slide-right-enter-active')
      expect(classes.of('One')).not.toContain('slide-left-enter-active')
    })
  })

  Scenario('The deck\'s transition plays when the move names none', ({ Given, When, Then }) => {
    Given('the preview frame presents a slide titled "One" of a deck whose transition is "fade"', () => {
      headmatter = { transition: 'fade' }
      return present('# One')
    })
    When('the presenter moves forward to "Two" without naming a transition', async () => {
      await frame.render({ content: '# Two' }, { mode: 'present', headmatter, transition: { name: '', back: false } })
      await settle()
    })
    Then('"Two" enters with "fade"', () => {
      expect(classes.of('Two')).toContain('fade-enter-active')
    })
  })

  Scenario('Moving forward plays the transition of the slide being left, as in Slidev', ({ Given, When, Then }) => {
    Given('the preview frame presents a slide titled "One" whose transition is "slide-up", of a deck whose transition is "fade"', () => {
      headmatter = { transition: 'fade' }
      return present('# One', {}, { transition: 'slide-up' })
    })
    When('the presenter moves forward to "Two" without naming a transition', async () => {
      await frame.render({ content: '# Two' }, { mode: 'present', headmatter, transition: { name: '', back: false } })
      await settle()
    })
    Then('"Two" enters with "slide-up"', () => {
      expect(classes.of('Two')).toContain('slide-up-enter-active')
      expect(classes.all()).not.toContain('fade-enter-active')
    })
  })

  Scenario('Moving back plays the transition of the slide being entered, reversed', ({ Given, When, Then }) => {
    Given('the preview frame presents a slide titled "Two" whose transition is "fade", of a deck whose transition is "fade"', () => {
      headmatter = { transition: 'fade' }
      return present('# Two', {}, { transition: 'fade' })
    })
    When('the presenter moves back to "One", whose transition is "slide-up", without naming a transition', async () => {
      await frame.render({ content: '# One', frontmatter: { transition: 'slide-up' } }, { mode: 'present', headmatter, transition: { name: '', back: true } })
      await settle()
    })
    Then('"One" enters with "slide-down"', () => {
      expect(classes.of('One')).toContain('slide-down-enter-active')
      expect(classes.all()).not.toContain('fade-enter-active')
    })
  })

  Scenario('The slide being left keeps showing what it showed until it is gone', ({ Given, When, Then, And }) => {
    let list: Element | null
    /** The page as it was once "Two" came in, before the transition could end. */
    let during: { slides: string[], list: Element | null, hidden: boolean[], count: string } | undefined
    Given('the preview frame presents a list revealed by clicks, at its last click', async () => {
      await present(COUNTED, { clicks: 2 })
      list = frame.find('ul')
    })
    When('the presenter moves forward to "Two" with the transition "slide-left"', async () => {
      const observer = new MutationObserver(() => {
        const slides = frame.findAll('.preview-slide').map(element => element.textContent?.replace(/\s+/g, ' ').trim() ?? '')
        if (!during && slides.includes('Two'))
          during = { slides, list: frame.find('ul'), hidden: frame.findAll('li').map(item => item.classList.contains('slidev-vclick-hidden')), count: frame.find('.count')?.textContent ?? '' }
      })
      observer.observe(frame.find('[data-testid="slide"]')!, { subtree: true, childList: true, attributes: true, characterData: true })
      await frame.render({ content: '# Two' }, { mode: 'present', transition: { name: 'slide-left', back: false } })
      observer.disconnect()
    })
    Then('the list is still mounted beside "Two", with every item shown and its click count unchanged', () => {
      expect(during?.slides).toEqual(['OneTwo2', 'Two'])
      expect(during?.list).toBe(list)
      expect(during?.hidden).toEqual([false, false])
      expect(during?.count).toBe('2')
    })
    And('once the transition ends, only "Two" is mounted', async () => {
      await vi.waitFor(async () => {
        await settle()
        expect(frame.findAll('.preview-slide').map(element => element.textContent?.trim())).toEqual(['Two'])
      })
    })
  })

  Scenario('Stepping through clicks plays no transition', ({ Given, When, Then }) => {
    let shown: Element | null
    let item: Element | null
    Given('the preview frame presents a list revealed by clicks', async () => {
      await present(CLICKS)
      shown = frame.find('.preview-slide')
      item = frame.find('li')
    })
    When('the presenter moves to the next click', async () => {
      await frame.render({ content: CLICKS }, { mode: 'present', clicks: 1, transition: { name: 'slide-left', back: false } })
      await settle()
    })
    Then('no transition plays and the slide stays mounted', () => {
      expect(classes.all().filter(name => name.endsWith('-active'))).toEqual([])
      expect(frame.find('.preview-slide')).toBe(shown)
      // The slide's content too, not only the wrapper around it.
      expect(frame.find('li')).toBe(item)
    })
  })

  Scenario('Editing swaps slides at once', ({ Given, When, Then }) => {
    Given('the preview frame shows a slide titled "One" for editing', () => present('# One', { mode: 'edit' }))
    When('the editor asks for "Two" with the transition "slide-left"', async () => {
      await frame.render({ content: '# Two' }, { transition: { name: 'slide-left', back: false } })
      await settle()
    })
    Then('"Two" replaces "One" with no transition', () => {
      expect(classes.all().filter(name => name.endsWith('-active'))).toEqual([])
      expect(frame.findAll('.preview-slide').map(element => element.textContent?.trim())).toEqual(['Two'])
    })
  })

  Scenario('Quick moves in a window that paints nothing keep only the slide being left', ({ Given, When, Then }) => {
    Given('the preview frame presents a slide titled "One", in a window that paints no frames', async () => {
      await present('# One')
      // A minimized or covered window: no animation frame comes, so no transition ends.
      vi.stubGlobal('requestAnimationFrame', () => 0)
    })
    When('the presenter moves forward to "Two", "Three" and "Four" with the transition "slide-left"', async () => {
      for (const title of ['Two', 'Three', 'Four'])
        await frame.render({ content: `# ${title}` }, { mode: 'present', transition: { name: 'slide-left', back: false } })
    })
    Then('only "Three", on its way out, and "Four" are mounted', () => {
      expect(frame.findAll('.preview-slide').map(element => element.textContent?.trim())).toEqual(['Three', 'Four'])
    })
  })

  Scenario('In a window nobody can see, the next slide replaces the last at once', ({ Given, When, Then }) => {
    Given('the preview frame presents a slide titled "One", in a window nobody can see', async () => {
      await present('# One')
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    })
    When('the presenter moves forward to "Two" with the transition "slide-left"', async () => {
      await frame.render({ content: '# Two' }, { mode: 'present', transition: { name: 'slide-left', back: false } })
      await settle()
    })
    Then('"Two" replaces "One" with no transition', () => {
      expect(classes.all().filter(name => name.endsWith('-active'))).toEqual([])
      expect(frame.findAll('.preview-slide').map(element => element.textContent?.trim())).toEqual(['Two'])
    })
  })

  Scenario('While presenting, the slide covers the whole frame', ({ Given, When, Then }) => {
    Given('the preview frame is shown at 1280 by 720 pixels', async () => {
      frame = await new PreviewFrame().open()
      FakeResizeObserver.resizeAll(1280, 720)
    })
    When('it shows a slide for editing', async () => {
      await frame.render({ content: '# One' })
    })
    Then('the slide fits the frame exactly', () => {
      expect(scaleOf()).toBeCloseTo(1280 / 980, 10)
    })
    When('it presents the slide', async () => {
      await frame.render({ content: '# One' }, { mode: 'present' })
    })
    Then('the slide is at least a pixel taller than the frame, so no dark line shows along its bottom edge', () => {
      expect(551.25 * scaleOf() - 720).toBeGreaterThan(0.999)
      expect(980 * scaleOf()).toBeLessThan(1283)
    })
  })
})
