Feature: Deck sessions
  As a person with a deck open
  I want the page to hold one live copy of the deck that saves as I go
  So that every view shows the same deck and nothing anyone does is lost

  Scenario: A deck in the browser opens ready and keeps every change
    Given a guest has the blank deck "Graphs" in this browser
    When they open the deck
    Then the session holds the deck, can be changed and says "Saved"
    When they change the title to "# Changed" through the session
    Then the browser's copy of the deck has "# Changed" while the deck is still open
    And a moment later the project lists the deck as changed

  Scenario: Everything that reads a browser deck shares the open document
    Given a guest has the blank deck "Graphs" in this browser
    And they open the deck twice
    Then both sessions share one document
    When the store saves new content for the deck
    Then both sessions have it at once, and the title slide keeps its id

  Scenario: An account deck is read only until it first syncs
    Given Ana is signed in with the blank deck "Graphs" in Ana's account
    And Ana's connection is down
    When Ana opens the deck
    Then the session is read only, holds no deck yet and says "Offline. Changes sync when you are back online."
    And a change through the session does nothing
    When Ana's connection comes back
    Then the session holds the deck, can be changed and says "Saved"
    And it asked for a token to connect

  Scenario: Changes made offline after the first sync are kept and go out later
    Given Ana is signed in with the blank deck "Graphs" in Ana's account
    And Ana has the deck open
    When Ana's connection drops
    And Ana changes the title to "# Offline" through the session
    Then the session says "Offline. Changes sync when you are back online." and can still be changed
    When Ana's connection comes back
    Then the account's deck has "# Offline"

  Scenario: Changes made offline still reach the account after the deck is closed
    Given Ana is signed in with the blank deck "Graphs" in Ana's account
    And Ana has the deck open
    When Ana's connection drops
    And Ana changes the title to "# On the train" through the session and closes the deck
    And Ana's connection comes back
    Then the account's deck has "# On the train"
    And the store lets go of the deck once the server has the change

  Scenario: Opening a deck again while its offline changes wait shows them
    Given Ana is signed in with the blank deck "Graphs" in Ana's account
    And Ana has the deck open
    When Ana's connection drops
    And Ana changes the title to "# On the train" through the session and closes the deck
    And Ana opens the deck again while still offline
    Then the session has "# On the train" and can be changed

  Scenario: Two people see each other's changes at once
    Given Ana is signed in with the blank deck "Graphs" in Ana's account
    And Ana has the deck open
    And Budi has the same deck open in another browser
    When Ana changes the title to "# From Ana" through the session
    Then Budi's copy has "# From Ana" at once

  Scenario: A viewer follows along but changes nothing
    Given Budi shared the deck "Sorting" with Ana as a viewer
    When Ana opens the deck
    Then Ana's session holds the deck and is read only
    When Budi changes the deck to "# Live"
    Then Ana's copy has "# Live"

  Scenario: The store does not save through a deck open read only
    Given Budi shared the deck "Sorting" with Ana as a viewer
    And Ana has the shared deck open
    When the store saves new content for the shared deck
    Then the save fails with "This deck can only be viewed here right now, so the change was not saved."
    And Ana's copy still has "# Sorting"

  Scenario: Losing access stops editing
    Given Ana is signed in with the blank deck "Graphs" in Ana's account
    And Ana has the deck open
    When the server stops letting Ana into the deck
    Then the session says "Not saved: You no longer have access to this deck." and is read only

  Scenario: People see who else has the deck open
    Given Ana is signed in with the blank deck "Graphs" in Ana's account
    And Ana has the deck open
    And Budi has the same deck open in another browser
    Then Ana's session lists Budi as here, and Budi's lists Ana
    When Budi closes the deck
    Then Ana's session lists nobody else

  Scenario: The store reads and saves an open account deck through its live copy
    Given Ana is signed in with the blank deck "Graphs" in Ana's account
    And Ana has the deck open
    When the store saves new content for the deck
    Then the session has it at once, and so does the server
    And reading the deck from the store gives the open session's content

  Scenario: Changes grouped together undo in one step, and redo
    Given a guest has the blank deck "Graphs" in this browser
    And they open the deck
    When they change the title twice in one group
    And they undo
    Then the title is back to "# Graphs"
    When they redo
    Then the title is the second change again

  Scenario: Undo skips the assistant's changes
    Given a guest has the blank deck "Graphs" in this browser
    And they open the deck
    When they change the title to "# Mine" through the session
    And the assistant adds a slide
    And they undo
    Then the title is back to "# Graphs" and the assistant's slide is still there
