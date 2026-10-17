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

  Scenario: A slide typed in the editor shows in the preview once it is in the deck
    Given the demo deck "Sorting" is open in the editor
    When I type a new slide "# Brand new" after the first slide, with the cursor in it
    Then a moment later the preview shows slide 2 of 6, the slide "# Brand new"

  Scenario: Changes are saved
    Given Ana is signed in with the blank deck "Graphs" open in the editor
    And the server is slow to confirm changes
    When I change the Markdown so the first slide reads "Changed"
    Then the editor says "Saving..." at once, and still once the change reached the server
    When the server confirms the changes
    Then the editor says "Saved"
    And the account's deck has the first slide "Changed"

  Scenario: Changes in the browser are saved
    Given the blank deck "Graphs" is open in the editor
    When I change the Markdown so the first slide reads "Changed"
    Then the editor says "Saving..." until the change is in the deck
    And the browser's storage has the first slide "Changed" after a moment
    And the editor says "Saved"

  Scenario: A failed save says so
    Given Ana is signed in with the blank deck "Graphs" open in the editor
    When the server stops letting Ana into the deck
    Then the editor says "Not saved: You no longer have access to this deck."
    And the editor is read only

  Scenario: Working offline says so, and the changes go out once back online
    Given Ana is signed in with the blank deck "Graphs" open in the editor
    When the connection drops
    Then the editor says "Offline. Changes sync when you are back online."
    When I change the Markdown so the first slide reads "On the train"
    And the connection comes back
    Then the editor says "Saved"
    And the account's deck has the first slide "On the train"

  Scenario: Leaving the deck while offline keeps the changes for later
    Given Ana is signed in with the blank deck "Graphs" open in the editor
    When the connection drops
    And I change the Markdown so the first slide reads "Written offline"
    And I go to the project page
    Then the project page shows, without a question
    When the connection comes back
    Then the account's deck has the first slide "Written offline"

  Scenario: Markdown that cannot be read shows the error under the editor
    Given the blank deck "Graphs" is open in the editor
    When I break the YAML of the deck's frontmatter
    Then the error under the editor starts with "The frontmatter is not valid YAML."
    And the editor says "Not saved: fix the Markdown error."
    And the stored deck still has the title "Graphs"
    And closing the tab asks first

  Scenario: A change held back by an error survives a switch to Design and back
    Given the blank deck "Graphs" is open in the editor
    When I add the paragraph "Careful writing." and break the YAML of the deck's frontmatter
    And I switch to the Design view and back to Markdown
    Then the editor still has "Careful writing." and the broken YAML, with the error under it
    When I fix the YAML
    Then the browser's storage has "Careful writing." after a moment

  Scenario: Leaving with a change held back by an error asks first
    Given the blank deck "Graphs" is open in the editor
    When I break the YAML of the deck's frontmatter
    And I go to the project page
    Then the page asks "Leave without your last change?" and the deck stays open
    When I choose to stay
    Then the editor still has the broken YAML
    When I go to the project page and choose to leave without it
    Then the project page shows, and the stored deck still has the title "Graphs"

  Scenario: Half typed Markdown is shown softly and waits
    Given the blank deck "Graphs" is open in the editor
    When I start an HTML comment on the first slide
    Then a note under the editor says "Slide 1 has an HTML comment that is not closed. Close it with -->."
    And the note is not an alert
    And the editor says "Not saved yet: finish the Markdown change."
    And the stored deck's first slide still reads "Graphs"

  Scenario: Text typed after the --- on line 1 is not saved, and the editor says why
    Given the blank deck "Graphs" is open in the editor
    When I type "x" right after the "---" on line 1
    Then the error under the editor says "Line 1 is a slide break, and Slidev ignores anything after its ---. Keep --- alone on that line."
    And the editor says "Not saved: fix the Markdown error."
    And the stored deck still has "---" alone on line 1

  Scenario: Phones switch between writing and the preview
    Given the blank deck "Graphs" is open in the editor
    When I choose the "Preview" tab
    Then the preview is shown and the editor is hidden on small screens
