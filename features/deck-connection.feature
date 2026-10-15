Feature: Live connection of an account deck
  As a person with an account deck open in the browser
  I want the page to say what the server does with my changes
  So that I know when they are saved, and when they are not

  Background:
    Given the Deyslide API on a port with live editing, and Ana's deck "Sorting" of three slides

  Scenario: A page joins the deck live, sends its changes and says "Saved"
    When Ana's page connects to the deck
    Then the connection holds the deck, can be changed and says "Saved"
    When the page changes slide 2 to "# Insertion sort"
    Then the server's live deck has "# Insertion sort" on slide 2, and the connection says "Saved"

  Scenario: A viewer's connection is read only
    Given Ana shared the project with Budi as a viewer
    When Budi's page connects to the deck
    Then Budi's connection holds the deck, is read only and says "Saved"

  Scenario: A change a viewer's page sends anyway is turned down, and the page says so
    Given Ana shared the project with Budi as a viewer
    And Budi's page is connected to the deck
    When Budi's page changes slide 2 to "# Insertion sort" anyway
    Then Budi's connection says "You can only view this deck now. Reload the page to see it as it is." and is read only
    And the server's live deck still has "# Bubble sort" on slide 2

  Scenario: A page that cannot get a token is offline, not refused
    When Ana's page connects to the deck, and its first token cannot be fetched
    Then the connection says "Offline. Changes sync when you are back online."
    And a moment later it holds the deck and says "Saved", after asking for a token again

  Scenario: Someone removed from the project is told they no longer have access
    Given Ana shared the project with Budi as an editor
    And Budi's page is connected to the deck
    When Ana removes Budi from the project
    Then Budi's connection says "You no longer have access to this deck." and is read only

  Scenario: Someone whose role changes joins again with the new role
    Given Ana shared the project with Budi as an editor
    And Budi's page is connected to the deck
    When Ana makes Budi a viewer
    Then Budi's connection joins again with a fresh token, read only, and says "Saved"

  Scenario: A deck too big to save says so
    Given Ana's page is connected to the deck
    When the page adds a slide with 210000 characters of text
    Then the connection says "This deck is too big to save. Remove some content." and is read only
