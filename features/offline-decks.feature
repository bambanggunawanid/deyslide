Feature: Account decks offline
  As a signed in person on a train, a plane or a weak signal
  I want the decks I opened before to open and change without a connection
  So that I keep working, and my changes reach my account once I am back online

  Scenario: Edit a deck kept on this device while offline
    Given Ana opened the deck "Graphs" once while online
    And Ana is offline
    When Ana opens "Graphs" and changes slide 2 to "## Offline idea"
    Then the change shows at once and the header says "Offline. Changes sync when you are back online."
    When Ana is online again
    Then the account's deck has "## Offline idea" on slide 2
    And the header says "Saved"

  Scenario: Offline edits merge with an edit made online meanwhile
    Given Ana opened the deck "Graphs" once while online
    And Ana changed slide 2 to "## From Ana" while offline
    And Budi changed slide 3 to "## From Budi" online meanwhile
    When Ana is online again
    Then Ana's deck has "## From Ana" on slide 2 and "## From Budi" on slide 3
    And so does Budi's

  Scenario: Changes kept on this device reach the account after the page closed
    Given Ana opened the deck "Graphs" once while online
    And Ana changed slide 2 to "## On the plane" while offline, then closed Deyslide
    When Ana opens Deyslide again while online, without opening the deck
    Then the account's deck has "## On the plane" on slide 2

  Scenario: A deck never opened on this device stays read only offline
    Given Ana has the deck "Charts" in Ana's account and never opened it on this device
    And Ana is offline
    When Ana opens "Charts"
    Then the session holds no deck, is read only and says "Offline. Changes sync when you are back online."
    When Ana is online again
    Then the session holds the deck and can be changed

  Scenario: Home lists the account's projects offline
    Given Ana used Deyslide online and opened the deck "Graphs" of the project "Talks"
    And the project "Talks" also has the deck "Charts", never opened on this device
    When Ana opens Deyslide while offline
    Then the account menu shows Ana
    And Home lists the project "Talks" with the mark "Offline"
    And the project page says "Graphs" is "On this device" and "Charts" "Needs a connection"
    When the server answers again and lists a new project "Lectures"
    Then Home lists "Lectures" and "Talks" without the mark

  Scenario: Home says so when the connection drops while it is open
    Given Ana used Deyslide online and opened the deck "Graphs" of the project "Talks"
    When the browser says the connection dropped
    Then Home lists the project "Talks" with the mark "Offline"
    When the browser says the connection is back and the server answers
    Then Home lists "Talks" without the mark

  Scenario: The website follows the server once it answers again
    Given Ana used Deyslide online and opened the deck "Graphs" of the project "Talks"
    And Ana's sign in ended on the server meanwhile
    When Ana opens Deyslide while offline
    Then the account menu shows Ana
    When the browser says the connection is back and the server answers
    Then the page is signed out and lists no account projects
    And the device still keeps Ana's decks for the next sign in

  Scenario: The deck page opens a kept deck offline
    Given Ana used Deyslide online and opened the deck "Graphs" of the project "Talks"
    When Ana opens Deyslide while offline
    And Ana opens the deck "Graphs" from the project page
    Then the deck page shows the deck and its header says "Offline. Changes sync when you are back online."

  Scenario: A deck the server refuses loses its copy and says why
    Given Ana opened the deck "Graphs" once while online
    And the deck "Graphs" was deleted from the account in another browser
    And Ana is offline
    When Ana opens "Graphs" from this device
    Then the deck opens from its copy and can be changed
    When Ana is online again
    Then the session says "Not saved: You no longer have access to this deck. Its copy on this device was deleted." and is read only
    And this device keeps no copy of "Graphs"
    And the project no longer lists "Graphs"

  Scenario: Signing out clears the device
    Given Ana used Deyslide online and opened the deck "Graphs" of the project "Talks"
    When Ana signs out
    Then no account deck, project list or remembered account is left on the device
    And opening Deyslide offline afterwards shows no account projects
