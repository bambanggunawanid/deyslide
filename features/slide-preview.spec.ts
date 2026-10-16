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
  'the click count read through $slidev': '<span class="step">{{ $slidev.nav.clicks }}</span>',
  'images from the media library': '<img src="/api/media/m1/file" alt="Diagram">\n\n![Chart](/api/media/m1/file)\n\nThe file lives at `/api/media/m1/file`.',
  'a poster and an inline style from the media library': '<video src="/api/media/m2/file" poster="/api/media/m1/file"></video>\n\n<div class="panel" style="background-image: url(\'/api/media/m1/file\'); color: red"></div>',
  'code containing braces': '```ts\nconst a = {{ b }}\n```',
  'a two step Magic Move': '````md magic-move\n```ts\nlet a = 1\n```\n```ts\nconst a = 1\n```\n````',
  'an ellipse shape': '<DeyslideShape shape="ellipse" fill="#f00" />',
  'a positioned box': '<v-drag pos="100,50,200,80,0">\n\nBox\n\n</v-drag>',
  'an empty v-if': '<div v-if="">oops</div>',
  'v-click elements': '<v-click>\n\n<p class="first">First</p>\n\n</v-click>\n\n<p class="second-line"><v-click>Second</v-click></p>\n\n<v-click hide at="+1"><p class="hidden-at-three">Hidden at three</p></v-click>\n\n<v-click at="4"><p class="fourth">Fourth</p></v-click>',
  'a v-after element': '<p v-click class="shown">Shown</p>\n\n<v-after><p class="also">Also shown</p></v-after>',
  'a component with attributes on several lines': '<div>\n  <DeyslideShape\n    shape="ellipse"\n    fill="#f00"\n  >\n    <template #default>\n      <span>inside</span>\n    </template>\n  </DeyslideShape>\n</div>',
}

describeFeature(feature, ({ Scenario, ScenarioOutline, AfterEachScenario }) => {
  let wrapper: VueWrapper | undefined
  let slideClicks = 0
  let error: unknown

  AfterEachScenario(() => {
    wrapper?.unmount()
    wrapper = undefined
    clicks.value = 0
  })

  async function preview(content: string, frontmatter: Record<string, unknown> = {}, first = false, media?: Record<string, string>) {
    wrapper?.unmount()
    error = undefined
    try {
      const compiled = await renderSlide({ content, frontmatter, first }, LAYOUTS, media)
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

  const hidden = (selector: string) => find(selector).classes().includes('slidev-vclick-hidden')
  const at = async (count: number) => {
    clicks.value = count
    await flushPromises()
  }

  Scenario('The v-click element reveals its content at its click, as in Slidev', ({ When, Then, And }) => {
    When('the preview renders the "v-click elements" sample', () => preview(SAMPLES['v-click elements']))
    Then('the slide has 4 clicks', () => {
      expect(error).toBeUndefined()
      expect(slideClicks).toBe(4)
    })
    And('at click 0 only "Hidden at three" shows', () => {
      expect([hidden('.first'), hidden('.second-line > span'), hidden('.hidden-at-three'), hidden('.fourth')]).toEqual([true, true, false, true])
    })
    When('the preview is at click 1', () => at(1))
    Then('"First" and "Hidden at three" show, and the text "Second" is wrapped in a hidden span', () => {
      expect(find('.second-line > span').text()).toBe('Second')
      expect([hidden('.first'), hidden('.second-line > span'), hidden('.hidden-at-three')]).toEqual([false, true, false])
    })
    When('the preview is at click 3', () => at(3))
    Then('"First" and "Second" show and "Hidden at three" is hidden', () => {
      expect([hidden('.first'), hidden('.second-line > span'), hidden('.hidden-at-three'), hidden('.fourth')]).toEqual([false, false, true, true])
    })
    When('the preview is at click 4', () => at(4))
    Then('"Fourth" shows too', () => {
      expect(hidden('.fourth')).toBe(false)
    })
  })

  Scenario('The v-after element shows with the click before it', ({ When, Then }) => {
    When('the preview renders the "a v-after element" sample', () => preview(SAMPLES['a v-after element']))
    Then('the slide has 1 click', () => {
      expect(slideClicks).toBe(1)
      expect([hidden('.shown'), hidden('.also')]).toEqual([true, true])
    })
    When('the preview is at click 1', () => at(1))
    Then('"Shown" and "Also shown" show together', () => {
      expect([hidden('.shown'), hidden('.also')]).toEqual([false, false])
    })
  })

  ScenarioOutline('Image layouts show their image', ({ When, Then }, variables) => {
    const image = 'data:image/png;base64,iVBORw0KGgo='
    When('the preview renders "Pictures" with the layout "<layout>" and an image', () => preview('# Pictures', { layout: variables.layout, image }))
    Then('the slide shows "Pictures" and the image as a background <where>', () => {
      expect(find('h1').text()).toBe('Pictures')
      const pictured = wrapper!.findAll('[style]').filter(element => element.attributes('style')?.includes(`url("${image}")`))
      expect(pictured).toHaveLength(1)
      const [picture] = pictured
      if (variables.layout === 'image') {
        // The text sits on the picture.
        expect(picture.find('h1').exists()).toBe(true)
      }
      else {
        // Two columns: the picture is one, the text the other, in Slidev's order.
        const columns = wrapper!.find('.grid-cols-2').element.children
        expect(columns).toHaveLength(2)
        const side = variables.layout === 'image-right' ? 1 : 0
        expect(columns[side]).toBe(picture.element)
        expect(columns[1 - side].querySelector('h1')?.textContent).toBe('Pictures')
      }
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

  Scenario('Slides read the click count through $slidev, as in Slidev', ({ When, And, Then }) => {
    When('the preview renders the "the click count read through $slidev" sample', () => preview(SAMPLES['the click count read through $slidev']))
    And('the preview is at click 2', async () => {
      clicks.value = 2
      await flushPromises()
    })
    Then('the slide shows "2"', () => {
      expect(find('.step').text()).toBe('2')
    })
  })

  Scenario('Media links are swapped for ones the preview can load', ({ When, Then, And }) => {
    const signed = 'https://media.example/m1?X-Signature=a1&expires=9'
    When('the preview renders the "images from the media library" sample with "/api/media/m1/file" mapped to a signed link', () => preview(SAMPLES['images from the media library'], {}, false, { '/api/media/m1/file': signed }))
    Then('both images load the signed link', () => {
      expect(wrapper!.findAll('img').map(image => image.attributes('src'))).toEqual([signed, signed])
    })
    And('the text that mentions "/api/media/m1/file" is unchanged', () => {
      expect(find('code').text()).toBe('/api/media/m1/file')
    })
  })

  Scenario('Media links in a cover background, a video poster and an inline style are swapped too', ({ When, Then }) => {
    const signed = 'https://media.example/m1?X-Signature=a1&expires=9'
    When('the preview renders the "a poster and an inline style from the media library" sample on a cover whose background is "/api/media/m1/file", mapped to a signed link', () => preview(SAMPLES['a poster and an inline style from the media library'], { layout: 'cover', background: '/api/media/m1/file' }, false, { '/api/media/m1/file': signed }))
    Then('the cover background, the video poster and the inline style load the signed link', () => {
      expect(find('.slidev-layout.cover').attributes('style')).toContain(`url("${signed}")`)
      expect(find('video').attributes('poster')).toBe(signed)
      // A link with no entry in the map stays as written.
      expect(find('video').attributes('src')).toBe('/api/media/m2/file')
      expect(find('.panel').attributes('style')).toContain(`url("${signed}")`)
      expect(find('.panel').attributes('style')).toContain('color: red')
      expect(wrapper!.html()).not.toContain('/api/media/m1/file')
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
