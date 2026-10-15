import type { VueWrapper } from '@vue/test-utils'
import type { CapturedSlide, FromPreview, RenderRequest, ToPreview } from '../apps/web/src/preview/protocol'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { flushPromises, mount } from '@vue/test-utils'
import { expect, vi } from 'vitest'
import SlidePreviewFrame from '../apps/web/src/editor/SlidePreviewFrame.vue'

const feature = await loadFeature('./preview-embed.feature')

interface FetchSettings { fetch: { interceptor: unknown } }
const happyDom = () => (window as unknown as { happyDOM: { settings: FetchSettings } }).happyDOM.settings

function request(content: string, id?: string): RenderRequest {
  return { type: 'deyslide:render', ...(id ? { id } : {}), slide: { content, frontmatter: {}, first: false }, headmatter: {}, clicks: 0 }
}

describeFeature(feature, ({ Scenario, BeforeEachScenario, AfterEachScenario }) => {
  let wrapper: VueWrapper | undefined
  let sent: ToPreview[] = []
  let capture: Promise<CapturedSlide>
  let png: ArrayBuffer

  BeforeEachScenario(() => {
    // The frame loads an empty page here: the preview app itself has its own features.
    happyDom().fetch.interceptor = {
      beforeAsyncRequest: async () => new Response('<!doctype html><html><body></body></html>', { headers: { 'content-type': 'text/html' } }),
    }
  })

  AfterEachScenario(() => {
    vi.useRealTimers()
    wrapper?.unmount()
    wrapper = undefined
    sent = []
    happyDom().fetch.interceptor = null
  })

  const child = () => (wrapper!.find('iframe').element as HTMLIFrameElement).contentWindow!

  /** A message from the frame to the component, or from another window when `source` says so. */
  function answer(message: FromPreview, source: Window = child()) {
    window.dispatchEvent(new MessageEvent('message', { data: message, source }))
  }

  async function mountWith(props: { request?: RenderRequest } = {}) {
    wrapper = mount(SlidePreviewFrame, { attachTo: document.body, props })
    await vi.waitFor(() => expect((wrapper!.find('iframe').element as HTMLIFrameElement).contentWindow).toBeTruthy())
    vi.spyOn(child(), 'postMessage').mockImplementation((message: unknown) => {
      sent.push(message as ToPreview)
    })
  }

  async function mountReady(props: { request?: RenderRequest } = { request: request('# One') }) {
    await mountWith(props)
    answer({ type: 'deyslide:ready' })
    await flushPromises()
    sent = []
  }

  const mountWithSlide = () => mountWith({ request: request('# One') })

  async function becomeReady() {
    answer({ type: 'deyslide:ready' })
    await flushPromises()
  }

  async function askCapture(pixelRatio?: number) {
    capture = (wrapper!.vm as unknown as { capture: (ratio?: number) => Promise<CapturedSlide> }).capture(pixelRatio)
    await flushPromises()
  }

  const lastCapture = () => sent.filter(message => message.type === 'deyslide:capture').at(-1) as Extract<ToPreview, { type: 'deyslide:capture' }> | undefined

  Scenario('The frame gets the render once it is ready', ({ Given, Then, When }) => {
    Given('the preview component is mounted with a slide to render', mountWithSlide)
    Then('nothing is sent to the frame yet', () => {
      expect(sent).toEqual([])
    })
    When('the frame says it is ready', becomeReady)
    Then('the frame is asked to render that slide', () => {
      expect(sent).toEqual([request('# One')])
    })
  })

  Scenario('A rendered answer is passed on with its id', ({ Given, When, Then }) => {
    Given('the preview component is mounted and its frame is ready', () => mountReady())
    When('the frame answers "rendered" for "r1" with 2 clicks', () => {
      answer({ type: 'deyslide:rendered', id: 'r1', clicks: 2 })
    })
    Then('the component emits "rendered" with the id "r1" and 2 clicks', () => {
      expect(wrapper!.emitted('rendered')).toEqual([[{ id: 'r1', clicks: 2 }]])
    })
  })

  Scenario('Messages from anywhere but the frame are ignored', ({ Given, When, Then }) => {
    Given('the preview component is mounted and its frame is ready', () => mountReady())
    When('another window posts "rendered" for "r1" with 2 clicks', () => {
      answer({ type: 'deyslide:rendered', id: 'r1', clicks: 2 }, window)
    })
    Then('the component emits nothing', () => {
      expect(wrapper!.emitted('rendered')).toBeUndefined()
    })
  })

  Scenario('An error about a render the component has replaced is not shown', ({ Given, When, Then }) => {
    Given('the preview component is mounted and its frame is ready, rendering "r2"', () => mountReady({ request: request('# Two', 'r2') }))
    When('the frame reports an error for the earlier render "r1"', () => {
      answer({ type: 'deyslide:error', id: 'r1', message: 'A newer render replaced this one.' })
    })
    Then('the component emits no error', () => {
      expect(wrapper!.emitted('error')).toBeUndefined()
    })
    When('the frame reports an error for "r2"', () => {
      answer({ type: 'deyslide:error', id: 'r2', message: 'missing is not defined' })
    })
    Then('the component emits that error', () => {
      expect(wrapper!.emitted('error')).toEqual([['missing is not defined']])
    })
  })

  Scenario('Positions go to the frame, and again after each render', ({ Given, When, Then }) => {
    const box = { x: 300, y: 120, w: 200, h: 80, rotate: 0 }
    Given('the preview component is mounted and its frame is ready', () => mountReady())
    When('the canvas gives the element "box" the position left 300 and top 120', async () => {
      await wrapper!.setProps({ positions: { box } })
    })
    Then('the frame is sent that position', () => {
      expect(sent).toEqual([{ type: 'deyslide:positions', positions: { box } }])
      sent = []
    })
    When('the slide to render changes', async () => {
      await wrapper!.setProps({ request: request('# Two') })
    })
    Then('the frame is asked to render it and is sent the position again', () => {
      expect(sent).toEqual([request('# Two'), { type: 'deyslide:positions', positions: { box } }])
    })
  })

  Scenario('A capture resolves with the frame\'s picture', ({ Given, When, Then }) => {
    Given('the preview component is mounted and its frame is ready', () => mountReady())
    When('the exporter asks for a capture at pixel ratio 2', () => askCapture(2))
    Then('the frame is asked for a capture at pixel ratio 2', () => {
      expect(lastCapture()).toMatchObject({ type: 'deyslide:capture', pixelRatio: 2 })
    })
    When('the frame answers that capture with a PNG that does not overflow', () => {
      png = new Uint8Array([0x89, 0x50, 0x4E, 0x47]).buffer
      answer({ type: 'deyslide:captured', id: lastCapture()!.id, png, overflow: false })
    })
    Then('the capture resolves with that PNG and no overflow', async () => {
      expect(await capture).toEqual({ png, overflow: false })
    })
  })

  Scenario('A capture asked for before the frame is ready waits for it', ({ Given, When, Then }) => {
    Given('the preview component is mounted with a slide to render', mountWithSlide)
    When('the exporter asks for a capture', () => askCapture())
    Then('nothing is sent to the frame yet', () => {
      expect(sent).toEqual([])
    })
    When('the frame says it is ready', becomeReady)
    Then('the frame is asked for a capture', () => {
      expect(sent.map(message => message.type)).toEqual(['deyslide:render', 'deyslide:capture'])
    })
  })

  Scenario('A capture the frame never answers gives up', ({ Given, When, And, Then }) => {
    Given('the preview component is mounted and its frame is ready', () => mountReady())
    When('the exporter asks for a capture', async () => {
      vi.useFakeTimers()
      await askCapture()
      expect(lastCapture()).toMatchObject({ type: 'deyslide:capture' })
    })
    And('the frame stays silent for 20 seconds', async () => {
      // Not a moment before.
      await vi.advanceTimersByTimeAsync(19_999)
      let settled = false
      void capture.then(() => {
        settled = true
      })
      await flushPromises()
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
    })
    Then('the capture resolves with the error "The slide took too long to capture."', async () => {
      expect(await capture).toEqual({ overflow: false, error: 'The slide took too long to capture.' })
    })
  })

  Scenario('Closing the preview ends a waiting capture', ({ Given, When, And, Then }) => {
    Given('the preview component is mounted and its frame is ready', () => mountReady())
    When('the exporter asks for a capture', () => askCapture())
    And('the preview component is closed', () => {
      wrapper!.unmount()
      wrapper = undefined
    })
    Then('the capture resolves with the error "The preview closed before the slide was captured."', async () => {
      expect(await capture).toEqual({ overflow: false, error: 'The preview closed before the slide was captured.' })
    })
  })
})
