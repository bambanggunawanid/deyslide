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
    When Ana opens Deyslide while offline again
    Then the page shows no account and lists no account projects

  Scenario: A deck never opened on this device says it needs a connection
    Given Ana used Deyslide online and opened the deck "Graphs" of the project "Talks"
    And the project "Talks" also has the deck "Charts", never opened on this device
    When Ana opens Deyslide while offline
    And Ana opens the deck "Charts" from the project page
    Then the deck page says "This deck has no copy on this device yet, so it opens once you are back online."

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

  Scenario: Access removed while the deck is open deletes its copy
    Given Budi shared the deck "Graphs" with Ana as an editor, and Ana opened it once while online
    And Ana has "Graphs" open online
    When Budi removes Ana from the deck
    Then the session says "Not saved: You no longer have access to this deck. Its copy on this device was deleted." and is read only
    And this device keeps no copy of "Graphs"

  Scenario: A sign in that ended keeps the copy and the changes made offline
    Given Ana opened the deck "Graphs" once while online
    And Ana changed slide 2 to "## Offline idea" while offline
    And Ana's sign in ended on the server meanwhile
    When Ana is online again
    Then the session says "Not saved: Your sign in ended. Sign in again to save your changes. They stay on this device until then." and is read only
    And this device still keeps "Graphs" with the change waiting for the server
    When Ana signs in again and opens Deyslide
    Then the account's deck has "## Offline idea" on slide 2

  Scenario: A server that cannot check access just then keeps the copy and syncs later
    Given Ana opened the deck "Graphs" once while online
    And Ana changed slide 2 to "## Offline idea" while offline
    And the server cannot check Ana's access the next two times she joins
    When Ana is online again
    Then the account's deck has "## Offline idea" on slide 2
    And the header says "Saved"
    And this device still keeps "Graphs"

  Scenario: Changes the server turns down are kept until Ana sees why
    Given Budi shared the deck "Graphs" with Ana as an editor, and Ana opened it once while online
    And Ana changed slide 2 to "## On the plane" while offline, then closed Deyslide
    And Budi made Ana a viewer of "Graphs" meanwhile
    When Ana opens Deyslide again while online, without opening the deck
    Then the account's deck still has "## Nodes" on slide 2
    And this device still keeps "Graphs", no longer waiting to send it
    When Ana opens "Graphs" from this device
    Then the session says "Not saved: You can only view this deck now. Reload the page to see it as it is. Its copy on this device was deleted. Download the Markdown to keep your changes."
    And the open deck still has "## On the plane" on slide 2
    And this device keeps no copy of "Graphs"

  Scenario: A viewer's kept deck opens offline read only
    Given Budi shared the deck "Graphs" with Ana as a viewer, and Ana opened it once while online
    And Ana is offline
    When Ana opens "Graphs" from this device
    Then the session holds the deck, is read only and says "Offline. Changes sync when you are back online."

  Scenario Outline: Closing Deyslide warns about changes not sent yet, unless the copy outlasts the page
    Given this device keeps deck copies in <storage>
    And Ana opened the deck "Graphs" while online, changed slide 2 while offline and left the deck
    When Deyslide closes
    Then it warns about <warned>

    Examples:
      | storage                           | warned   |
      | IndexedDB                         | no deck  |
      | memory only                       | "Graphs" |
      | an IndexedDB that refuses to open | "Graphs" |

  Scenario: Signing out clears the device
    Given Ana used Deyslide online and opened the deck "Graphs" of the project "Talks"
    When Ana signs out
    Then no account deck, project list or remembered account is left on the device
    And opening Deyslide offline afterwards shows no account projects
