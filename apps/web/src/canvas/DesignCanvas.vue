<script setup lang="ts">
import type { PositionedElement } from '@deyslide/deck-model'
import type { DeckSession } from '../deck/session'
import type { RenderRequest } from '../preview/protocol'
import type { ProjectMedia } from '../projects/media'
import { findElement, findSlide, insertElement } from '@deyslide/deck-model'
import * as Y from 'yjs'
import { LOCAL_ORIGIN } from '../deck/session'
import ElementToolbar from './ElementToolbar.vue'
import SlideStage from './SlideStage.vue'
import SlideStrip from './SlideStrip.vue'

/**
 * The Design view of a deck: the toolbar, the slide strip and the stage
 * with the slide on show. Keyboard shortcuts work while focus is anywhere
 * in it (`data-canvas-keys`), outside text fields.
 */
const props = defineProps<{
  session: DeckSession
  slides: { id: string, content: string, frontmatter: Record<string, unknown> }[]
  slideId: string
  request?: RenderRequest
  selection: string[]
  /** View only, or the assistant is at work. Read only sessions are locked too. */
  locked: boolean
  /** The project's media library, for images, when it has one. */
  media?: ProjectMedia
}>()
const emit = defineEmits<{
  'update:selection': [ids: string[]]
  'slide': [slideId: string]
  'rendered': [result: { id?: string, clicks: number }]
  'error': [message: string]
  'inspect': [id: string]
}>()

/** Puts a new element on top of the slide's others and selects it. */
function addElement(element: PositionedElement) {
  const { doc } = props.session
  const elements = findSlide(doc, props.slideId)?.get('elements')
  if (!(elements instanceof Y.Array))
    return
  props.session.undo.stopCapturing()
  try {
    props.session.transact(() => insertElement(doc, props.slideId, elements.length, element, LOCAL_ORIGIN))
  }
  catch {
    // The slide changed meanwhile; nothing was added.
  }
  props.session.undo.stopCapturing()
  if (findElement(doc, props.slideId, element.id))
    emit('update:selection', [element.id])
}
</script>

<template>
  <div class="flex min-w-0 flex-col gap-3" data-canvas-keys data-testid="design-canvas">
    <ElementToolbar v-if="!locked && !session.readOnly.value" :media="media" @add="addElement" />
    <div class="flex min-w-0 flex-col gap-3 md:flex-row">
      <SlideStrip
        class="order-2 md:order-1 md:w-44 md:shrink-0"
        :session="session"
        :slides="slides"
        :current-id="slideId"
        :locked="locked || session.readOnly.value"
        @select="emit('slide', $event)"
      />
      <SlideStage
        class="order-1 min-w-0 flex-1 md:order-2"
        :session="session"
        :slide-id="slideId"
        :request="request"
        :selection="selection"
        :locked="locked || session.readOnly.value"
        @update:selection="emit('update:selection', $event)"
        @rendered="emit('rendered', $event)"
        @error="emit('error', $event)"
        @inspect="emit('inspect', $event)"
      />
    </div>
  </div>
</template>
