import type { InjectionKey } from 'vue'
import type * as Y from 'yjs'
import type { DeckSession } from '../deck/session'
import type { PresentChannel } from '../platform/platform'
import type { RenderRequest } from '../preview/protocol'
import type { PresentSlide } from './outline'
import type { PresentDeck, PresentPosition } from './navigation'
import { computed, inject, onBeforeUnmount, provide, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAccount } from '../composables/useAccount'
import { useProjects } from '../composables/useProjects'
import { publishPresence } from '../deck/presence'
import { holdsDeck, statusLabel } from '../deck/session'
import { MEDIA_DECK_KEY, mediaDeckOf, mediaOwner, useMediaRequest } from '../platform/media'
import { presentChannel } from '../platform/platform'
import { REPLACED } from '../preview/protocol'
import { slideTransition } from '../preview/transitions'
import * as navigation from './navigation'
import { readPresentSlides } from './outline'

/** What a deck's presenter and audience windows tell each other. */
export type PresentMessage
  = | { type: 'hello' }
    | { type: 'go', slide: number, slideId?: string, clicks: number }

/** Makes the channel between a deck's windows. Pages use the platform's; scenarios provide their own. */
export const PRESENT_CHANNEL_KEY: InjectionKey<(deckId: string) => PresentChannel<PresentMessage>> = Symbol('present-channel')

/** How often the slides are read again while the deck changes, at most. */
const OUTLINE_INTERVAL_MS = 100

/** Render ids remembered, to tell which slide a reply is about. */
const REMEMBERED_RENDERS = 64

/** Moves that can wait for the preview, at most. Pressing on past that does nothing more. */
const MOST_WAITING_MOVES = 20

/** What decides a slide's click count: what it shows. A live edit to the slide makes its count unknown again. */
function countKey(slide: Pick<PresentSlide, 'content' | 'frontmatter'>) {
  return JSON.stringify([slide.content, slide.frontmatter])
}

/**
 * A deck being presented: opened read only (live changes still show up),
 * the slide and click on screen, moving through them, the render request
 * for the slide on screen, and keeping the deck's other window in step.
 */
export function usePresentation(props: { projectId: string, deckId: string }) {
  const route = useRoute()
  const router = useRouter()
  const { account } = useAccount()
  const { store, projects, shared } = useProjects(() => props.projectId)
  const project = computed(() => [...projects.value, ...shared.value].find(item => item.id === props.projectId))
  const summary = computed(() => project.value?.decks.find(deck => deck.id === props.deckId))
  const makeChannel = inject(PRESENT_CHANNEL_KEY, presentChannel<PresentMessage>)
  /** The deck's other window, presenter or audience. */
  let channel: PresentChannel<PresentMessage> | undefined
  /** The deck media links are asked through, for every picture of the talk. */
  const mediaDeck = () => mediaDeckOf(props.deckId, Boolean(account.value))
  provide(MEDIA_DECK_KEY, mediaDeck)
  // Signed media links belong to the account that asked for them; another person asks afresh.
  watch(() => account.value?.id, id => mediaOwner(id), { immediate: true })

  // The deck, open read only ------------------------------------------------

  const session = shallowRef<DeckSession>()
  const loadError = ref('')
  const ready = computed(() => Boolean(session.value?.ready.value))
  /**
   * Why the deck does not show, in words for the person: it could not be
   * opened, or it never loaded (offline before its first sync, or refused).
   */
  const problem = computed(() => {
    if (loadError.value)
      return loadError.value
    const current = session.value
    if (!current || current.ready.value)
      return ''
    const status = current.status.value
    return status === 'offline' || status === 'failed' ? statusLabel(status, current.error.value) : ''
  })

  // Each source is compared on its own, so a project list that refreshes
  // (new objects, the same deck) does not open the deck again.
  watch([() => props.deckId, store, () => Boolean(summary.value)], async ([deckId, current, known], _, onCleanup) => {
    let stale = false
    onCleanup(() => {
      stale = true
      session.value?.close()
      session.value = undefined
    })
    loadError.value = ''
    if (!known)
      return
    try {
      // Presenting changes nothing, and still shows what others change.
      const opened = await current.openDeck(props.projectId, deckId, { readOnly: true })
      if (stale)
        opened.close()
      else
        session.value = opened
    }
    catch {
      if (!stale)
        loadError.value = 'This deck could not be opened. Reload the page to try again.'
    }
  }, { immediate: true })

  const slides = shallowRef<PresentSlide[]>([])

  function readSlides(doc: Y.Doc) {
    if (holdsDeck(doc))
      slides.value = readPresentSlides(doc)
  }

  watch([session, ready], ([current, isReady], _, onCleanup) => {
    slides.value = []
    if (!current || !isReady)
      return
    const doc = current.doc
    let timer: ReturnType<typeof setTimeout> | undefined
    let last = 0
    const refresh = () => {
      timer = undefined
      last = Date.now()
      readSlides(doc)
    }
    const onUpdate = () => {
      if (timer === undefined)
        timer = setTimeout(refresh, Math.max(0, last + OUTLINE_INTERVAL_MS - Date.now()))
    }
    refresh()
    doc.on('update', onUpdate)
    onCleanup(() => {
      clearTimeout(timer)
      doc.off('update', onUpdate)
    })
  }, { immediate: true })

  const headmatter = computed(() => slides.value[0]?.frontmatter ?? {})

  // Where the talk is ------------------------------------------------------

  /** The slide on screen, by id, so it stays the same slide while others add or remove slides. */
  const currentId = ref<string>()
  const clicks = ref(0)
  /** Click counts the preview reported, by what each slide shows. */
  const counts = shallowRef(new Map<string, number>())
  let lastIndex = 0

  const countOf = (item: PresentSlide | undefined) => item ? counts.value.get(countKey(item)) : undefined
  const index = computed(() => Math.max(0, slides.value.findIndex(slide => slide.id === currentId.value)))
  const slide = computed<PresentSlide | undefined>(() => slides.value[index.value])
  const deck = computed<PresentDeck>(() => ({ slides: slides.value.length, clicks: slides.value.map(countOf) }))
  const position = computed<PresentPosition>(() => ({ slide: index.value, clicks: clicks.value }))
  /** The click count of the slide on screen, once known. */
  const totalClicks = computed(() => countOf(slide.value))
  /**
   * Steps asked for before the preview said how many clicks the slide on
   * screen has. They wait, and are taken in order once it says, so a quick
   * press is never undone by the answer.
   */
  let waiting: ('next' | 'previous')[] = []

  /** Where to start: the slide in the address (counted from 1), else the first. */
  const startAt = Number(route.query.slide) - 1
  /** A place the other window asked for before the deck was here. */
  let asked: PresentMessage & { type: 'go' } | undefined

  watch(slides, (list) => {
    if (list.length === 0)
      return
    if (currentId.value === undefined) {
      currentId.value = list[Math.min(Math.max(Number.isInteger(startAt) ? startAt : 0, 0), list.length - 1)].id
      if (asked) {
        follow(asked)
        asked = undefined
      }
      else {
        // The deck's other window, if open, says where the talk is.
        channel?.post({ type: 'hello' })
      }
    }
    else if (!list.some(item => item.id === currentId.value)) {
      currentId.value = list[Math.min(lastIndex, list.length - 1)].id
      clicks.value = 0
      waiting = []
    }
    // A live edit can leave the slide on screen with fewer clicks than shown.
    const total = totalClicks.value
    if (total !== undefined && clicks.value > total)
      clicks.value = total
  })
  watch(index, (value) => {
    lastIndex = value
  })

  /** The transition the next render plays: set by a move to another slide, used once. */
  let move: { name: string, back: boolean } | undefined

  function place(target: PresentPosition, tell: boolean) {
    const list = slides.value
    if (list.length === 0)
      return
    const to = navigation.settle(deck.value, target)
    const from = index.value
    if (to.slide !== from) {
      const back = to.slide < from
      // Slidev plays the transition of the slide being left going forward, and of the slide being entered going back.
      move = { name: slideTransition((back ? list[to.slide] : list[from]).frontmatter, headmatter.value), back }
    }
    currentId.value = list[to.slide].id
    clicks.value = to.clicks
    if (tell)
      channel?.post({ type: 'go', slide: to.slide, slideId: list[to.slide].id, clicks: to.clicks })
  }

  /** Goes somewhere, and tells the other window. Steps still waiting for the preview are dropped. */
  function moveTo(target: PresentPosition) {
    waiting = []
    place(target, true)
  }

  /** Takes the steps that waited, while the slide on screen has a known click count. */
  function takeWaitingSteps() {
    while (waiting.length > 0 && totalClicks.value !== undefined) {
      const direction = waiting.shift()!
      place(navigation[direction](deck.value, position.value), true)
    }
  }

  /** One step on or back. Until the preview says how many clicks the slide on screen has, steps wait for it. */
  function step(direction: 'next' | 'previous') {
    if (slides.value.length === 0)
      return
    if (waiting.length < MOST_WAITING_MOVES)
      waiting.push(direction)
    takeWaitingSteps()
  }

  const next = () => step('next')
  const previous = () => step('previous')
  const goTo = (slideIndex: number) => moveTo(navigation.goTo(deck.value, slideIndex))
  const first = () => moveTo(navigation.first(deck.value))
  const last = () => moveTo(navigation.last(deck.value))

  /** Records a click count by what the slide shows, stops the slide on screen at its last click, and takes waiting steps. */
  function learnKey(key: string, total: number) {
    if (counts.value.get(key) !== total)
      counts.value = new Map(counts.value).set(key, total)
    const shown = totalClicks.value
    if (shown !== undefined && clicks.value > shown)
      clicks.value = shown
    takeWaitingSteps()
  }

  /** Records how many clicks a slide has, learned while drawing it. */
  function learn(drawn: Pick<PresentSlide, 'content' | 'frontmatter'>, total: number) {
    learnKey(countKey(drawn), total)
  }

  // Render requests, and which slide each reply is about --------------------

  const rendersOf = new Map<string, string>()
  let renders = 0

  /** A render request for a slide at a click, with an id its reply comes back with. */
  function requestFor(at: PresentPosition): RenderRequest | undefined {
    const shown = slides.value[at.slide]
    if (!shown)
      return undefined
    const id = `present-${++renders}`
    rendersOf.set(id, countKey(shown))
    if (rendersOf.size > REMEMBERED_RENDERS)
      rendersOf.delete(rendersOf.keys().next().value!)
    return {
      type: 'deyslide:render',
      id,
      slide: { content: shown.content, frontmatter: shown.frontmatter, first: at.slide === 0 },
      headmatter: headmatter.value,
      clicks: at.clicks,
      mode: 'present',
    }
  }

  /**
   * The render request for a step, made again only when what the step shows
   * changes, with links for the project media it shows. With `moves`, a
   * move to another slide brings its transition.
   */
  function requestOf(step: () => PresentPosition | undefined, moves = false) {
    const request = shallowRef<RenderRequest>()
    const shown = computed(() => {
      const at = step()
      const target = at && slides.value[at.slide]
      return target && { content: target.content, frontmatter: target.frontmatter, at, headmatter: headmatter.value }
    })
    watch(shown, (now, before) => {
      // Only what the slide shows matters, not a new object with the same content.
      if (JSON.stringify(now) === JSON.stringify(before))
        return
      const made = now && requestFor(now.at)
      request.value = made && moves && move ? { ...made, transition: move } : made
      if (moves)
        move = undefined
    }, { immediate: true })
    return useMediaRequest(() => request.value, mediaDeck)
  }

  /** A render's reply: the slide's click count. */
  function onRendered(result: { id?: string, clicks: number }) {
    const key = result.id === undefined ? undefined : rendersOf.get(result.id)
    if (key !== undefined)
      learnKey(key, result.clicks)
  }

  /**
   * The preview could not show a render (`requestId`). A slide that does not
   * compile has no clicks to step through, so the talk can move past it.
   */
  function onError(requestId: string | undefined, message: string) {
    const key = requestId === undefined ? undefined : rendersOf.get(requestId)
    if (key !== undefined && message !== REPLACED && !counts.value.has(key))
      learnKey(key, 0)
  }

  /** The slide on screen, with a transition only when the talk moved to it from another slide. */
  const request = requestOf(() => slide.value && position.value, true)

  // The deck's other window --------------------------------------------------

  /** Goes where the other window says, by slide id when this window knows it, else by number. */
  function follow(message: PresentMessage & { type: 'go' }) {
    const byId = message.slideId === undefined ? -1 : slides.value.findIndex(item => item.id === message.slideId)
    waiting = []
    place({ slide: byId >= 0 ? byId : message.slide, clicks: message.clicks }, false)
  }

  watch(() => props.deckId, (deckId, _, onCleanup) => {
    const opened = makeChannel(deckId)
    channel = opened
    const stop = opened.listen((message) => {
      if (message?.type === 'hello' && slides.value.length > 0)
        opened.post({ type: 'go', slide: index.value, slideId: slide.value?.id, clicks: clicks.value })
      else if (message?.type === 'go' && slides.value.length === 0)
        asked = message
      else if (message?.type === 'go')
        follow(message)
    })
    onCleanup(() => {
      stop()
      opened.close()
      if (channel === opened)
        channel = undefined
    })
  }, { immediate: true })

  // The address keeps the slide, so a reload comes back to it.
  watch(index, (value) => {
    if (slides.value.length === 0 || Number(route.query.slide) === value + 1)
      return
    void router.replace({ query: { ...route.query, slide: String(value + 1) } })
  })

  // Presence: others see the person presenting, and which slide is on screen.
  watch([session, account, currentId], ([current, person, slideId]) => {
    if (!current)
      return
    publishPresence(current.awareness, {
      ...(person ? { user: { id: person.id, name: person.name, color: '' } } : {}),
      view: 'present',
      ...(slideId ? { slideId } : {}),
    })
  }, { immediate: true })

  onBeforeUnmount(() => {
    session.value?.close()
    session.value = undefined
  })

  return {
    project,
    summary,
    session,
    problem,
    ready,
    slides,
    headmatter,
    slide,
    index,
    clicks,
    totalClicks,
    deck,
    position,
    request,
    requestOf,
    onRendered,
    onError,
    learn,
    next,
    previous,
    goTo,
    first,
    last,
    moveTo,
    channel: () => channel,
  }
}

export type Presentation = ReturnType<typeof usePresentation>
