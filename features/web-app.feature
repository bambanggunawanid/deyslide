Feature: Web app pages
  As a visitor without an account
  I want a home page for my projects and a page for each deck
  So that I can organize my talks the way I do in Figma

  Background:
    Given the web app opened at "/"

  Scenario: A first visit shows an empty home page
    Then the home page says there are no projects yet
    And the guest banner says the work is saved in this browser only

  Scenario: Create a project from the home page
    When they create the project "Algorithms 101" from the home page
    Then the project page for "Algorithms 101" is open
    And it says the project has no decks

  Scenario: Start a deck from the demo template
    Given the project "Algorithms 101" is open
    When they add the deck "Sorting" from the demo template
    Then the deck page for "Sorting" is open
    And the editor shows slide 1 of 5, the cover titled "Deyslide"

  Scenario: Download a deck as Markdown
    Given the deck "Sorting" from the demo template is open
    When they download the deck as Markdown
    Then the browser saves the file "Sorting.md"

  Scenario: A project name is required
    When they try to create a project with an empty name
    Then the dialog stays open with the error "A project needs a name"

  Scenario: A link to a project from another browser
    When they open "/p/unknown-project"
    Then the page says the project is not in this browser
