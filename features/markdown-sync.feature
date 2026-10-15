Feature: Markdown view in sync with the live deck
  As a person writing a deck in Markdown while others change it
  I want my typing and their changes to meet in the same live deck
  So that nobody's work is lost and my cursor stays where I type

  Background:
    Given Ana and Budi have the account deck "Sorting" of five slides open, Ana in the Markdown view

  Scenario: Typing reaches the deck and the other person
    When Ana types "# Bubble sort, slowly" in place of the heading of slide 2
    Then a moment later the live deck has "# Bubble sort, slowly" on slide 2
    And Budi's deck has it too

  Scenario: A change to another slide edits only that slide and keeps the cursor
    Given Ana's cursor is at the end of the heading on slide 1
    When Budi changes the heading of slide 3 to "# Quick sort"
    Then Ana's editor shows "# Quick sort" on slide 3
    And every edit to Ana's editor lies inside slide 3
    And Ana's cursor is still at the end of the heading on slide 1

  Scenario: Someone typing in the slide being edited leaves the cursor in place
    Given Ana's cursor is right after "Bubble" in the heading on slide 2
    When Budi types "Slow " at the start of that heading and " fast" at its end
    Then Ana's editor shows "# Slow Bubble sort fast" on slide 2
    And Ana's cursor is still right after "Bubble"

  Scenario: Typing on slide 1 while a change lands on slide 2 keeps both
    When Ana types "# Sorting, live" in place of the heading of slide 1
    And Budi changes the heading of slide 2 to "# Bubble sort, by Budi" before Ana's typing is merged
    Then the live deck has both changes, each once, on five slides
    And Ana's editor shows both changes

  Scenario: An open HTML comment changes nothing until it is closed
    When Ana starts an HTML comment after the heading of slide 1
    Then the live deck still has its five slides as they were
    And Ana sees the soft note "Slide 1 has an HTML comment that is not closed. Close it with -->."
    When Ana closes the comment
    Then the live deck has five slides, with the comment on slide 1

  Scenario: A comment that would run into another slide waits until it is closed
    Given Budi wrote "Split --> merge" on slide 3, and Ana's editor shows it
    When Ana starts an HTML comment after the heading of slide 1, which would end at the arrow on slide 3
    Then the live deck still has its five slides
    And Ana sees a soft note that the change would join slides Ana did not edit
    When Ana closes the comment
    Then the live deck has five slides, with the comment on slide 1 and the arrow still on slide 3

  Scenario: A held comment stays held while Ana types on another slide too
    Given Budi wrote "Split --> merge" on slide 3, and Ana's editor shows it
    When Ana starts an HTML comment after the heading of slide 1, which would end at the arrow on slide 3
    And Ana changes the heading of slide 5 to "# Summary of it all"
    Then the live deck still has its five slides
    And Ana sees a soft note that the change would join slides Ana did not edit
    When Budi changes the heading of slide 4 to "# Heap sort, in place"
    Then the note ends with "Finish this change to see others' changes."
    When Ana closes the comment
    Then the live deck has five slides: the comment on slide 1, the arrow on slide 3, Budi's heading on slide 4 and Ana's on slide 5

  Scenario: A change made while Ana's YAML is broken is neither lost nor duplicated
    Given Ana broke the YAML of the deck's frontmatter
    When Budi changes the heading of slide 4 to "# Heap sort, in place"
    Then Ana's editor still shows slide 4 as it was, and says "Fix the error to see others' changes."
    When Ana fixes the YAML with the title "Sorted"
    Then the live deck has "# Heap sort, in place" once, the title "Sorted" and five slides
    And Ana's editor shows "# Heap sort, in place" on slide 4

  Scenario: Taking back a broken edit by hand shows the change that waited
    Given Ana broke the YAML of the deck's frontmatter
    When Budi changes the heading of slide 4 to "# Heap sort, in place"
    And Ana takes the broken edit back by hand
    Then Ana's editor shows "# Heap sort, in place" on slide 4, with no note

  Scenario: Undo right after typing restores the text from before
    When Ana types "# Oops" in place of the heading of slide 2
    And Ana undoes at once
    Then Ana's editor holds the deck as it was
    And the live deck is as it was

  Scenario: Undo while a comment is held back removes the comment, not earlier work
    Given Ana wrote "Compare neighbours and swap." on slide 2, and it is in the live deck
    When Ana starts an HTML comment after the heading of slide 1
    And Ana undoes
    Then Ana's editor no longer has the comment and still has "Compare neighbours and swap."
    And the live deck still has "Compare neighbours and swap." on slide 2
    When Ana undoes again
    Then "Compare neighbours and swap." is gone from the live deck and from Ana's editor

  Scenario: Undo right after breaking the YAML removes only the break
    Given Ana wrote "Compare neighbours and swap." on slide 2, and it is in the live deck
    When Ana breaks the YAML of the deck's frontmatter and undoes at once
    Then Ana's editor has the YAML as it was, with no note, and still has "Compare neighbours and swap."
    And the live deck still has "Compare neighbours and swap." on slide 2

  Scenario: Typing that waits when Ana can only view the deck now is dropped, and others' changes still show
    When Ana types "# Sorting, typed" in place of the heading of slide 1
    And Ana becomes a viewer of the deck before the typing is merged
    Then Ana's editor shows the deck again, with the note "Your last change was not saved, because this deck is read only now."
    When Budi changes the heading of slide 3 to "# Quick sort"
    Then Ana's editor shows "# Quick sort" on slide 3
    And the live deck never had Ana's typing

  Scenario: Slides others add or remove come and go without touching the rest
    Given Ana wrote slide 5 with extra blank lines, and Ana's cursor is after its heading
    When Budi deletes slide 2 and adds the slide "# Insertion sort" after slide 4
    Then Ana's editor has "# Insertion sort" and no longer "# Bubble sort"
    And slide 5 keeps Ana's own way of writing it, with the cursor after its heading

  Scenario: Many changes in a row reach the editor about ten times a second at most
    When Budi changes the heading of slide 3 thirty times, one change every 10 ms
    Then Ana's editor shows the last change
    And Ana's editor received far fewer edits than changes, about ten a second at most
