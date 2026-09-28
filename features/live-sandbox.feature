Feature: Live sandbox component
  As a workshop host
  I want switches, steppers and a JSON inspector on a slide
  So that students see state change the moment I touch a control

  Background:
    Given the live sandbox is mounted with debug off and count 1

  Scenario: Flip a switch
    When I click the "debug" switch
    Then the "debug" switch is on
    And the inspector shows "debug": true
    And a change event reports "debug" going from false to true

  Scenario: Step a counter with the configured step
    When I click the plus button for "count"
    Then the "count" value reads 1.5

  Scenario: Undo and reset from the header
    When I click the plus button for "count"
    And I click "Undo"
    Then the "count" value reads 1
    When I click the "debug" switch
    And I click "Reset"
    Then the "debug" switch is off

  Scenario: Slot content reads the live state
    Then the slot shows "debug is off"
    When I click the "debug" switch
    Then the slot shows "debug is on"
