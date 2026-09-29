Feature: The web app's cloud store against the real API
  As the web app
  I want my cloud store and the API to agree on every request
  So that what the pages show is what the server saved

  Background:
    Given the Deyslide API with email sending
    And the web app's cloud store for Ana, who is signed in

  Scenario: Create a project and a demo deck, then read the deck back
    When the store creates the project "Algorithms 101" with the demo deck "Sorting"
    Then the store lists "Algorithms 101" with the deck "Sorting" of 5 slides
    And reading the deck gives 5 slides, the first titled "Deyslide"
    And its Markdown is valid Slidev Markdown with 5 slides

  Scenario: Browser projects move with their ids
    Given a browser store with the project "Algorithms 101" holding the demo deck "Sorting"
    When the store imports the browser's projects
    Then the store lists "Algorithms 101" with the deck "Sorting" of 5 slides
    And the project and the deck keep their browser ids

  Scenario: A signed out request explains itself
    Given Ana signs out in another tab
    When the store tries to create the project "Algorithms 101"
    Then it fails with "You are signed out. Sign in again to keep working."

  Scenario: An unreachable server explains itself
    Given the network is down
    When the store tries to create the project "Algorithms 101"
    Then it fails with "Deyslide is unreachable. Check your connection and try again."
