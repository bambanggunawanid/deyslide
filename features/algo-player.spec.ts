import type { VueWrapper } from '@vue/test-utils'
import type { MotionCanvasPlayerElement } from '../packages/components/src/algo-player/controller'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { flushPromises, mount } from '@vue/test-utils'
import type { Mock } from 'vitest'
import { expect, vi } from 'vitest'
import DeyslideAlgoPlayer from '../packages/components/components/DeyslideAlgoPlayer.vue'
import { resetSlidevTestState, slidevTestState } from './support/slidev-client'

// The real package registers a canvas based Web Component. The tests fake
// the element members that the controller drives instead.
vi.mock('@motion-canvas/player', () => ({}))

const feature = await loadFeature('./algo-player.feature')

type FakePlayer = MotionCanvasPlayerElement & {
  player: { toggleLoop: Mock<(value?: boolean) => void>, requestReset: Mock<() => void> }
}

describeFeature(feature, ({ Background, Scenario, AfterEachScenario }) => {
  let wrapper: VueWrapper
  let element: FakePlayer

  AfterEachScenario(() => {
    wrapper?.unmount()
    vi.useRealTimers()
  })

  Background(({ Given }) => {
    Given('the algorithm player is mounted with "/animations/bubble-sort.js"', async () => {
      vi.useFakeTimers()
      resetSlidevTestState()
      wrapper = mount(DeyslideAlgoPlayer, {
        props: { src: '/animations/bubble-sort.js', timeoutMs: 1000 },
      })
      await flushPromises()
      element = wrapper.get('motion-canvas-player').element as FakePlayer
    })
  })

  async function finishLoading() {
    element.state = 'ready'
    element.playing = false
    element.setPlaying = vi.fn((value: boolean) => {
      element.playing = value
    })
    element.player = { toggleLoop: vi.fn<(value?: boolean) => void>(), requestReset: vi.fn<() => void>() }
    vi.advanceTimersByTime(100)
    await flushPromises()
  }

  const button = (name: string) => wrapper.get(`[data-testid="algo-${name}"]`)
  const statusText = () => wrapper.get('[data-testid="algo-status"]').text()

  Scenario('Controls wait for the animation to load', ({ Then, And }) => {
    Then('the status reads "loading"', () => expect(statusText()).toBe('loading'))
    And('the play button is disabled', () => {
      expect(button('toggle').attributes('disabled')).toBeDefined()
    })
  })

  Scenario('Autoplay starts once the animation is ready', ({ When, Then, And }) => {
    When('the animation finishes loading', finishLoading)
    Then('the status reads "ready"', () => expect(statusText()).toBe('ready'))
    And('the animation is playing', () => expect(element.playing).toBe(true))
    And('looping is turned on in the player', () => {
      expect(element.player.toggleLoop).toHaveBeenLastCalledWith(true)
    })
  })

  Scenario('Pause and resume from the control bar', ({ Given, When, Then, And }) => {
    Given('the animation finishes loading', finishLoading)
    When('I click the play button', () => button('toggle').trigger('click'))
    Then('the animation is paused', () => expect(element.playing).toBe(false))
    And('the play button reads "Play"', () => expect(button('toggle').text()).toBe('Play'))
    When('I click the play button again', () => button('toggle').trigger('click'))
    Then('the animation is playing again', () => expect(element.playing).toBe(true))
  })

  Scenario('Leaving the slide pauses the animation', ({ Given, When, Then }) => {
    Given('the animation finishes loading', finishLoading)
    When('the presenter moves to another slide', async () => {
      slidevTestState.isSlideActive.value = false
      await flushPromises()
    })
    Then('the animation is paused', () => expect(element.playing).toBe(false))
    When('the presenter comes back to the slide', async () => {
      slidevTestState.isSlideActive.value = true
      await flushPromises()
    })
    Then('the animation is playing', () => expect(element.playing).toBe(true))
  })

  Scenario('Turn looping off', ({ Given, When, Then, And }) => {
    Given('the animation finishes loading', finishLoading)
    When('I click the loop button', () => button('loop').trigger('click'))
    Then('looping is turned off in the player', () => {
      expect(element.player.toggleLoop).toHaveBeenLastCalledWith(false)
    })
    And('the loop button reads "Loop: off"', () => expect(button('loop').text()).toBe('Loop: off'))
  })

  Scenario('Restart from the first frame', ({ Given, When, Then, And }) => {
    Given('the animation finishes loading', finishLoading)
    When('I click the restart button', () => button('restart').trigger('click'))
    Then('the player resets to the first frame', () => {
      expect(element.player.requestReset).toHaveBeenCalledOnce()
    })
    And('the animation is playing', () => expect(element.playing).toBe(true))
  })

  Scenario('A missing bundle shows an error', ({ When, Then, And }) => {
    When('the animation never finishes loading', async () => {
      vi.advanceTimersByTime(1100)
      await flushPromises()
    })
    Then('the status reads "error"', () => expect(statusText()).toBe('error'))
    And('an alert tells me to run "pnpm animations:build"', () => {
      expect(wrapper.get('[role="alert"]').text()).toContain('pnpm animations:build')
    })
  })
})
