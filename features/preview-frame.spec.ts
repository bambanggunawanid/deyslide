import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { flushPromises } from '@vue/test-utils'
import { expect, vi } from 'vitest'
import { REPLACED } from '../apps/web/src/preview/protocol'
import { useNav, useSlideContext } from '../apps/web/src/preview/slidev-client'
import { PreviewFrame } from './support/preview-app'
import { FakeResizeObserver } from './support/resize-observer'

const feature = await loadFeature('./preview-frame.feature')

/** Slides each scenario renders. Kept here, since Gherkin reads lines starting with # or three backticks as comments or delimiters. */
const SAMPLES = {
  'clicks': '<v-clicks>\n\n- One\n- Two\n- Three\n\n</v-clicks>',
  'broken': '<div v-if="">oops</div>',
  'magic move': '````md magic-move\n```ts\nlet a = 1\n```\n```ts\nconst a = 1\n```\n````',
  'other': '# Something else',
  'box': '<v-drag pos="100,50,200,80,0" data-id="box">\n\nBox\n\n</v-drag>',
  'context': '<p class="title">{{ $frontmatter.title }}</p>\n<p class="click">{{ $slidev.nav.clicks }}</p>',
  'media': '<img src="/api/media/m1/file" alt="Diagram">',
  'throws': '<v-clicks>\n\n- One\n- Two\n\n</v-clicks>\n\n<p>{{ missing.name }}</p>',
  'throws later': '<v-clicks>\n\n- One\n- Two\n\n</v-clicks>\n\n<p class="probe">{{ $clicks > 0 ? missing.name : "fine" }}</p>',
  'code': '# Fonts\n\n`inline`',
  'controls': '<button class="act">Act</button>\n\n<input class="field" type="text">\n\n<p class="words">Words</p>',
  'built-in ids': '<v-drag pos="100,50,200,80,0" data-id="constructor">\n\nOne\n\n</v-drag>\n\n<v-drag pos="400,60,200,80,0" data-id="__proto__">\n\nTwo\n\n</v-drag>',
}

const SIGNED = 'https://media.example/m1?X-Signature=a1&expires=9'

/** happy-dom's switch for what its fetch answers. */
interface FetchInterceptor { beforeAsyncRequest: (context: { request: Request }) => Promise<Response | void> }
const happyDom = () => (window as unknown as { happyDOM: { settings: { fetch: { interceptor: FetchInterceptor | null } } } }).happyDOM.settings

const STYLESHEET = 'body { margin: 0 }'

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  let frame: PreviewFrame
  let answer: Awaited<ReturnType<PreviewFrame['render']>> | undefined
  let shown: Element | null = null
  let shownMagicMove: Element | null = null
  /** Font stylesheets the page asked for, and a way to let the held ones arrive. */
  let fontRequests: string[] = []
  let releaseFonts: (() => void) | undefined

  AfterEachScenario(() => {
    releaseFonts?.()
    releaseFonts = undefined
    fontRequests = []
    happyDom().fetch.interceptor = null
    frame?.close()
    answer = undefined
    shown = null
    shownMagicMove = null
  })

  async function open() {
    frame = await new PreviewFrame().open()
  }

  /** Font stylesheets wait until `releaseFonts`, or fail at once, like a frame without a network. */
  function interceptFonts(outcome: 'held' | 'failing') {
    const held = new Promise<void>((resolve) => {
      releaseFonts = resolve
    })
    happyDom().fetch.interceptor = {
      beforeAsyncRequest: async ({ request }) => {
        if (!request.url.startsWith('https://fonts.googleapis.com/'))
          return
        fontRequests.push(request.url)
        if (outcome === 'failing')
          return new Response('', { status: 500 })
        await held
        return new Response(STYLESHEET, { headers: { 'content-type': 'text/css' } })
      },
    }
  }

  const fontLinks = () => [...document.head.querySelectorAll<HTMLLinkElement>('link[data-deck-fonts]')]
  const magicStep = () => frame.find('.slidev-code-magic-move')?.getAttribute('data-step')
  const box = (id = 'box') => frame.findAll('.v-drag').find(element => element.dataset.id === id)!

  async function showMagicMove(mode?: 'print') {
    await open()
    await frame.render({ content: SAMPLES['magic move'] }, { mode })
    shown = frame.find('.preview-slide')
    shownMagicMove = frame.find('.slidev-code-magic-move')
    expect(magicStep()).toBe('0')
  }

  async function showBox() {
    await open()
    await frame.render({ content: SAMPLES.box })
    shown = frame.find('.preview-slide')
  }

  function expectBoxAt(left: number, top: number, id = 'box') {
    expect(frame.find('.preview-slide')).toBe(shown)
    expect(box(id).style.left).toBe(`${left}px`)
    expect(box(id).style.top).toBe(`${top}px`)
  }

  Scenario('Replies carry the id of their render', ({ Given, When, Then }) => {
    Given('the preview frame is open', open)
    When('the editor asks it to render a list revealed by clicks with the id "first"', async () => {
      answer = await frame.render({ content: SAMPLES.clicks }, { id: 'first' })
    })
    Then('the frame answers "rendered" for "first" with 3 clicks', () => {
      expect(answer).toEqual({ type: 'deyslide:rendered', id: 'first', clicks: 3 })
    })
  })

  Scenario('A slide that does not compile is reported with its id', ({ Given, When, Then }) => {
    Given('the preview frame is open', open)
    When('the editor asks it to render a broken slide with the id "broken"', async () => {
      answer = await frame.render({ content: SAMPLES.broken }, { id: 'broken' })
    })
    Then('the frame answers "error" for "broken" with the reason', () => {
      expect(answer?.type).toBe('deyslide:error')
      expect(answer?.id).toBe('broken')
      expect(answer && 'message' in answer && answer.message).toBeTruthy()
      expect(frame.find('[data-testid="preview-error"]')?.textContent).toContain((answer as { message: string }).message)
    })
  })

  Scenario('A render that a newer one overtakes still gets a reply', ({ Given, When, Then, And }) => {
    Given('the preview frame is open', open)
    When('the editor asks for a slide with the id "older" and at once for another with the id "newer"', () => {
      // Both arrive before the first one has compiled.
      frame.send({ type: 'deyslide:render', id: 'older', slide: { content: '# Older', frontmatter: {}, first: false }, headmatter: {}, clicks: 0 })
      frame.send({ type: 'deyslide:render', id: 'newer', slide: { content: '# Newer', frontmatter: {}, first: false }, headmatter: {}, clicks: 0 })
    })
    Then('the frame tells "older" that a newer render replaced it', async () => {
      expect(await frame.answerFor('older', ['deyslide:rendered', 'deyslide:error'])).toEqual({ type: 'deyslide:error', id: 'older', message: REPLACED })
    })
    And('the frame answers "rendered" for "newer", whose slide is the one on screen', async () => {
      expect(await frame.answerFor('newer', ['deyslide:rendered', 'deyslide:error'])).toMatchObject({ type: 'deyslide:rendered', id: 'newer' })
      await flushPromises()
      expect(frame.findAll('.preview-slide').map(element => element.textContent?.trim())).toEqual(['Newer'])
      expect(frame.answers.filter(item => 'id' in item && item.id === 'older')).toHaveLength(1)
    })
  })

  Scenario('Stepping through clicks keeps the slide mounted', ({ Given, When, Then, And }) => {
    Given('the preview frame shows a Magic Move at click 0', () => showMagicMove())
    When('the editor asks for click 1 of the same slide', async () => {
      answer = await frame.render({ content: SAMPLES['magic move'] }, { clicks: 1 })
    })
    Then('the slide on screen is the same one, not mounted again', () => {
      expect(answer?.type).toBe('deyslide:rendered')
      expect(frame.find('.preview-slide')).toBe(shown)
      expect(frame.findAll('.preview-slide')).toHaveLength(1)
      // The slide's own content too: a component swapped inside the same wrapper would mount Magic Move again.
      expect(frame.find('.slidev-code-magic-move')).toBe(shownMagicMove)
    })
    And('the Magic Move shows its second step', () => {
      expect(magicStep()).toBe('1')
    })
  })

  Scenario('A click past the last one stops at the last one', ({ Given, When, Then }) => {
    Given('the preview frame shows a Magic Move at click 0', () => showMagicMove())
    When('the editor asks for click 5 of the same slide', async () => {
      answer = await frame.render({ content: SAMPLES['magic move'] }, { clicks: 5 })
    })
    Then('the Magic Move shows its second step', () => {
      expect(answer).toMatchObject({ type: 'deyslide:rendered', clicks: 1 })
      expect(magicStep()).toBe('1')
    })
  })

  Scenario('Print mode mounts the slide afresh at every click', ({ Given, When, Then, And }) => {
    Given('the preview frame shows a Magic Move at click 0 in print mode', () => showMagicMove('print'))
    When('the editor asks for click 1 of the same slide in print mode', async () => {
      answer = await frame.render({ content: SAMPLES['magic move'] }, { clicks: 1, mode: 'print' })
    })
    Then('the slide is mounted afresh', () => {
      expect(answer).toMatchObject({ type: 'deyslide:rendered', clicks: 1 })
      expect(frame.find('.preview-slide')).not.toBe(shown)
      expect(frame.find('.slidev-code-magic-move')).not.toBe(shownMagicMove)
      expect(frame.findAll('.preview-slide')).toHaveLength(1)
    })
    And('the Magic Move shows its second step', () => {
      expect(magicStep()).toBe('1')
    })
  })

  Scenario('An error a slide throws stays reported while stepping through clicks', ({ Given, Then, When }) => {
    const errors = () => frame.answers.filter(item => item.type === 'deyslide:error')
    Given('the preview frame shows a slide with clicks whose expression throws', async () => {
      await open()
      answer = await frame.render({ content: SAMPLES.throws }, { id: 'throws' })
    })
    Then('the frame reports what the slide threw', async () => {
      expect(answer).toMatchObject({ type: 'deyslide:rendered', id: 'throws' })
      await vi.waitFor(() => expect(errors()).toHaveLength(1))
      expect(errors()[0]).toMatchObject({ id: 'throws', message: expect.stringContaining('missing') })
      expect(frame.find('[data-testid="preview-error"]')?.textContent).toContain('missing')
    })
    When('the editor asks for click 1 of the same slide', async () => {
      answer = await frame.render({ content: SAMPLES.throws }, { id: 'step', clicks: 1 })
    })
    Then('the frame answers "rendered" and reports what the slide threw again', async () => {
      expect(answer).toMatchObject({ type: 'deyslide:rendered', id: 'step' })
      await vi.waitFor(() => expect(errors().map(item => item.id)).toEqual(['throws', 'step']))
      expect(frame.find('[data-testid="preview-error"]')?.textContent).toContain('missing')
    })
  })

  Scenario('An error a slide throws at one click clears when stepping back', ({ Given, When, Then }) => {
    const errors = () => frame.answers.filter(item => item.type === 'deyslide:error')
    Given('the preview frame shows a slide whose expression throws only after the first click', async () => {
      await open()
      answer = await frame.render({ content: SAMPLES['throws later'] }, { id: 'zero' })
      expect(answer).toMatchObject({ type: 'deyslide:rendered', id: 'zero' })
      expect(frame.find('.probe')?.textContent).toBe('fine')
    })
    When('the editor asks for click 1 of the same slide', async () => {
      answer = await frame.render({ content: SAMPLES['throws later'] }, { id: 'one', clicks: 1 })
    })
    Then('the frame reports what the slide threw at that click', async () => {
      await vi.waitFor(() => expect(errors()).toHaveLength(1))
      expect(errors()[0]).toMatchObject({ id: 'one', message: expect.stringContaining('missing') })
      expect(frame.find('[data-testid="preview-error"]')?.textContent).toContain('missing')
    })
    When('the editor asks for click 0 of the same slide', async () => {
      answer = await frame.render({ content: SAMPLES['throws later'] }, { id: 'back' })
    })
    Then('the frame answers "rendered" with no error, and the slide shows no error', async () => {
      expect(answer).toMatchObject({ type: 'deyslide:rendered', id: 'back' })
      // Long enough for an error the slide throws on mounting to arrive.
      await new Promise(resolve => setTimeout(resolve, 50))
      await flushPromises()
      expect(errors().map(item => item.id)).toEqual(['one'])
      expect(frame.find('[data-testid="preview-error"]')).toBeNull()
      expect(frame.find('.probe')?.textContent).toBe('fine')
    })
  })

  Scenario('Changing the slide mounts it again', ({ Given, When, Then }) => {
    Given('the preview frame shows a Magic Move at click 0', () => showMagicMove())
    When('the editor asks for a slide with other content', async () => {
      await frame.render({ content: SAMPLES.other })
    })
    Then('a new slide replaces the old one', () => {
      const now = frame.find('.preview-slide')
      expect(now).not.toBe(shown)
      expect(now?.querySelector('h1')?.textContent).toBe('Something else')
      expect(frame.findAll('.preview-slide')).toHaveLength(1)
    })
  })

  Scenario('Positions move an element until the next render', ({ Given, When, Then }) => {
    Given('the preview frame shows the box "box" at left 100 and top 50', showBox)
    When('the editor sends the position left 300 and top 120 for "box"', async () => {
      frame.send({ type: 'deyslide:positions', positions: { box: { x: 300, y: 120, w: 200, h: 80, rotate: 0 } } })
      await flushPromises()
    })
    Then('the box is placed at left 300 and top 120 on the same slide', () => expectBoxAt(300, 120))
    When('the editor asks for the same slide again', async () => {
      await frame.render({ content: SAMPLES.box })
    })
    Then('the box is placed at left 100 and top 50 on the same slide', () => expectBoxAt(100, 50))
  })

  Scenario('Positions that cannot be shown are ignored', ({ Given, When, Then }) => {
    Given('the preview frame shows the box "box" at left 100 and top 50', showBox)
    When('the editor sends a position for "box" whose width is negative', async () => {
      frame.send({ type: 'deyslide:positions', positions: { box: { x: 300, y: 120, w: -5, h: 80, rotate: 0 } } })
      await flushPromises()
    })
    Then('the box is placed at left 100 and top 50 on the same slide', () => expectBoxAt(100, 50))
  })

  Scenario('The frame tells the editor how large each positioned element is laid out', ({ Given, Then, When }) => {
    const sizes = () => frame.answers.filter(answer => answer.type === 'deyslide:sizes').map(answer => answer.sizes)
    Given('the preview frame shows the box "box" at left 100 and top 50', showBox)
    Then('the frame tells the editor the size "box" is laid out at', async () => {
      // happy-dom lays nothing out, so every size reads 0 here.
      await vi.waitFor(() => expect(sizes().at(-1)).toEqual({ box: { w: 0, h: 0 } }))
    })
    When('the box\'s content grows to 200 by 130', () => {
      Object.defineProperties(box('box'), { offsetWidth: { value: 200 }, offsetHeight: { value: 130 } })
      FakeResizeObserver.resizeAll(980, 551.25)
    })
    Then('the frame tells the editor "box" is 200 by 130', async () => {
      await vi.waitFor(() => expect(sizes().at(-1)).toEqual({ box: { w: 200, h: 130 } }))
    })
  })

  Scenario('Ids that name built-in properties are ordinary ids', ({ Given, Then, When }) => {
    Given('the preview frame shows boxes whose ids are "constructor" and "__proto__"', async () => {
      await open()
      await frame.render({ content: SAMPLES['built-in ids'] })
      shown = frame.find('.preview-slide')
    })
    Then('both boxes are placed where the slide puts them', () => {
      expectBoxAt(100, 50, 'constructor')
      expectBoxAt(400, 60, '__proto__')
    })
    When('the editor sends the position left 300 and top 120 for "__proto__"', async () => {
      // Parsed from JSON, so `__proto__` is a key of its own, as in a message the editor posts.
      frame.send({ type: 'deyslide:positions', positions: JSON.parse('{"__proto__":{"x":300,"y":120,"w":200,"h":80,"rotate":0}}') })
      await flushPromises()
    })
    Then('the box "__proto__" moves there and the box "constructor" stays', () => {
      expectBoxAt(300, 120, '__proto__')
      expectBoxAt(100, 50, 'constructor')
    })
  })

  Scenario('Print mode tells components the slide is being exported', ({ Given, When, Then }) => {
    Given('the preview frame is open', open)
    When('the editor asks it to render a slide in print mode', async () => {
      await frame.render({ content: SAMPLES.other }, { mode: 'print' })
    })
    Then('the preview\'s own Slidev stub reports print mode', () => {
      expect(useNav().isPrintMode.value).toBe(true)
    })
    When('the editor asks it to render the slide for editing', async () => {
      await frame.render({ content: SAMPLES.other })
    })
    Then('the preview\'s own Slidev stub no longer reports print mode', () => {
      expect(useNav().isPrintMode.value).toBe(false)
    })
  })

  Scenario('Slides read their frontmatter and clicks the way Slidev slides do', ({ Given, When, Then, And }) => {
    Given('the preview frame is open', open)
    When('the editor asks it to render a slide titled "Graphs" that shows $frontmatter and $slidev, at click 1', async () => {
      await frame.render({ content: SAMPLES.context, frontmatter: { title: 'Graphs', clicks: 2 } }, { clicks: 1 })
    })
    Then('the slide shows the title "Graphs" and the click 1', () => {
      expect(frame.find('.title')?.textContent).toBe('Graphs')
      expect(frame.find('.click')?.textContent).toBe('1')
    })
    And('the preview\'s own Slidev stub gives components the frontmatter and the click', () => {
      const context = useSlideContext()
      expect(context.$frontmatter).toEqual({ title: 'Graphs', clicks: 2 })
      expect(context.$slidev.nav.clicks).toBe(1)
      expect(context.$slidev.nav.clicksTotal).toBe(2)
      expect(useNav().clicks.value).toBe(1)
    })
  })

  Scenario('Media links the frame cannot load are swapped', ({ Given, When, Then }) => {
    Given('the preview frame is open', open)
    When('the editor asks it to render an image from "/api/media/m1/file" with a signed link for it', async () => {
      await frame.render({ content: SAMPLES.media }, { media: { '/api/media/m1/file': SIGNED } })
    })
    Then('the image loads the signed link', () => {
      expect(frame.find<HTMLImageElement>('img')?.getAttribute('src')).toBe(SIGNED)
    })
  })

  Scenario('Deck fonts load without holding up the slide', ({ Given, When, Then, And }) => {
    Given('the preview frame is open, with font stylesheets slow to arrive', async () => {
      interceptFonts('held')
      await open()
    })
    When('the editor asks it to render a deck whose fonts are "Inter" and "JetBrains Mono"', async () => {
      answer = await frame.render({ content: SAMPLES.code, first: true }, { headmatter: { fonts: { sans: 'Inter', mono: 'JetBrains Mono' } } })
    })
    Then('the frame answers while the font stylesheet is still loading', () => {
      expect(answer?.type).toBe('deyslide:rendered')
      // Asked for, and neither loaded (no sheet yet) nor failed (still on the page).
      expect(fontRequests).toHaveLength(1)
      expect(fontLinks()).toHaveLength(1)
      expect(fontLinks()[0].sheet).toBeNull()
    })
    And('the page asks Google Fonts for Inter and JetBrains Mono', () => {
      expect(fontLinks().map(link => link.getAttribute('href'))).toEqual(['https://fonts.googleapis.com/css2?family=Inter:wght@200;400;600&family=JetBrains+Mono:wght@200;400;600&display=swap'])
      expect(fontRequests).toEqual(['https://fonts.googleapis.com/css2?family=Inter:wght@200;400;600&family=JetBrains+Mono:wght@200;400;600&display=swap'])
    })
    And('the slide uses Inter with Slidev\'s fallbacks, and JetBrains Mono for code', () => {
      const page = frame.find('[data-testid="slide"]')!
      expect(page.style.getPropertyValue('--deck-font-sans')).toMatch(/^"Inter", ui-sans-serif, system-ui, /)
      expect(page.style.getPropertyValue('--deck-font-mono')).toMatch(/^"JetBrains Mono", ui-monospace, /)
    })
  })

  Scenario('A font stylesheet that fails is not asked for again', ({ Given, When, Then }) => {
    const headmatter = { fonts: { sans: 'Missing Sans' } }
    Given('the preview frame is open, with font stylesheets failing to load', async () => {
      interceptFonts('failing')
      await open()
    })
    When('the editor asks it to render a deck whose fonts are "Missing Sans"', async () => {
      answer = await frame.render({ content: '# One', first: true }, { headmatter })
      expect(answer?.type).toBe('deyslide:rendered')
    })
    Then('the stylesheet is removed once it fails', async () => {
      await vi.waitFor(() => expect(fontRequests).toHaveLength(1))
      await vi.waitFor(() => expect(fontLinks()).toEqual([]))
    })
    When('the editor asks for another slide of the same deck', async () => {
      answer = await frame.render({ content: '# Two' }, { headmatter })
      expect(answer?.type).toBe('deyslide:rendered')
    })
    Then('the page does not ask Google Fonts for it again', async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(fontLinks()).toEqual([])
      expect(fontRequests).toHaveLength(1)
    })
  })

  /** What the frame passed on to the page: presses and keys. */
  const passedOn = () => frame.answers.filter(item => item.type === 'deyslide:pointer' || item.type === 'deyslide:key')

  async function pressOn(selector: string, x: number, y: number) {
    const target = frame.find(selector)!
    for (const type of ['pointerdown', 'pointerup'])
      target.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', button: 0, bubbles: true, composed: true }))
    await flushPromises()
  }

  async function keyOn(selector: string, key: string) {
    frame.find(selector)!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, composed: true }))
    await flushPromises()
  }

  const pressBoth = async () => {
    await pressOn('.words', 200, 150)
    await pressOn('.act', 40, 30)
  }
  const keyBoth = async () => {
    await keyOn('.words', 'ArrowRight')
    await keyOn('.field', 'a')
  }

  Scenario('While presenting, presses and keys on the slide go to the page too', ({ Given, When, Then }) => {
    Given('the preview frame presents a slide with a button, a text field and a paragraph', async () => {
      await open()
      await frame.render({ content: SAMPLES.controls }, { mode: 'present' })
    })
    When('the audience presses the paragraph, then the button', pressBoth)
    Then('the frame passes on both presses at their positions, the button\'s as one the slide uses', () => {
      const press = (phase: string, x: number, y: number, interactive: boolean) => ({ type: 'deyslide:pointer', phase, pointerId: 1, pointerType: 'mouse', button: 0, x, y, interactive })
      // The frame posts its messages, which arrive a moment later.
      return vi.waitFor(() => expect(passedOn()).toEqual([
        press('down', 200, 150, false),
        press('up', 200, 150, false),
        press('down', 40, 30, true),
        press('up', 40, 30, true),
      ]))
    })
    When('someone presses "ArrowRight" on the paragraph and types "a" in the text field', async () => {
      frame.answers.length = 0
      await keyBoth()
    })
    Then('the frame passes on both keys, the second as typed in a field', () => {
      const key = (name: string, target: string) => ({ type: 'deyslide:key', key: name, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, target })
      return vi.waitFor(() => expect(passedOn()).toEqual([key('ArrowRight', 'none'), key('a', 'text')]))
    })
  })

  Scenario('While presenting, the frame hides the pointer when the page asks', ({ Given, When, Then }) => {
    const hidden = () => document.documentElement.classList.contains('preview-cursor-hidden')
    const rests = async (value: boolean) => {
      frame.send({ type: 'deyslide:cursor', hidden: value })
      await flushPromises()
    }
    Given('the preview frame presents a slide with a button, a text field and a paragraph', async () => {
      await open()
      await frame.render({ content: SAMPLES.controls }, { mode: 'present' })
    })
    When('the page says the pointer rests', () => rests(true))
    Then('the pointer is hidden over the whole slide', () => {
      // styles.css hides it for every element under this class, the slide's own buttons included.
      expect(hidden()).toBe(true)
    })
    When('the page says the pointer moves again', () => rests(false))
    Then('the pointer shows over the slide', () => {
      expect(hidden()).toBe(false)
    })
    When('the page says the pointer rests while the frame shows a slide for editing', async () => {
      await frame.render({ content: SAMPLES.controls })
      await rests(true)
    })
    Then('the pointer stays shown, since only presenting hides it', () => {
      expect(hidden()).toBe(false)
    })
  })

  Scenario('Editing passes on no presses and no keys', ({ Given, When, Then, And }) => {
    Given('the preview frame shows a slide with a button, a text field and a paragraph for editing', async () => {
      await open()
      await frame.render({ content: SAMPLES.controls })
    })
    When('the audience presses the paragraph, then the button', pressBoth)
    And('someone presses "ArrowRight" on the paragraph and types "a" in the text field', keyBoth)
    Then('the frame passes on nothing', async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(passedOn()).toEqual([])
    })
  })
})
