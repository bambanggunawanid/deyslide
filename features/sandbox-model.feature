Feature: Sandbox state model
  As a workshop host
  I want a small state store with safe rules
  So that live edits during a class never leave the demo broken

  Background:
    Given a sandbox with debug off, retries 2 and name "demo"

  Scenario: Toggle a boolean
    When I toggle "debug"
    Then "debug" is true
    And the history has 1 change

  Scenario: Step a number
    When I step "retries" by 3
    Then "retries" is 5

  Scenario: Undo the last change
    When I step "retries" by 3
    And I undo
    Then "retries" is 2
    And the history is empty

  Scenario: Reset returns to the starting state
    When I toggle "debug"
    And I set "name" to "live"
    And I reset
    Then the snapshot equals the starting state
    And the history is empty

  Scenario: Wrong types are rejected
    When I try to toggle "retries"
    Then the sandbox refuses with "is not a boolean"
    And "retries" is 2

  Scenario: Unknown keys are rejected
    When I try to set "color" to "red"
    Then the sandbox refuses with "Unknown sandbox key"

  Scenario: Setting the same value records nothing
    When I set "name" to "demo"
    Then the history is empty

  Scenario: History keeps only the newest changes
    Given the history limit is 3
    When I step "retries" by 1 five times
    Then the history has 3 changes
    And the oldest change goes from 4 to 5
