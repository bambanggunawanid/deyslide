Feature: Projects and decks saved to an account
  As a signed in person
  I want my projects and decks stored on the server
  So that they open on any device

  Background:
    Given the Deyslide API with email sending
    And Ana is signed in

  Scenario: Create a project
    When Ana creates the project "Algorithms 101"
    Then her projects are "Algorithms 101" with 0 decks

  Scenario: Add a deck and read it back
    Given Ana has the project "Algorithms 101"
    When she adds the deck "Sorting" made from the demo template
    Then the project lists the deck "Sorting" with 5 slides
    And downloading the deck gives the same 5 slides

  Scenario: Rename and delete
    Given Ana has the project "Algorithms 101" with the deck "Sorting"
    When she renames the project to "Algorithms 102"
    And she renames the deck to "Sorting basics"
    Then her projects are "Algorithms 102" with 1 deck
    When she deletes the deck
    And she deletes the project
    Then she has no projects

  Scenario: A deck must be a valid deck
    Given Ana has the project "Algorithms 101"
    When she adds a deck whose content is not a Yjs document
    Then it is refused with "The deck content is not a valid deck"

  Scenario: Other people cannot see or change it
    Given Ana has the project "Algorithms 101" with the deck "Sorting"
    And Budi is signed in on another browser
    Then Budi has no projects
    And Budi cannot rename, delete, download or save Ana's project and deck

  Scenario: Guests cannot use the API
    Given a guest who is not signed in
    Then listing projects is refused as not signed in

  Scenario: Move browser projects into the account
    Given a browser with the project "Algorithms 101" holding the demo deck "Sorting"
    When Ana imports it into her account
    Then her projects are "Algorithms 101" with 1 deck
    And the imported deck has 5 slides

  Scenario: Importing twice does not duplicate
    Given a browser with the project "Algorithms 101" holding the demo deck "Sorting"
    When Ana imports it into her account
    And Ana imports it into her account again
    Then her projects are "Algorithms 101" with 1 deck

  Scenario: An import cannot take over someone else's project
    Given Budi imported a browser project with the id "shared-id"
    When Ana imports a browser project with the same id "shared-id" named "Mine"
    Then Ana's project "Mine" gets a new id
    And Budi's project keeps the id "shared-id"

  Scenario: Save new content for a deck
    Given Ana has the project "Algorithms 101" with the deck "Sorting"
    When she saves the deck with a blank deck titled "Rewritten"
    Then downloading the deck gives 1 slide
    And the project lists the deck "Sorting" with 1 slide

  Scenario: Saved content must be a valid deck
    Given Ana has the project "Algorithms 101" with the deck "Sorting"
    When she saves the deck with content that is not a Yjs document
    Then it is refused with "The deck content is not a valid deck"
    And the project lists the deck "Sorting" with 5 slides
