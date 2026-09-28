import type { SortStep } from '../animations/src/logic/bubble-sort-steps'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { bubbleSortSteps, finalValues } from '../animations/src/logic/bubble-sort-steps'

const feature = await loadFeature('./bubble-sort.feature')

describeFeature(feature, ({ Scenario }) => {
  let input: number[]
  let steps: SortStep[]
  const generate = () => {
    steps = bubbleSortSteps(input)
  }

  Scenario('The last step holds the sorted values', ({ Given, When, Then, And }) => {
    Given('the input 5, 2, 8, 1, 9, 3, 7', () => {
      input = [5, 2, 8, 1, 9, 3, 7]
    })
    When('the steps are generated', generate)
    Then('the final values are 1, 2, 3, 5, 7, 8, 9', () => {
      expect(finalValues(steps, input)).toEqual([1, 2, 3, 5, 7, 8, 9])
    })
    And('the input is unchanged', () => {
      expect(input).toEqual([5, 2, 8, 1, 9, 3, 7])
    })
  })

  Scenario('Every position is marked final exactly once', ({ Given, When, Then }) => {
    Given('the input 5, 2, 8, 1, 9, 3, 7', () => {
      input = [5, 2, 8, 1, 9, 3, 7]
    })
    When('the steps are generated', generate)
    Then('each index from 0 to 6 settles exactly once', () => {
      const settled = steps.flatMap(step => (step.kind === 'settle' ? [step.index] : []))
      expect([...settled].sort()).toEqual([0, 1, 2, 3, 4, 5, 6])
    })
  })

  Scenario('A swap always follows a compare of the same pair', ({ Given, When, Then }) => {
    Given('the input 5, 2, 8, 1, 9, 3, 7', () => {
      input = [5, 2, 8, 1, 9, 3, 7]
    })
    When('the steps are generated', generate)
    Then('every swap comes right after a compare of the same indices', () => {
      steps.forEach((step, index) => {
        if (step.kind !== 'swap')
          return
        const previous = steps[index - 1]
        expect(previous.kind).toBe('compare')
        expect(previous.kind === 'compare' && previous.indices).toEqual(step.indices)
      })
    })
  })

  Scenario('Sorted input stops after one pass', ({ Given, When, Then, And }) => {
    Given('the input 1, 2, 3, 4', () => {
      input = [1, 2, 3, 4]
    })
    When('the steps are generated', generate)
    Then('there are no swaps', () => {
      expect(steps.filter(step => step.kind === 'swap')).toHaveLength(0)
    })
    And('there are 3 compares', () => {
      expect(steps.filter(step => step.kind === 'compare')).toHaveLength(3)
    })
  })

  Scenario('Empty input has no steps', ({ Given, When, Then }) => {
    Given('an empty input', () => {
      input = []
    })
    When('the steps are generated', generate)
    Then('there are no steps', () => {
      expect(steps).toEqual([])
    })
  })
})
