import type { VideoOptions } from '../apps/deck/scripts/video-plan'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { dwellFor, parseVideoArgs } from '../apps/deck/scripts/video-plan'

const feature = await loadFeature('./video-options.feature')

function argv(flags: string) {
  return flags.split(' ').filter(Boolean)
}

describeFeature(feature, ({ Scenario, ScenarioOutline }) => {
  Scenario('Defaults give a 1080p WebM', ({ When, Then, And }) => {
    let options: VideoOptions
    When('I run the export with no flags', () => {
      options = parseVideoArgs([])
    })
    Then('the video is 1920 by 1080', () => {
      expect([options.width, options.height]).toEqual([1920, 1080])
    })
    And('it is saved to "exports/deyslide.webm"', () => {
      expect(options.output).toBe('exports/deyslide.webm')
    })
    And('each step stays on screen for 3000 ms', () => {
      expect(options.dwellMs).toBe(3000)
    })
  })

  Scenario('Flags override the defaults', ({ When, Then, And }) => {
    let options: VideoOptions
    When('I run the export with "--width=1280 --height 720 --dwell 5000 --output exports/talk.webm"', () => {
      options = parseVideoArgs(argv('--width=1280 --height 720 --dwell 5000 --output exports/talk.webm'))
    })
    Then('the video is 1280 by 720', () => {
      expect([options.width, options.height]).toEqual([1280, 720])
    })
    And('it is saved to "exports/talk.webm"', () => {
      expect(options.output).toBe('exports/talk.webm')
    })
    And('each step stays on screen for 5000 ms', () => {
      expect(options.dwellMs).toBe(5000)
    })
  })

  ScenarioOutline('Invalid flags stop the export', ({ When, Then }, variables) => {
    let error: unknown
    When('I run the export with "<flags>"', () => {
      try {
        parseVideoArgs(argv(variables.flags))
      }
      catch (caught) {
        error = caught
      }
    })
    Then('the export stops with "<message>"', () => {
      expect(String(error)).toContain(variables.message)
    })
  })

  ScenarioOutline('A slide can ask for more screen time', ({ Given, When, Then }, variables) => {
    let frontmatter: Record<string, unknown>
    let dwell: number
    Given('a slide with frontmatter videoDwell <seconds>', () => {
      frontmatter = variables.seconds === 'none' ? {} : { videoDwell: Number(variables.seconds) }
    })
    When('the dwell time is computed with a default of 3000 ms', () => {
      dwell = dwellFor(frontmatter, 3000)
    })
    Then('the slide stays on screen for <ms> ms', () => {
      expect(dwell).toBe(Number(variables.ms))
    })
  })
})
