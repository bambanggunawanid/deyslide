import type { Position } from '@deyslide/deck-model'
import type { RenderRequest } from './protocol'
import { ref, shallowRef } from 'vue'

export type PreviewMode = NonNullable<RenderRequest['mode']>

/** How many clicks into the slide the preview is, like Slidev's `$clicks`. */
export const clicks = ref(0)
/** How many clicks the slide on screen has. */
export const totalClicks = ref(0)
/** Whether the page shows the dark color schema. */
export const dark = shallowRef(false)
/** What the slide on screen is shown for: editing, presenting or printing. */
export const mode = shallowRef<PreviewMode>('edit')
/** The frontmatter of the slide on screen, Slidev's `$frontmatter`. */
export const frontmatter = shallowRef<Record<string, unknown>>({})
/** The deck's settings: the first slide's frontmatter. */
export const headmatter = shallowRef<Record<string, unknown>>({})
/** Positions the editor gives elements by `data-id`, shown in place of the ones in the slide. */
export const positions = shallowRef<Record<string, Position>>({})
/** Components whose code is still loading, so a capture can wait for them. */
export const loading = ref(0)
