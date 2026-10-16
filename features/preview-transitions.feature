Feature: Slide transitions while presenting
  As a presenter
  I want slides to change with the transition the deck names, the way Slidev plays it
  So that a talk looks the same in Deyslide as in Slidev

  Scenario Outline: Transition names play the way Slidev plays them
    When the transition "<name>" plays <direction>
    Then the preview plays "<played>"

    Examples:
      | name        | direction | played      |
      | slide-left  | forward   | slide-left  |
      | slide-left  | back      | slide-right |
      | slide-right | back      | slide-left  |
      | slide-up    | back      | slide-down  |
      | slide-down  | back      | slide-up    |
      | fade        | back      | fade        |
      | fade-out    | forward   | fade-out    |
      | none        | forward   | nothing     |
      | spin        | forward   | nothing     |

  Scenario: A slide's own transition comes before the deck's
    Given a deck whose transition is "fade"
    Then a slide without a transition uses "fade"
    And a slide whose transition is "slide-up" uses "slide-up"

  Scenario: Moving to another slide while presenting plays the transition
    Given the preview frame presents a slide titled "One"
    When the presenter moves forward to "Two" with the transition "slide-left"
    Then "Two" enters with "slide-left"
    And "One" leaves with "slide-left"

  Scenario: Moving back plays the transition in reverse
    Given the preview frame presents a slide titled "Two"
    When the presenter moves back to "One" with the transition "slide-left"
    Then "One" enters with "slide-right"

  Scenario: The deck's transition plays when the move names none
    Given the preview frame presents a slide titled "One" of a deck whose transition is "fade"
    When the presenter moves forward to "Two" without naming a transition
    Then "Two" enters with "fade"

  Scenario: Moving forward plays the transition of the slide being left, as in Slidev
    Given the preview frame presents a slide titled "One" whose transition is "slide-up", of a deck whose transition is "fade"
    When the presenter moves forward to "Two" without naming a transition
    Then "Two" enters with "slide-up"

  Scenario: Moving back plays the transition of the slide being entered, reversed
    Given the preview frame presents a slide titled "Two" whose transition is "fade", of a deck whose transition is "fade"
    When the presenter moves back to "One", whose transition is "slide-up", without naming a transition
    Then "One" enters with "slide-down"

  Scenario: The slide being left keeps showing what it showed until it is gone
    Given the preview frame presents a list revealed by clicks, at its last click
    When the presenter moves forward to "Two" with the transition "slide-left"
    Then the list is still mounted beside "Two", with every item shown and its click count unchanged
    And once the transition ends, only "Two" is mounted

  Scenario: Stepping through clicks plays no transition
    Given the preview frame presents a list revealed by clicks
    When the presenter moves to the next click
    Then no transition plays and the slide stays mounted

  Scenario: Editing swaps slides at once
    Given the preview frame shows a slide titled "One" for editing
    When the editor asks for "Two" with the transition "slide-left"
    Then "Two" replaces "One" with no transition

  Scenario: Quick moves in a window that paints nothing keep only the slide being left
    Given the preview frame presents a slide titled "One", in a window that paints no frames
    When the presenter moves forward to "Two", "Three" and "Four" with the transition "slide-left"
    Then only "Three", on its way out, and "Four" are mounted

  Scenario: In a window nobody can see, the next slide replaces the last at once
    Given the preview frame presents a slide titled "One", in a window nobody can see
    When the presenter moves forward to "Two" with the transition "slide-left"
    Then "Two" replaces "One" with no transition

  Scenario: While presenting, the slide covers the whole frame
    Given the preview frame is shown at 1280 by 720 pixels
    When it shows a slide for editing
    Then the slide fits the frame exactly
    When it presents the slide
    Then the slide is at least a pixel taller than the frame, so no dark line shows along its bottom edge
