import type { VueWrapper } from '@vue/test-utils'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { flushPromises, mount } from '@vue/test-utils'
import { expect, vi } from 'vitest'
import { installPreview } from '../apps/web/src/preview/install'
import { LAYOUTS } from '../apps/web/src/preview/layouts'
import { renderSlide } from '../apps/web/src/preview/render'
import { clicks } from '../apps/web/src/preview/state'
import demoMarkdown from '../apps/deck/slides.md?raw'
import { splitSlides } from '../packages/deck-model/src'

const feature = await loadFeature('./slide-preview.feature')

/**
 * The Markdown each scenario renders. It lives here rather than in doc
 * strings, because Gherkin reads lines starting with # or three backticks
 * inside a doc string as a comment or a delimiter.
 */
const SAMPLES: Record<string, string> = {
  'heading and bold text': '# Hello\n\nA **bold** idea',
  'two columns': '# Left\n\n::right::\n\n# Right',
  'a list revealed by clicks': '<v-clicks>\n\n- One\n- Two\n- Three\n\n</v-clicks>',
  'an expression using the click count': `<span class="step">{{ ['a', 'b', 'c'][$clicks] }}</span>`,
  'code containing braces': '```ts\nconst a = {{ b }}\n```',
  'a two step Magic Move': '````md magic-move\n```ts\nlet a = 1\n```\n```ts\nconst a = 1\n```\n````',
  'an ellipse shape': '<DeyslideShape shape="ellipse" fill="#f00" />',
  'a positioned box': '<v-drag pos="100,50,200,80,0">\n\nBox\n\n</v-drag>',
  'an empty v-if': '<div v-if="">oops</div>',
  'a component with attributes on several lines': '<div>\n  <DeyslideShape\n    shape="ellipse"\n    fill="#f00"\n  >\n    <template #default>\n      <span>inside</span>\n    </template>\n  </DeyslideShape>\n</div>',
}

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  let wrapper: VueWrapper | undefined
  let slideClicks = 0
  let error: unknown

  AfterEachScenario(() => {
    wrapper?.unmount()
    wrapper = undefined
    clicks.value = 0
  })

  async function preview(content: string, frontmatter: Record<string, unknown> = {}, first = false) {
    wrapper?.unmount()
    error = undefined
    try {
      const compiled = await renderSlide({ content, frontmatter, first }, LAYOUTS)
      slideClicks = compiled.clicks
      wrapper = mount(compiled.component, { global: { plugins: [{ install: installPreview }] } })
      await flushPromises()
    }
    catch (caught) {
      error = caught
    }
  }

  const find = (selector: string) => wrapper!.find(selector)
  const visible = (text: string) => {
    const item = wrapper!.findAll('li').find(li => li.text() === text)!
    return !item.classes().includes('slidev-vclick-hidden')
  }

  Scenario('Markdown becomes a slide', ({ When, Then, And }) => {
    When('the preview renders the "heading and bold text" sample', () => preview(SAMPLES['heading and bold text']))
    Then('the slide has a heading "Hello"', () => {
      expect(find('h1').text()).toBe('Hello')
    })
    And('the slide shows "bold" in bold', () => {
      expect(find('strong').text()).toBe('bold')
    })
  })

  Scenario('The first slide is a cover, others use the default layout', ({ When, Then }) => {
    When('the preview renders "Title" as the first slide', () => preview('# Title', {}, true))
    Then('the slide uses the "cover" layout', () => {
      expect(find('.slidev-layout').classes()).toContain('cover')
    })
    When('the preview renders "Details" as the second slide', () => preview('# Details'))
    Then('the slide uses the "default" layout', () => {
      expect(find('.slidev-layout').classes()).toContain('default')
    })
  })

  Scenario('Two columns', ({ When, Then, And }) => {
    When('the preview renders the "two columns" sample with the layout "two-cols"', () => preview(SAMPLES['two columns'], { layout: 'two-cols' }))
    Then('the left column shows "Left"', () => {
      expect(find('.col-left').text()).toBe('Left')
    })
    And('the right column shows "Right"', () => {
      expect(find('.col-right').text()).toBe('Right')
    })
  })

  Scenario('Clicks reveal list items one at a time', ({ When, Then }) => {
    When('the preview renders the "a list revealed by clicks" sample', () => preview(SAMPLES['a list revealed by clicks']))
    Then('the slide has 3 clicks', () => {
      expect(slideClicks).toBe(3)
    })
    When('the preview is at click 2', async () => {
      clicks.value = 2
      await flushPromises()
    })
    Then('"One" and "Two" are visible and "Three" is hidden', () => {
      expect([visible('One'), visible('Two'), visible('Three')]).toEqual([true, true, false])
    })
  })

  Scenario('The click count drives expressions', ({ When, And, Then }) => {
    When('the preview renders the "an expression using the click count" sample', () => preview(SAMPLES['an expression using the click count']))
    And('the preview is at click 1', async () => {
      clicks.value = 1
      await flushPromises()
    })
    Then('the slide shows "b"', () => {
      expect(find('.step').text()).toBe('b')
    })
  })

  Scenario('Code is highlighted and never run as a template', ({ When, Then }) => {
    When('the preview renders the "code containing braces" sample', () => preview(SAMPLES['code containing braces']))
    Then('the slide shows highlighted code reading "const a = {{ b }}"', () => {
      const code = find('pre.slidev-code')
      expect(code.classes()).toContain('shiki')
      expect(code.text()).toBe('const a = {{ b }}')
      expect(code.findAll('span[style]').length).toBeGreaterThan(1)
    })
  })

  Scenario('A Magic Move steps through its code', ({ When, Then, And }) => {
    When('the preview renders the "a two step Magic Move" sample', () => preview(SAMPLES['a two step Magic Move']))
    Then('the slide has 1 click', () => {
      expect(slideClicks).toBe(1)
    })
    And('the code shows "let a = 1"', async () => {
      await vi.waitFor(() => expect(find('.slidev-code-magic-move').text()).toContain('let a = 1'))
    })
  })

  Scenario('Deyslide components render', ({ When, Then }) => {
    When('the preview renders the "an ellipse shape" sample', () => preview(SAMPLES['an ellipse shape']))
    Then('the slide has an ellipse shape', async () => {
      await vi.waitFor(() => expect(find('.deyslide-shape').attributes('data-shape')).toBe('ellipse'))
    })
  })

  Scenario('Positioned elements use Slidev canvas units', ({ When, Then }) => {
    When('the preview renders the "a positioned box" sample', () => preview(SAMPLES['a positioned box']))
    Then('"Box" is placed at left 100, top 50, width 200 and height 80', () => {
      const style = find('.v-drag').attributes('style')
      expect(style).toContain('left: 100px')
      expect(style).toContain('top: 50px')
      expect(style).toContain('width: 200px')
      expect(style).toContain('height: 80px')
      expect(find('.v-drag').text()).toBe('Box')
    })
  })

  Scenario('A broken template is reported', ({ When, Then }) => {
    When('the preview renders the "an empty v-if" sample', () => preview(SAMPLES['an empty v-if']))
    Then('the preview reports an error', () => {
      expect((error as Error).name).toBe('Error')
      expect((error as Error).message).not.toBe('')
    })
  })

  Scenario('A component whose tag spans several lines', ({ When, Then }) => {
    When('the preview renders the "a component with attributes on several lines" sample', () => preview(SAMPLES['a component with attributes on several lines']))
    Then('the slide has an ellipse shape', async () => {
      expect(error).toBeUndefined()
      await vi.waitFor(() => expect(find('.deyslide-shape').attributes('data-shape')).toBe('ellipse'))
    })
  })

  Scenario('Every slide of the demo deck renders', ({ When, Then, And }) => {
    const results: { clicks?: number, error?: string }[] = []
    When('the preview renders each slide of the demo deck', async () => {
      for (const [index, slide] of splitSlides(demoMarkdown).entries()) {
        try {
          const compiled = await renderSlide({ content: slide.content, frontmatter: slide.frontmatter, first: index === 0 }, LAYOUTS)
          results.push({ clicks: compiled.clicks })
        }
        catch (caught) {
          results.push({ error: (caught as Error).message })
        }
      }
    })
    Then('none of them reports an error', () => {
      expect(results.filter(result => result.error)).toEqual([])
    })
    And('their clicks are 0, 2, 3, 0 and 0', () => {
      expect(results.map(result => result.clicks)).toEqual([0, 2, 3, 0, 0])
    })
  })
})
