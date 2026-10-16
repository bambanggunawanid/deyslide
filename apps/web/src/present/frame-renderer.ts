import type { CapturedSlide, RenderRequest } from '../preview/protocol'
import { ref, shallowRef } from 'vue'

/** What a mounted SlidePreviewFrame exposes. */
export interface CapturingFrame {
  capture: (pixelRatio?: number) => Promise<CapturedSlide>
}

/** A render that takes longer than this fails, so an export never waits forever. */
export const RENDER_TIMEOUT_MS = 30_000

/**
 * Drives one preview frame step by step: render a slide and wait until it
 * is drawn, then capture it. Bind `request`, `frame`, `onRendered` and
 * `onError` to a SlidePreviewFrame. One render at a time.
 */
export function useFrameRenderer(name: string) {
  const request = shallowRef<RenderRequest>()
  const frame = ref<CapturingFrame>()
  let renders = 0
  let waiting: { id: string, resolve: (clicks: number) => void, reject: (error: Error) => void } | undefined

  function settle(id: string) {
    const current = waiting
    if (current?.id !== id)
      return undefined
    waiting = undefined
    return current
  }

  /** Draws a slide and resolves with its click count, or rejects with the error it shows. */
  function render(next: Omit<RenderRequest, 'type' | 'id'>): Promise<number> {
    const id = `${name}-${++renders}`
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => settle(id)?.reject(new Error('The slide took too long to draw.')), RENDER_TIMEOUT_MS)
      waiting = {
        id,
        resolve: (clicks) => {
          clearTimeout(timer)
          resolve(clicks)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      }
      request.value = { type: 'deyslide:render', id, ...next }
    })
  }

  function onRendered(result: { id?: string, clicks: number }) {
    if (result.id !== undefined)
      settle(result.id)?.resolve(result.clicks)
  }

  /** The frame passes on errors about the render it was last asked for only. */
  function onError(message: string) {
    if (waiting)
      settle(waiting.id)?.reject(new Error(message))
  }

  async function capture(pixelRatio?: number): Promise<CapturedSlide> {
    if (!frame.value)
      return { overflow: false, error: 'The preview is not open.' }
    return frame.value.capture(pixelRatio)
  }

  /** Stops waiting, for a page that closes mid render. */
  function stop() {
    if (waiting)
      settle(waiting.id)?.reject(new Error('Stopped.'))
  }

  return { request, frame, render, capture, onRendered, onError, stop }
}

export type FrameRenderer = ReturnType<typeof useFrameRenderer>
