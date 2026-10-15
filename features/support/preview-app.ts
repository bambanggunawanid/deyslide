import type { VueWrapper } from '@vue/test-utils'
import type { FromPreview, PreviewSlide, RenderRequest, ToPreview } from '../../apps/web/src/preview/protocol'
import { flushPromises, mount } from '@vue/test-utils'
import { expect, vi } from 'vitest'
import { installPreview, reportSlideErrors } from '../../apps/web/src/preview/install'
import PreviewApp from '../../apps/web/src/preview/PreviewApp.vue'
import { clicks, frontmatter, headmatter, mode, positions, totalClicks } from '../../apps/web/src/preview/state'
import { FakeResizeObserver } from './resize-observer'

type Answer<T extends FromPreview['type']> = Extract<FromPreview, { type: T }>

const ANSWERS = new Set(['deyslide:ready', 'deyslide:rendered', 'deyslide:error', 'deyslide:captured'])

/**
 * The preview frame's own app, mounted in happy-dom and driven the way the
 * editor drives the sandboxed frame: messages from `window.parent` go in,
 * and what the frame posts back is kept in `answers`.
 */
export class PreviewFrame {
  readonly answers: FromPreview[] = []
  private wrapper?: VueWrapper
  private host?: HTMLElement
  private count = 0
  private readonly listen = (event: MessageEvent) => {
    const data = event.data as FromPreview | undefined
    if (data && ANSWERS.has(data.type))
      this.answers.push(data)
  }

  async open() {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    window.addEventListener('message', this.listen)
    this.host = document.createElement('div')
    this.host.id = 'preview'
    document.body.append(this.host)
    // Test utils stub Vue's <Transition> unless told otherwise, and presenting depends on it.
    this.wrapper = mount(PreviewApp, { attachTo: this.host, global: { plugins: [{ install: installPreview }, { install: reportSlideErrors }], stubs: { transition: false } } })
    await vi.waitFor(() => expect(this.answers.some(answer => answer.type === 'deyslide:ready')).toBe(true))
    return this
  }

  /** Posts a message as the editor that embeds the frame. */
  send(message: ToPreview) {
    window.dispatchEvent(new MessageEvent('message', { data: message, source: window }))
  }

  /** Sends a render and waits for the frame to answer it, by id. */
  async render(slide: Partial<PreviewSlide>, options: Partial<Omit<RenderRequest, 'type' | 'slide'>> = {}) {
    const id = options.id ?? `render-${++this.count}`
    this.send({
      type: 'deyslide:render',
      headmatter: {},
      clicks: 0,
      ...options,
      id,
      slide: { content: '', frontmatter: {}, first: false, ...slide },
    })
    const answer = await this.answerFor(id, ['deyslide:rendered', 'deyslide:error'])
    await flushPromises()
    return answer as Answer<'deyslide:rendered'> | Answer<'deyslide:error'>
  }

  /** Asks for a capture and waits for the frame's answer. */
  async capture(pixelRatio?: number) {
    const id = `capture-${++this.count}`
    this.send({ type: 'deyslide:capture', id, ...(pixelRatio === undefined ? {} : { pixelRatio }) })
    return await this.answerFor(id, ['deyslide:captured']) as Answer<'deyslide:captured'>
  }

  async answerFor(id: string, types: FromPreview['type'][]) {
    let found: FromPreview | undefined
    await vi.waitFor(() => {
      found = this.answers.find(answer => types.includes(answer.type) && 'id' in answer && answer.id === id)
      expect(found).toBeDefined()
    }, { timeout: 5000 })
    return found!
  }

  find<T extends Element = HTMLElement>(selector: string) {
    return document.querySelector<T>(`#preview ${selector}`)
  }

  findAll<T extends Element = HTMLElement>(selector: string) {
    return [...document.querySelectorAll<T>(`#preview ${selector}`)]
  }

  close() {
    this.wrapper?.unmount()
    this.host?.remove()
    window.removeEventListener('message', this.listen)
    document.head.querySelectorAll('link[data-deck-fonts]').forEach(link => link.remove())
    document.documentElement.classList.remove('dark')
    clicks.value = 0
    totalClicks.value = 0
    mode.value = 'edit'
    frontmatter.value = {}
    headmatter.value = {}
    positions.value = {}
    FakeResizeObserver.reset()
  }
}
