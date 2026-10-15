import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect, vi } from 'vitest'
import { loading } from '../apps/web/src/preview/state'
import { PreviewFrame } from './support/preview-app'
import { FakeResizeObserver } from './support/resize-observer'

/**
 * happy-dom cannot draw, so html-to-image is replaced: it records what it
 * was asked to draw and returns a PNG signature. The real library runs in
 * Chromium in the end to end check.
 */
const drawing = vi.hoisted(() => ({
  calls: [] as { node: HTMLElement, text: string, pixelRatio?: number, options: Record<string, unknown> }[],
  failure: undefined as string | undefined,
  png: new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
}))

vi.mock('../apps/web/node_modules/html-to-image', () => ({
  toBlob: async (node: HTMLElement, options: Record<string, unknown> & { pixelRatio?: number }) => {
    if (drawing.failure)
      throw new Error(drawing.failure)
    drawing.calls.push({ node, text: node.textContent ?? '', pixelRatio: options.pixelRatio, options })
    return new Blob([drawing.png], { type: 'image/png' })
  },
}))

const feature = await loadFeature('./preview-capture.feature')

/** happy-dom's switch for what its fetch answers. */
interface FetchInterceptor { beforeAsyncRequest: (context: { request: Request }) => Promise<Response | void> }
const happyDom = () => (window as unknown as { happyDOM: { settings: { fetch: { interceptor: FetchInterceptor | null } } } }).happyDOM.settings

/** Long enough for a capture that does not wait to have drawn: several polls and painted frames. */
const A_WHILE_MS = 300

function rect(left: number, top: number, width: number, height: number) {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect
}

/** The scale the slide is drawn at, read from its own style as a browser would. */
function scaleOf(slide: HTMLElement) {
  const match = /scale\(([\d.]+)\)/.exec(slide.style.transform)
  return match ? Number(match[1]) : 1
}

/**
 * happy-dom has no layout, so boxes are given the ones Chromium would
 * measure: canvas units times the scale the slide is drawn at.
 */
function placeBox(slide: HTMLElement, element: Element, left: number, top: number, width: number, height: number) {
  element.getBoundingClientRect = () => {
    const scale = scaleOf(slide)
    return rect(left * scale, top * scale, width * scale, height * scale)
  }
}

function placeSlide(slide: HTMLElement) {
  placeBox(slide, slide, 0, 0, 980, 551.25)
}

function wait(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describeFeature(feature, ({ Scenario, ScenarioOutline, AfterEachScenario }) => {
  let frame: PreviewFrame
  let captured: Awaited<ReturnType<PreviewFrame['capture']>>
  let pending: Promise<Awaited<ReturnType<PreviewFrame['capture']>>> | undefined
  let releaseFonts: (() => void) | undefined
  let endAnimation: (() => void) | undefined

  AfterEachScenario(() => {
    releaseFonts?.()
    releaseFonts = undefined
    endAnimation?.()
    endAnimation = undefined
    happyDom().fetch.interceptor = null
    delete (document as { getAnimations?: unknown }).getAnimations
    loading.value = 0
    pending = undefined
    frame?.close()
    drawing.calls.length = 0
    drawing.failure = undefined
  })

  const slide = () => frame.find('[data-testid="slide"]')!

  async function showTitle(title: string) {
    frame = await new PreviewFrame().open()
    await frame.render({ content: `# ${title}` })
    // The heading sits well inside the slide.
    placeSlide(slide())
    placeBox(slide(), frame.find('h1')!, 50, 50, 400, 60)
  }

  function expectPng() {
    expect(captured.png).toBeInstanceOf(ArrayBuffer)
    expect([...new Uint8Array(captured.png!)]).toEqual([...drawing.png])
  }

  /** Asks for a capture without waiting for it, so a step can check what it waits for. */
  function startCapture() {
    pending = frame.capture()
  }

  async function expectNothingDrawn() {
    await wait(A_WHILE_MS)
    expect(drawing.calls).toEqual([])
    expect(frame.answers.filter(answer => answer.type === 'deyslide:captured')).toEqual([])
  }

  async function expectCapturedPng() {
    captured = await (pending ?? frame.capture())
    expectPng()
    expect(drawing.calls).toHaveLength(1)
  }

  /** Stands in for the browser's list of running animations, which happy-dom lacks. */
  function runAnimation(endTime: number) {
    const animation = {
      playState: 'running',
      effect: { target: frame.find('h1'), getComputedTiming: () => ({ endTime }) },
      finished: new Promise<void>((resolve) => {
        endAnimation = () => {
          animation.playState = 'finished'
          resolve()
        }
      }),
    }
    ;(document as { getAnimations?: () => unknown[] }).getAnimations = () => [animation]
  }

  Scenario('Capturing a slide returns a PNG', ({ Given, When, Then, And }) => {
    Given('the preview frame shows a slide titled "Hello"', () => showTitle('Hello'))
    When('the editor asks it for a capture at pixel ratio 2', async () => {
      captured = await frame.capture(2)
    })
    Then('the frame answers with a PNG of the slide drawn at pixel ratio 2', () => {
      expectPng()
      expect(drawing.calls.map(({ text, pixelRatio }) => ({ text, pixelRatio }))).toEqual([{ text: expect.stringContaining('Hello'), pixelRatio: 2 }])
      expect(captured.error).toBeUndefined()
    })
    And('the slide does not overflow', () => {
      expect(captured.overflow).toBe(false)
    })
  })

  Scenario('A capture without a pixel ratio draws at 1', ({ Given, When, Then }) => {
    Given('the preview frame shows a slide titled "Hello"', () => showTitle('Hello'))
    When('the editor asks it for a capture', async () => {
      captured = await frame.capture()
    })
    Then('the frame answers with a PNG of the slide drawn at pixel ratio 1', () => {
      expectPng()
      expect(drawing.calls.map(call => call.pixelRatio)).toEqual([1])
    })
  })

  ScenarioOutline('The picture is 1280 by 720 whatever size the frame is shown at', ({ Given, When, Then }, variables) => {
    Given('the preview frame is shown <width> by <height> pixels with a slide titled "Hello"', async () => {
      frame = await new PreviewFrame().open()
      FakeResizeObserver.resizeAll(Number(variables.width), Number(variables.height))
      await frame.render({ content: '# Hello' })
    })
    When('the editor asks it for a capture at pixel ratio 2', async () => {
      captured = await frame.capture(2)
    })
    Then('the slide alone is drawn unscaled, stretched to 1280 by 720 at pixel ratio 2', () => {
      expectPng()
      const [call] = drawing.calls
      // The slide itself, not the frame's stage with the space around it.
      expect(call.node).toBe(slide())
      expect(slide().style.transform).toMatch(/^scale\(/)
      expect(call.options).toMatchObject({
        width: 980,
        height: 551.25,
        canvasWidth: 1280,
        canvasHeight: 720,
        pixelRatio: 2,
        style: { transform: 'none', translate: 'none', inset: '0 auto auto 0', insetBlock: '0 auto', insetInline: '0 auto' },
      })
    })
  })

  Scenario('Content past the slide\'s edges is reported', ({ Given, When, Then, And }) => {
    Given('the preview frame shows a box that reaches past the slide\'s right edge', async () => {
      frame = await new PreviewFrame().open()
      await frame.render({ content: '<v-drag pos="900,50,200,80,0" data-id="wide">\n\nWide\n\n</v-drag>' })
      placeSlide(slide())
      placeBox(slide(), frame.find('.v-drag')!, 900, 50, 200, 80)
    })
    When('the editor asks it for a capture', async () => {
      captured = await frame.capture()
    })
    Then('the frame answers with a PNG', expectPng)
    And('the slide overflows', () => {
      expect(captured.overflow).toBe(true)
    })
  })

  ScenarioOutline('Overflow is measured in slide units whatever size the frame is shown at', ({ Given, And, When, Then }, variables) => {
    Given('the preview frame is shown at <scale> times the slide\'s size', async () => {
      frame = await new PreviewFrame().open()
      const scale = Number(variables.scale)
      FakeResizeObserver.resizeAll(980 * scale, 551.25 * scale)
    })
    And('it shows a box that reaches <past> pixels of the slide past its right edge', async () => {
      const past = Number(variables.past)
      await frame.render({ content: `<v-drag pos="${780 + past},50,200,80,0" data-id="edge">\n\nEdge\n\n</v-drag>` })
      placeSlide(slide())
      placeBox(slide(), frame.find('.v-drag')!, 780 + past, 50, 200, 80)
    })
    When('the editor asks it for a capture', async () => {
      captured = await frame.capture()
    })
    Then('the capture says the slide <outcome>', () => {
      expectPng()
      expect(captured.overflow).toBe(variables.outcome === 'overflows')
      // Measuring leaves the slide drawn at the frame's scale.
      expect(slide().style.transform).toBe(`scale(${variables.scale})`)
    })
  })

  Scenario('A capture waits for the slide asked for just before it', ({ Given, When, Then }) => {
    Given('the preview frame shows a slide titled "Hello"', () => showTitle('Hello'))
    When('the editor asks for a slide titled "Later" and a capture right after it', async () => {
      frame.send({ type: 'deyslide:render', id: 'later', slide: { content: '# Later', frontmatter: {}, first: false }, headmatter: {}, clicks: 0 })
      captured = await frame.capture()
    })
    Then('the capture shows the slide titled "Later"', () => {
      expectPng()
      expect(drawing.calls).toHaveLength(1)
      expect(drawing.calls[0].text).toContain('Later')
      expect(drawing.calls[0].text).not.toContain('Hello')
    })
  })

  Scenario('A capture waits for what a slide marks with data-waitfor', ({ Given, When, Then }) => {
    Given('the preview frame shows a slide with an element that waits for ".ready"', async () => {
      frame = await new PreviewFrame().open()
      await frame.render({ content: '<div class="scene" data-waitfor=".ready"></div>' })
    })
    When('the editor asks it for a capture', startCapture)
    Then('nothing is drawn while ".ready" is missing', expectNothingDrawn)
    When('".ready" appears inside that element', () => {
      const ready = document.createElement('span')
      ready.className = 'ready'
      ready.textContent = 'Snapshot'
      frame.find('.scene')!.append(ready)
    })
    Then('the frame answers with a PNG that shows it', async () => {
      await expectCapturedPng()
      expect(drawing.calls[0].text).toContain('Snapshot')
    })
  })

  Scenario('A capture waits for a component whose code is still loading', ({ Given, And, When, Then }) => {
    Given('the preview frame shows a slide titled "Hello"', () => showTitle('Hello'))
    And('a component on the slide is still loading', () => {
      // What the preview's lazy components do while their code arrives (install.ts).
      loading.value++
    })
    When('the editor asks it for a capture', startCapture)
    Then('nothing is drawn while the component loads', expectNothingDrawn)
    When('the component has loaded', () => {
      loading.value--
    })
    Then('the frame answers with a PNG', expectCapturedPng)
  })

  Scenario('A capture waits for the deck\'s font stylesheet', ({ Given, When, Then }) => {
    Given('the preview frame shows a slide of a deck whose font stylesheet is still on its way', async () => {
      const held = new Promise<void>((resolve) => {
        releaseFonts = resolve
      })
      happyDom().fetch.interceptor = {
        beforeAsyncRequest: async ({ request }) => {
          if (!request.url.startsWith('https://fonts.googleapis.com/'))
            return
          await held
          return new Response('body { margin: 0 }', { headers: { 'content-type': 'text/css' } })
        },
      }
      frame = await new PreviewFrame().open()
      await frame.render({ content: '# Fonts', first: true }, { headmatter: { fonts: { sans: 'Capture Sans' } } })
      expect(document.head.querySelectorAll('link[data-deck-fonts]')).toHaveLength(1)
    })
    When('the editor asks it for a capture', startCapture)
    Then('nothing is drawn before the stylesheet arrives', expectNothingDrawn)
    When('the stylesheet arrives', () => {
      releaseFonts?.()
    })
    Then('the frame answers with a PNG', expectCapturedPng)
  })

  Scenario('A capture waits for animations on the slide to end', ({ Given, And, When, Then }) => {
    Given('the preview frame shows a slide titled "Hello"', () => showTitle('Hello'))
    And('a transition on the slide is still running', () => runAnimation(300))
    When('the editor asks it for a capture', startCapture)
    Then('nothing is drawn before the transition ends', expectNothingDrawn)
    When('the transition ends', () => {
      endAnimation?.()
    })
    Then('the frame answers with a PNG', expectCapturedPng)
  })

  Scenario('An animation that repeats forever does not hold up a capture', ({ Given, And, When, Then }) => {
    Given('the preview frame shows a slide titled "Hello"', () => showTitle('Hello'))
    And('an animation on the slide repeats forever', () => runAnimation(Infinity))
    When('the editor asks it for a capture', startCapture)
    // The answer comes well before the time limit a slide that never settles gets.
    Then('the frame answers with a PNG', expectCapturedPng)
  })

  Scenario('Images that cannot load are left blank', ({ Given, When, Then }) => {
    Given('the preview frame shows a slide titled "Hello"', () => showTitle('Hello'))
    When('the editor asks it for a capture', async () => {
      captured = await frame.capture()
    })
    Then('the drawing puts a blank picture in place of any image it cannot load, and carries on', () => {
      expectPng()
      const { options } = drawing.calls[0]
      expect(options.imagePlaceholder).toMatch(/^data:image\//)
      expect(options.onImageErrorHandler).toBeTypeOf('function')
      expect(() => (options.onImageErrorHandler as (event: Event) => void)(new Event('error'))).not.toThrow()
    })
  })

  Scenario('A slide that does not compile gives no image', ({ Given, When, And, Then }) => {
    Given('the preview frame shows a slide titled "Hello"', () => showTitle('Hello'))
    When('the editor asks it to render a broken slide', async () => {
      await frame.render({ content: '<div v-if="">oops</div>' })
    })
    And('the editor asks it for a capture', async () => {
      captured = await frame.capture()
    })
    Then('the frame answers with the reason and no image', () => {
      expect(captured.png).toBeUndefined()
      expect(captured.error).toBeTruthy()
      expect(captured.error).toBe(frame.find('[data-testid="preview-error"]')?.textContent?.trim())
      expect(drawing.calls).toEqual([])
    })
  })

  Scenario('A drawing that fails is reported, not left waiting', ({ Given, And, When, Then }) => {
    Given('the preview frame shows a slide titled "Hello"', () => showTitle('Hello'))
    And('drawing fails with "The canvas is too large"', () => {
      drawing.failure = 'The canvas is too large'
    })
    When('the editor asks it for a capture', async () => {
      captured = await frame.capture()
    })
    Then('the frame answers with the error "The canvas is too large" and no image', () => {
      expect(captured).toMatchObject({ type: 'deyslide:captured', overflow: false, error: 'The canvas is too large' })
      expect(captured.png).toBeUndefined()
    })
  })
})
