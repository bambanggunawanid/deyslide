Feature: Markdown editor
  As a person writing a deck
  I want to edit its Slidev Markdown and see the slide I am on
  So that I can shape the talk and see the result as I type

  Scenario: Opening a deck shows its Markdown and its first slide
    Given the demo deck "Sorting" is open in the editor
    Then the editor holds the deck's Markdown, starting with its frontmatter
    And the preview shows slide 1 of 5, the cover titled "Deyslide"

  Scenario: Typing updates the preview
    Given the blank deck "Graphs" is open in the editor
    When I change the Markdown so the first slide reads "Hello"
    Then the preview is asked to render the heading "Hello"

  Scenario: The preview follows the cursor
    Given the demo deck "Sorting" is open in the editor
    When the cursor moves into the third slide
    Then the preview shows slide 3 of 5 with the layout "two-cols"

  Scenario: Step through clicks
    Given the demo deck "Sorting" is open in the editor
    And the cursor is in the third slide, which the preview says has 3 clicks
    When I press the next click button twice
    Then the preview is asked to show click 2, and the counter reads "Click 2 of 3"

  Scenario: The slide buttons move the cursor too
    Given the demo deck "Sorting" is open in the editor
    When I press the next slide button
    Then the preview shows slide 2 of 5
    And the editor cursor jumps to the first line of slide 2

  Scenario: Changes are saved
    Given the blank deck "Graphs" is open in the editor
    When I change the Markdown so the first slide reads "Changed"
    Then the editor says "Saved" after a moment
    And the stored deck's first slide reads "Changed"

  Scenario: A failed save says so
    Given Ana is signed in with the blank deck "Graphs" open in the editor
    And the server cannot be reached
    When I change the Markdown so the first slide reads "Offline"
    Then the editor says "Not saved: Deyslide is unreachable. Check your connection and try again."

  Scenario: Phones switch between writing and the preview
    Given the blank deck "Graphs" is open in the editor
    When I choose the "Preview" tab
    Then the preview is shown and the editor is hidden on small screens
