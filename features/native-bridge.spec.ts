import type { RenderedSlide } from '../apps/web/src/platform/native'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect, vi } from 'vitest'
import * as native from '../apps/web/src/platform/native'

interface FakeEvent { event: string, id: number, payload: unknown }

interface EventTarget { kind: string, label?: string }

interface FakeListener {
  event: string
  /** The window the page listened in. */
  window: string
  /** The events it takes: any window's (`Any`) or one window's. */
  target: EventTarget
  handler: (event: FakeEvent) => void
}

// A stand in for the app: records commands, answers them, and delivers
// events to the listeners of every window, as Tauri does.
const app = vi.hoisted(() => {
  const app = {
    loaded: [] as string[],
    answer: { from: 'the app' } as unknown,
    /** The window the page that runs next is in. */
    window: 'main',
    invoke: vi.fn(async (..._call: unknown[]) => undefined as unknown),
    emit: vi.fn(async (event: string, payload?: unknown) => app.deliver(event, payload)),
    listeners: [] as FakeListener[],
    listen(event: string, target: EventTarget, handler: (event: FakeEvent) => void) {
      const listener = { event, window: app.window, target, handler }
      app.listeners.push(listener)
      return () => {
        app.listeners.splice(app.listeners.indexOf(listener), 1)
      }
    },
    deliver(event: string, payload: unknown) {
      for (const listener of app.listeners.filter(listener => listener.event === event))
        listener.handler({ event, id: 1, payload })
    },
    listening(event: string) {
      return app.listeners.filter(listener => listener.event === event)
    },
  }
  return app
})

vi.mock('@tauri-apps/api/core', () => {
  app.loaded.push('@tauri-apps/api/core')
  return { invoke: app.invoke }
})

vi.mock('@tauri-apps/api/event', () => {
  app.loaded.push('@tauri-apps/api/event')
  return {
    emit: app.emit,
    listen: async (event: string, handler: (event: FakeEvent) => void, options?: { target?: EventTarget }) =>
      app.listen(event, options?.target ?? { kind: 'Any' }, handler),
  }
})

vi.mock('@tauri-apps/api/webviewWindow', () => {
  app.loaded.push('@tauri-apps/api/webviewWindow')
  return {
    getCurrentWebviewWindow: () => {
      const label = app.window
      return {
        label,
        listen: async (event: string, handler: (event: FakeEvent) => void) =>
          app.listen(event, { kind: 'WebviewWindow', label }, handler),
      }
    },
  }
})

const feature = await loadFeature('./native-bridge.feature')

const drawnSlide: RenderedSlide = { png: 'iVBO', clicks: 2, overflow: false }

/** Each call in the feature's examples, written the way a page makes it. */
const CALLS: Record<string, () => Promise<unknown>> = {
  'libraryInfo()': () => native.libraryInfo(),
  'librarySetRoot("/home/ana/Decks")': () => native.librarySetRoot('/home/ana/Decks'),
  'libraryList()': () => native.libraryList(),
  'libraryCreateProject("Algorithms")': () => native.libraryCreateProject('Algorithms'),
  'libraryRenameProject("local-p-1", "Graphs")': () => native.libraryRenameProject('local-p-1', 'Graphs'),
  'libraryDeleteProject("local-p-1")': () => native.libraryDeleteProject('local-p-1'),
  'libraryCreateDeck("local-p-1", "Sorting", "Slide")': () => native.libraryCreateDeck('local-p-1', 'Sorting', 'Slide'),
  'libraryRenameDeck("local-d-2", "Searching")': () => native.libraryRenameDeck('local-d-2', 'Searching'),
  'libraryDeleteDeck("local-d-2")': () => native.libraryDeleteDeck('local-d-2'),
  'libraryReadDeck("local-d-2")': () => native.libraryReadDeck('local-d-2'),
  'libraryWriteDeck("local-d-2", "New", "Old")': () => native.libraryWriteDeck('local-d-2', 'New', 'Old'),
  'libraryWriteDeck("local-d-2", "New", null)': () => native.libraryWriteDeck('local-d-2', 'New', null),
  'renderRespond("r1", one drawn slide)': () => native.renderRespond('r1', [drawnSlide]),
  'authSignIn()': () => native.authSignIn(),
  'authSignOut()': () => native.authSignOut(),
  'authAccessToken()': () => native.authAccessToken(),
  'authAccount()': () => native.authAccount(),
  'mcpSetup()': () => native.mcpSetup(),
  'presentOpen("local-p-1", "local-d-2")': () => native.presentOpen('local-p-1', 'local-d-2'),
  'appInfo()': () => native.appInfo(),
  'appRestart()': () => native.appRestart(),
}

const LISTENERS: Record<string, (handler: (...heard: unknown[]) => void) => Promise<() => void>> = {
  onLibraryChanged: native.onLibraryChanged,
  onDeckChanged: native.onDeckChanged,
  onRenderRequest: native.onRenderRequest,
  onAccountChanged: native.onAccountChanged,
  onPresentSync: native.onPresentSync,
}

describeFeature(feature, ({ Scenario, ScenarioOutline, BeforeEachScenario }) => {
  BeforeEachScenario(() => {
    app.invoke.mockReset()
    app.invoke.mockImplementation(async () => app.answer)
    app.emit.mockClear()
    app.listeners.length = 0
    app.window = 'main'
  })

  Scenario('The website never loads the app\'s packages', ({ Given, When, Then }) => {
    Given('the wrappers for the app are imported', () => {
      expect(native.appInfo).toBeTypeOf('function')
    })
    Then('nothing from "@tauri-apps/api" has loaded', () => {
      expect(app.loaded).toEqual([])
    })
    When('a page asks for the app info', async () => {
      await native.appInfo()
    })
    Then('"@tauri-apps/api/core" has loaded', () => {
      expect(app.loaded).toEqual(['@tauri-apps/api/core'])
    })
  })

  ScenarioOutline('A wrapper calls its command', ({ When, Then, And }, variables) => {
    let answer: unknown
    When('a page calls <call>', async () => {
      const call = CALLS[variables.call]
      expect(call, `no call written for ${variables.call}`).toBeDefined()
      answer = await call!()
    })
    Then('the app gets the command "<command>" with <arguments>', () => {
      expect(app.invoke).toHaveBeenCalledTimes(1)
      const [command, args] = app.invoke.mock.calls[0]!
      expect(command).toBe(variables.command)
      if (variables.arguments === 'no arguments')
        expect(args).toBeUndefined()
      else
        expect(args).toEqual(JSON.parse(variables.arguments))
    })
    And('the page gets the app\'s answer', () => {
      expect(answer).toBe(app.answer)
    })
  })

  Scenario('Saving a file sends its bytes as they are', ({ When, Then, And }) => {
    const bytes = new Uint8Array([37, 80, 68, 70])
    When('a page saves the bytes 37, 80, 68, 70 to "/home/ana/Talks/Sorting slides.pdf"', async () => {
      await native.saveFile('/home/ana/Talks/Sorting slides.pdf', bytes)
    })
    Then('the app gets the command "save_file" with those bytes as the request body', () => {
      const [command, body] = app.invoke.mock.calls[0]!
      expect(command).toBe('save_file')
      expect(body).toBe(bytes)
    })
    And('the request names the path in the header "x-deyslide-path" as "%2Fhome%2Fana%2FTalks%2FSorting%20slides.pdf"', () => {
      const options = app.invoke.mock.calls[0]![2] as { headers: Record<string, string> }
      expect(options.headers).toEqual({ 'x-deyslide-path': '%2Fhome%2Fana%2FTalks%2FSorting%20slides.pdf' })
      expect(decodeURIComponent(options.headers['x-deyslide-path']!)).toBe('/home/ana/Talks/Sorting slides.pdf')
    })
  })

  ScenarioOutline('A wrapper hears its event', ({ When, And, Then }, variables) => {
    const handler = vi.fn()
    let stop: () => void
    When('a page listens with <wrapper>', async () => {
      stop = await LISTENERS[variables.wrapper]!(handler)
    })
    And('the app sends "<event>" with <payload>', () => {
      expect(app.listening(variables.event), `nothing listens to ${variables.event}`).toHaveLength(1)
      app.deliver(variables.event, JSON.parse(variables.payload))
    })
    Then('the page hears <heard>', () => {
      expect(handler).toHaveBeenCalledTimes(1)
      if (variables.heard === 'no details')
        expect(handler).toHaveBeenCalledWith()
      else
        expect(handler).toHaveBeenCalledWith(JSON.parse(variables.payload))
    })
    When('the page stops listening', () => {
      stop()
    })
    Then('nothing listens to "<event>" anymore', () => {
      expect(app.listening(variables.event)).toEqual([])
    })
  })

  Scenario('Only the main window draws slides for Claude Code', ({ Given, When, Then, And }) => {
    let stop: () => void
    Given('a page in the window "main"', () => {
      app.window = 'main'
    })
    When('the page listens with onRenderRequest', async () => {
      stop = await native.onRenderRequest(() => {})
    })
    Then('the page listens to "render-request" in the window "main" only', () => {
      // Tauri hands a listener for any window every event sent to one window.
      expect(app.listening('render-request').map(listener => listener.target)).toEqual([
        { kind: 'WebviewWindow', label: 'main' },
      ])
    })
    And('the app gets the command "render_ready" with {"ready":true}', () => {
      expect(app.invoke.mock.calls).toEqual([['render_ready', { ready: true }, undefined]])
    })
    When('the page stops listening', () => {
      stop()
    })
    Then('the app gets the command "render_ready" with {"ready":false}', () => {
      expect(app.listening('render-request')).toEqual([])
      expect(app.invoke.mock.calls.at(-1)).toEqual(['render_ready', { ready: false }, undefined])
    })
  })

  Scenario('The presenter window tells the audience window', ({ Given, When, Then }) => {
    Given('a page in the window "main"', () => {
      app.window = 'main'
    })
    When('the presenter page sends slide 3 of the deck "local-d-2" to the other windows', async () => {
      await native.emitPresentSync({ deckId: 'local-d-2', message: { slide: 3 } })
    })
    Then('the app sends "present-sync" with {"deckId":"local-d-2","message":{"slide":3},"from":"main"}', () => {
      expect(app.emit).toHaveBeenCalledWith('present-sync', { deckId: 'local-d-2', message: { slide: 3 }, from: 'main' })
    })
  })

  Scenario('A window does not hear what it sent itself', ({ Given, And, When, Then }) => {
    const presenter = vi.fn()
    const audience = vi.fn()
    Given('the presenter page in the window "main" listens with onPresentSync', async () => {
      app.window = 'main'
      await native.onPresentSync(presenter)
    })
    And('the audience page in the window "present-local-d-2" listens with onPresentSync', async () => {
      app.window = 'present-local-d-2'
      await native.onPresentSync(audience)
    })
    When('the presenter page sends slide 3 of the deck "local-d-2" to the other windows', async () => {
      app.window = 'main'
      await native.emitPresentSync({ deckId: 'local-d-2', message: { slide: 3 } })
    })
    Then('the audience page hears {"deckId":"local-d-2","message":{"slide":3}}', () => {
      expect(audience).toHaveBeenCalledTimes(1)
      expect(audience).toHaveBeenCalledWith({ deckId: 'local-d-2', message: { slide: 3 } })
    })
    And('the presenter page hears nothing', () => {
      expect(presenter).not.toHaveBeenCalled()
    })
  })
})
