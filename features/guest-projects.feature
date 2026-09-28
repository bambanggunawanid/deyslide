Feature: Guest projects in the browser
  As a visitor without an account
  I want to create projects and decks that stay in my browser
  So that I can try Deyslide before signing up

  Background:
    Given a visitor with an empty browser

  Scenario: A visitor creates a project
    When they create the project "Algorithms 101"
    Then their projects are "Algorithms 101" with 0 decks

  Scenario: A visitor starts a deck from the demo template
    Given the project "Algorithms 101"
    When they add the deck "Sorting" from the demo template
    Then the project lists 1 deck named "Sorting" with 5 slides
    And the deck's Markdown is valid Slidev Markdown with 5 slides
    And the deck's first slide keeps the demo title "Deyslide"

  Scenario: A visitor starts a blank deck
    Given the project "Algorithms 101"
    When they add the deck "Graphs" from the blank template
    Then the deck has 1 slide with the heading "# Graphs"

  Scenario: Guest work survives a reload
    Given the project "Algorithms 101" with the demo deck "Sorting"
    When the page is reloaded
    Then their projects are "Algorithms 101" with 1 deck
    And the deck "Sorting" still has 5 slides

  Scenario: Rename and delete
    Given the project "Algorithms 101" with the demo deck "Sorting"
    When they rename the project to "Algorithms 102"
    And they delete the deck "Sorting"
    And the page is reloaded
    Then their projects are "Algorithms 102" with 0 decks
    And the deck content is gone from the browser

  Scenario Outline: Names are checked
    When they try to create a project named "<name>"
    Then it is refused with "<message>"

    Examples:
      | name | message                     |
      |      | A project needs a name      |
      | ···  | A project needs a name      |
