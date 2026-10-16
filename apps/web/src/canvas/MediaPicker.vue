<script setup lang="ts">
import type { MediaFile, ProjectMedia } from '../projects/media'
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { mediaAddress, resolveMedia } from '../platform/media'
import { IMAGE_TYPES } from '../projects/media'

/**
 * The project's images, to pick one for the slide or upload a new one.
 * Picking an upload happens as soon as the server has checked it.
 */
const props = defineProps<{ media: ProjectMedia }>()
const emit = defineEmits<{ pick: [file: MediaFile] }>()

/** How many images show at first, and how many more each time. */
const PAGE = 12

const files = shallowRef<MediaFile[]>()
const shown = ref(PAGE)
const problem = ref('')
const uploading = ref(false)
const picker = ref<HTMLInputElement>()
/** Links the page can load each image's preview from. */
const previews = shallowRef<Record<string, string>>({})

const images = computed(() => (files.value ?? [])
  .filter(file => IMAGE_TYPES.includes(file.type))
  .sort((a, b) => b.createdAt - a.createdAt))
const visible = computed(() => images.value.slice(0, shown.value))

const message = (error: unknown) => error instanceof Error && error.message ? error.message : 'Something went wrong. Try again.'

async function load() {
  problem.value = ''
  try {
    files.value = (await props.media.api.list(props.media.projectId)).files
  }
  catch (error) {
    files.value = []
    problem.value = message(error)
  }
}

watch(visible, async (list) => {
  const addresses = list.map(file => mediaAddress(file.id))
  const links = await resolveMedia(addresses)
  previews.value = { ...previews.value, ...links }
})

async function upload(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file)
    return
  if (!IMAGE_TYPES.includes(file.type)) {
    problem.value = 'Choose a PNG, JPEG, GIF, WebP or AVIF image.'
    return
  }
  problem.value = ''
  uploading.value = true
  try {
    const added = await props.media.api.upload(props.media.projectId, file)
    files.value = [added, ...(files.value ?? []).filter(item => item.id !== added.id)]
    emit('pick', added)
  }
  catch (error) {
    problem.value = message(error)
  }
  finally {
    uploading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="flex flex-col gap-2" data-testid="media-picker">
    <div class="flex items-center justify-between gap-2">
      <span class="text-sm text-dey-muted">This project's images</span>
      <button type="button" class="dey-btn text-xs" :disabled="uploading" data-testid="media-upload" @click="picker?.click()">
        {{ uploading ? 'Uploading...' : 'Upload an image' }}
      </button>
      <input
        ref="picker"
        type="file"
        class="hidden"
        :accept="IMAGE_TYPES.join(',')"
        aria-label="Image to upload"
        data-testid="media-upload-input"
        @change="upload"
      >
    </div>
    <p v-if="files === undefined" class="m-0 text-sm text-dey-muted" role="status">
      Loading the project's images...
    </p>
    <p v-else-if="images.length === 0 && !problem" class="m-0 text-sm text-dey-muted" data-testid="media-empty">
      No images in this project yet.
    </p>
    <ul v-else class="m-0 grid list-none grid-cols-3 gap-2 p-0">
      <li v-for="file in visible" :key="file.id">
        <button
          type="button"
          class="flex w-full flex-col gap-1 rounded-md border border-dey-line p-1 text-left text-xs hover:border-dey-accent"
          :title="file.name"
          :data-media-id="file.id"
          data-testid="media-file"
          @click="emit('pick', file)"
        >
          <span class="block aspect-video w-full overflow-hidden rounded bg-slate-800">
            <img v-if="previews[mediaAddress(file.id)]" :src="previews[mediaAddress(file.id)]" alt="" class="h-full w-full object-cover">
          </span>
          <span class="truncate">{{ file.name }}</span>
        </button>
      </li>
    </ul>
    <button v-if="images.length > shown" type="button" class="dey-btn self-start text-xs" data-testid="media-more" @click="shown += PAGE">
      Show more
    </button>
    <p v-if="problem" class="m-0 text-sm text-rose-300" role="alert" data-testid="media-problem">
      {{ problem }}
    </p>
  </div>
</template>
