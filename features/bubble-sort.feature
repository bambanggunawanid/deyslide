Feature: Bubble sort animation steps
  As an author of algorithm animations
  I want every decision of the sort recorded as a step
  So that the animation shows exactly what the algorithm does

  Scenario: The last step holds the sorted values
    Given the input 5, 2, 8, 1, 9, 3, 7
    When the steps are generated
    Then the final values are 1, 2, 3, 5, 7, 8, 9
    And the input is unchanged

  Scenario: Every position is marked final exactly once
    Given the input 5, 2, 8, 1, 9, 3, 7
    When the steps are generated
    Then each index from 0 to 6 settles exactly once

  Scenario: A swap always follows a compare of the same pair
    Given the input 5, 2, 8, 1, 9, 3, 7
    When the steps are generated
    Then every swap comes right after a compare of the same indices

  Scenario: Sorted input stops after one pass
    Given the input 1, 2, 3, 4
    When the steps are generated
    Then there are no swaps
    And there are 3 compares

  Scenario: Empty input has no steps
    Given an empty input
    When the steps are generated
    Then there are no steps
