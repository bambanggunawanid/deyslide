Feature: Deck page
  As a person working on a deck
  I want one page with a Design view and a Markdown view of the live deck
  So that I can switch between laying out slides and writing them

  Scenario: A deck opens in the Design view
    Given the blank deck "Graphs" is in this browser
    When I open the deck
    Then the page shows the Design view with the slide preview and "Slide 1 of 1"
    And there is no Markdown editor

  Scenario: Switching to Markdown shows the editor and is remembered
    Given the blank deck "Graphs" is in this browser
    And I open the deck
    When I switch to the Markdown view
    Then the editor holds the deck's Markdown
    And the address says the view is "markdown"
    When I go to the project and open the deck again, without a view in the address
    Then the page shows the Markdown view

  Scenario: The address chooses the view
    Given the blank deck "Graphs" is in this browser, and the Markdown view was chosen last time
    When I open the deck with the view "design" in the address
    Then the page shows the Design view with the slide preview and "Slide 1 of 1"

  Scenario: The slide on show stays the same across views
    Given the demo deck "Sorting" is in this browser
    And I open the deck
    When I press the next slide button
    And I switch to the Markdown view
    Then the page still shows slide 2 of 5
    When I press the next slide button again
    Then the editor cursor jumps to the first line of slide 3

  Scenario: The slide on show stays on its slide when someone adds one above it
    Given Ana is signed in with the demo deck "Sorting" open on slide 3
    When Budi adds a slide after slide 1 in another browser
    Then the page shows slide 4 of 6, still the slide "# Spatial zoom"

  Scenario: Download Markdown saves the live deck
    Given the blank deck "Graphs" is in this browser
    And I open the deck in the Markdown view
    And I change the title to "Changed" in the editor
    When I download the deck as Markdown
    Then the file "Graphs.md" holds the deck with the title "Changed"

  Scenario: People who have the deck open show in the header
    Given Ana is signed in with the blank deck "Graphs" open
    When Budi opens the same deck in another browser
    Then the header shows Budi as "B" in Budi's color, with the full name on hover
    When Budi closes the deck
    Then the header shows nobody else

  Scenario: Others see which view and slide the page shows
    Given Ana is signed in with the demo deck "Sorting" open
    And Budi has the same deck open in another browser
    Then Budi sees Ana in the Design view on slide 1, with nothing selected
    When Ana goes to the next slide and switches to the Markdown view
    Then Budi sees Ana in the Markdown view on slide 2
    When Ana leaves the deck
    Then Budi sees nobody else
