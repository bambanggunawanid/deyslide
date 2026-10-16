<script setup lang="ts">
import type { PositionedElement } from '@deyslide/deck-model'
import type { MediaFile, ProjectMedia } from '../projects/media'
import type { ElementKind } from './elements'
import { nextTick, ref } from 'vue'
import { mediaAddress } from '../platform/media'
import { describeFile, ELEMENT_KINDS, imageLink, newElement } from './elements'
import MediaPicker from './MediaPicker.vue'

/**
 * Adds elements to the slide on show, in its middle. An image asks for its
 * link first, or offers the project's images when it has a media library.
 */
defineProps<{ media?: ProjectMedia }>()
const emit = defineEmits<{ add: [element: PositionedElement] }>()

const askingLink = ref(false)
const link = ref('')
const problem = ref('')
const linkInput = ref<HTMLInputElement>()
const toolbar = ref<HTMLElement>()

async function add(kind: ElementKind) {
  if (kind !== 'image') {
    emit('add', newElement(kind))
    return
  }
  askingLink.value = !askingLink.value
  problem.value = ''
  await nextTick()
  linkInput.value?.focus()
}

function addImage() {
  const src = imageLink(link.value)
  if (!src) {
    problem.value = 'Enter a link that starts with https://, http:// or /.'
    return
  }
  emit('add', newElement('image', { src }))
  closeLink()
}

/** An image from the project's library, described by its file name until someone writes better. */
function addFile(file: MediaFile) {
  emit('add', newElement('image', { src: mediaAddress(file.id), alt: describeFile(file.name) }))
  closeLink()
}

function closeLink() {
  askingLink.value = false
  link.value = ''
  problem.value = ''
}

/** Escape closes the link field, and focus goes back to the Image button. */
function cancelLink() {
  closeLink()
  toolbar.value?.querySelector<HTMLElement>('[data-testid="add-image"]')?.focus()
}
</script>

<template>
  <div class="flex flex-col gap-2" data-testid="element-toolbar">
    <div ref="toolbar" class="flex flex-wrap gap-1" role="toolbar" aria-label="Add to the slide">
      <button
        v-for="item in ELEMENT_KINDS"
        :key="item.kind"
        class="dey-btn text-sm"
        :aria-expanded="item.kind === 'image' ? askingLink : undefined"
        :data-testid="`add-${item.kind}`"
        @click="add(item.kind)"
      >
        {{ item.label }}
      </button>
    </div>
    <form v-if="askingLink" class="flex flex-wrap items-center gap-2" data-testid="image-form" @submit.prevent="addImage">
      <input
        ref="linkInput"
        v-model="link"
        class="dey-input min-w-0 flex-1 py-1 text-sm"
        inputmode="url"
        placeholder="https://example.com/picture.png"
        aria-label="Image link"
        data-testid="image-url"
        @keydown.escape.prevent="cancelLink"
      >
      <button type="submit" class="dey-btn-primary text-sm" data-testid="image-add">
        Add image
      </button>
      <p v-if="problem" class="m-0 w-full text-sm text-rose-300" role="alert" data-testid="image-problem">
        {{ problem }}
      </p>
    </form>
    <MediaPicker v-if="askingLink && media" class="max-w-xl" :media="media" @pick="addFile" />
  </div>
</template>
