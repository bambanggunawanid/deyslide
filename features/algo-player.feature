Feature: Algorithm player
  As a presenter
  I want play, pause, restart and loop controls around a Motion Canvas animation
  So that I can pace an algorithm walkthrough to the room

  Background:
    Given the algorithm player is mounted with "/animations/bubble-sort.js"

  Scenario: Controls wait for the animation to load
    Then the status reads "loading"
    And the play button is disabled

  Scenario: Autoplay starts once the animation is ready
    When the animation finishes loading
    Then the status reads "ready"
    And the animation is playing
    And looping is turned on in the player

  Scenario: Pause and resume from the control bar
    Given the animation finishes loading
    When I click the play button
    Then the animation is paused
    And the play button reads "Play"
    When I click the play button again
    Then the animation is playing again

  Scenario: Leaving the slide pauses the animation
    Given the animation finishes loading
    When the presenter moves to another slide
    Then the animation is paused
    When the presenter comes back to the slide
    Then the animation is playing

  Scenario: Turn looping off
    Given the animation finishes loading
    When I click the loop button
    Then looping is turned off in the player
    And the loop button reads "Loop: off"

  Scenario: Restart from the first frame
    Given the animation finishes loading
    When I click the restart button
    Then the player resets to the first frame
    And the animation is playing

  Scenario: A missing bundle shows an error
    When the animation never finishes loading
    Then the status reads "error"
    And an alert tells me to run "pnpm animations:build"
