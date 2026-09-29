/** Messages between the editor and the sandboxed preview frame. */

export interface PreviewSlide {
  content: string
  frontmatter: Record<string, unknown>
  first: boolean
}

export interface RenderRequest {
  type: 'deyslide:render'
  slide: PreviewSlide
  /** The first slide's frontmatter, which holds deck settings such as `colorSchema` and `fonts`. */
  headmatter: Record<string, unknown>
  clicks: number
}

export type FromPreview
  = | { type: 'deyslide:ready' }
    | { type: 'deyslide:rendered', clicks: number }
    | { type: 'deyslide:error', message: string }
