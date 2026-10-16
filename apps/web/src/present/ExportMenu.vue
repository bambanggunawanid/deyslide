<script setup lang="ts">
import type { PreviewSlide } from '../preview/protocol'
import type { ExportClicks, ExportFormat, ExportSource } from './exports'
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuTrigger } from 'reka-ui'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useAccount } from '../composables/useAccount'
import SlidePreviewFrame from '../editor/SlidePreviewFrame.vue'
import { saveFile } from '../platform/platform'
import { LOCAL_ID_PREFIX } from '../projects/workspace'
import { makeDevicePdf } from './device-pdf'
import { ExportError, UNREACHABLE, useExportApi } from './exports'
import { useFrameRenderer } from './frame-renderer'

/**
 * Export for a deck: on the server (PDF, PDF with every click step, video)
 * for signed in people when the server makes exports, otherwise a PDF made
 * on this device from the preview. Says how it goes in plain words.
 */
const props = defineProps<{
  deckId: string
  deckName: string
  /** The deck's slides, for a PDF made on this device. */
  slides: Pick<PreviewSlide, 'content' | 'frontmatter'>[]
  /** The deck's Markdown, sent for decks that live on this device. */
  markdown: () => string
  disabled?: boolean
}>()

const api = useExportApi()
const { account } = useAccount()

/** How often a running export is asked about. */
const POLL_MS = 1000

/** The server makes exports for this person. */
const onServer = ref(false)
/** The server could not be reached for an export, so the device makes PDFs too. */
const unreachable = ref(false)
const offerDevice = computed(() => !onServer.value || unreachable.value)

async function checkServer() {
  const person = account.value
  const enabled = person ? await api.enabled() : false
  if (account.value === person)
    onServer.value = enabled
}

watch(account, () => {
  onServer.value = false
  unreachable.value = false
  void checkServer()
}, { immediate: true })

/** Opening the menu asks the server again, when an earlier check found no exports (offline then, say). */
function onOpen(open: boolean) {
  if (open && account.value && !onServer.value)
    void checkServer()
}

const busy = ref(false)
const message = ref('')
const failed = ref(false)

const drawer = useFrameRenderer('export')
const { frame: exportFrame, request: drawRequest } = drawer
/** The hidden frame that draws slides for a PDF made here, while it is made. */
const drawing = ref(false)

const FORMATS: Record<ExportFormat, { noun: string, extension: string, type: string }> = {
  pdf: { noun: 'PDF', extension: 'pdf', type: 'application/pdf' },
  webm: { noun: 'video', extension: 'webm', type: 'video/webm' },
}

let stopped = false
onBeforeUnmount(() => {
  stopped = true
  drawer.stop()
})

function wait(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function percent(share: number) {
  return `${Math.round(Math.min(Math.max(share, 0), 1) * 100)}%`
}

async function save(name: string, bytes: Uint8Array, type: string) {
  message.value = (await saveFile(name, bytes, type)) ? `Saved ${name}.` : 'The file was not saved.'
}

function fail(error: unknown) {
  failed.value = true
  message.value = error instanceof ExportError ? error.message : 'The export did not work. Try again.'
}

/** A server export that failed. When the server is out of reach, the menu offers the PDF made here as well. */
function failOnServer(error: unknown) {
  fail(error)
  if (error instanceof ExportError && error.message === UNREACHABLE)
    unreachable.value = true
}

async function exportOnServer(format: ExportFormat, clicks: ExportClicks) {
  const { noun, extension, type } = FORMATS[format]
  busy.value = true
  failed.value = false
  message.value = `Starting the ${noun}...`
  try {
    // A deck on this device is not on the server, so its Markdown goes instead.
    const source: ExportSource = props.deckId.startsWith(LOCAL_ID_PREFIX) ? { markdown: props.markdown() } : { deckId: props.deckId }
    const id = await api.start(source, format, clicks)
    while (!stopped) {
      const state = await api.status(id)
      if (state.status === 'failed')
        throw new ExportError(`The ${noun} could not be made. ${state.error ?? ''}`.trim())
      if (state.status === 'done')
        break
      message.value = state.status === 'queued' ? `The ${noun} is waiting for its turn...` : `Making the ${noun}... ${percent(state.progress)}`
      await wait(api.pollMs ?? POLL_MS)
    }
    if (stopped)
      return
    message.value = `Downloading the ${noun}...`
    const file = await api.download(id)
    unreachable.value = false
    await save(file.name || `${props.deckName}.${extension}`, file.bytes, file.type || type)
  }
  catch (error) {
    failOnServer(error)
  }
  finally {
    busy.value = false
  }
}

async function exportHere(clicks: ExportClicks) {
  busy.value = true
  failed.value = false
  message.value = 'Drawing the slides...'
  drawing.value = true
  try {
    const bytes = await makeDevicePdf({
      slides: props.slides,
      clicks,
      title: props.deckName,
      drawer,
      onProgress: (slide, done) => {
        message.value = `Drawing slide ${slide} of ${props.slides.length}... ${percent(done)}`
      },
    })
    await save(`${props.deckName}.pdf`, bytes, 'application/pdf')
  }
  catch (error) {
    if (!stopped)
      fail(error)
  }
  finally {
    drawing.value = false
    busy.value = false
  }
}

const label = computed(() => busy.value ? 'Exporting...' : 'Export')
</script>

<template>
  <div class="flex items-center gap-2">
    <DropdownMenuRoot @update:open="onOpen">
      <DropdownMenuTrigger class="dey-btn text-sm" :disabled="disabled || busy" data-testid="export-menu">
        {{ label }}
      </DropdownMenuTrigger>
      <DropdownMenuPortal>
        <DropdownMenuContent align="end" :side-offset="6" class="dey-panel z-30 flex min-w-60 flex-col gap-1 p-2" data-testid="export-options">
          <template v-if="onServer">
            <DropdownMenuItem class="cursor-pointer rounded px-2 py-1 text-sm outline-none data-[highlighted]:bg-dey-line" data-testid="export-pdf" @select="exportOnServer('pdf', 'last')">
              PDF
            </DropdownMenuItem>
            <DropdownMenuItem class="cursor-pointer rounded px-2 py-1 text-sm outline-none data-[highlighted]:bg-dey-line" data-testid="export-pdf-steps" @select="exportOnServer('pdf', 'each')">
              PDF with every click step
            </DropdownMenuItem>
            <DropdownMenuItem class="cursor-pointer rounded px-2 py-1 text-sm outline-none data-[highlighted]:bg-dey-line" data-testid="export-video" @select="exportOnServer('webm', 'each')">
              Video (WebM)
            </DropdownMenuItem>
          </template>
          <template v-if="offerDevice">
            <DropdownMenuItem class="cursor-pointer rounded px-2 py-1 text-sm outline-none data-[highlighted]:bg-dey-line" data-testid="export-device-pdf" @select="exportHere('last')">
              PDF (this device)
            </DropdownMenuItem>
            <DropdownMenuItem class="cursor-pointer rounded px-2 py-1 text-sm outline-none data-[highlighted]:bg-dey-line" data-testid="export-device-pdf-steps" @select="exportHere('each')">
              PDF with every click step (this device)
            </DropdownMenuItem>
          </template>
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenuRoot>
    <span
      v-if="message"
      class="max-w-72 text-sm"
      :class="failed ? 'text-rose-300' : 'text-dey-muted'"
      :role="failed ? 'alert' : 'status'"
      data-testid="export-status"
    >
      {{ message }}
    </span>
    <!-- Draws each slide for a PDF made here: inside the window, so it paints, but unseen. -->
    <SlidePreviewFrame
      v-if="drawing"
      ref="exportFrame"
      :request="drawRequest"
      class="pointer-events-none fixed left-0 top-0 -z-10 w-160 opacity-0"
      aria-hidden="true"
      data-testid="export-frame"
      @rendered="drawer.onRendered"
      @error="drawer.onError"
    />
  </div>
</template>
