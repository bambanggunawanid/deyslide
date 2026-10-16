Feature: Live editing on the server
  As a person who works on a deck with others
  I want every change to go through one live deck that everyone has open
  So that nobody overwrites anyone, and Claude Code's edits show up while we work

  Background:
    Given the Deyslide API on a port with live editing
    And Ana owns the deck "Sorting" with the slides "Sorting", "Bubble sort" and "Merge sort"

  Scenario: Two editors see each other's change
    Given Ana shared the project with Budi as an editor
    And Ana and Budi have the deck open live
    When Ana changes slide 2 to "# Insertion sort"
    Then Budi sees "# Insertion sort" on slide 2
    When Budi changes slide 3 to "# Quick sort"
    Then Ana sees "# Quick sort" on slide 3

  Scenario: A viewer follows along and shows up in presence, but changes nothing
    Given Ana shared the project with Budi as a viewer
    And Ana and Budi have the deck open live
    Then Budi's connection is read only
    And Ana and Budi see each other in presence
    When Budi changes slide 2 to "# Mine"
    Then the live deck still has "# Bubble sort" on slide 2
    When Ana changes slide 3 to "# Quick sort"
    Then Budi sees "# Quick sort" on slide 3

  Scenario: A viewer cannot pass for someone else in presence
    Given Ana shared the project with Budi as a viewer
    And Ana and Budi have the deck open live
    When Budi's page claims to be Ana in presence
    Then Ana sees Budi's presence with Budi's account, name and color

  Scenario: A page shows one presence, its own, and cannot take over anyone else's
    Given Ana shared the project with Budi as a viewer and Citra as an editor
    And Ana, Budi and Citra have the deck open live
    When Budi's page sends presence for 50 more clients and for Citra's client
    And Budi's page says Citra's client left
    Then Ana sees three people in presence: Ana, Budi and Citra
    When Citra closes the deck and Budi's page claims Citra's client meanwhile
    And Citra's page comes back with the same client
    Then Ana sees Citra's presence as Citra's

  Scenario: Strangers are refused
    Given Dewi has an account
    When Dewi opens the deck live
    Then Dewi is refused
    And Ana opening the deck from a page on another site is refused the same way
    And Ana opening a deck that does not exist is refused the same way

  Scenario: The apps join with a token for the API
    Given Ana's app signed in and holds a token for the API
    When the app opens the deck live with its token
    Then the app gets the deck's 3 slides
    But a token Claude Code got for the MCP server is refused

  Scenario: The deck is saved and loads again after everyone leaves
    Given Ana has the deck open live
    When Ana changes slide 2 to "# Insertion sort"
    And Ana closes the deck
    Then the live deck is unloaded and the saved deck has "# Insertion sort" on slide 2
    When Ana opens the deck live again
    Then Ana sees "# Insertion sort" on slide 2

  Scenario: A stopping server saves every open deck first
    Given Ana has the deck open live
    When Ana changes slide 2 to "# Insertion sort"
    And the server stops
    Then every live deck was saved and unloaded, and the saved deck has "# Insertion sort" on slide 2

  Scenario: A save that fails is tried again, and nothing is lost meanwhile
    Given Ana has the deck open live
    And the next save fails
    When Ana changes slide 2 to "# Insertion sort"
    And Ana closes the deck once that save failed
    Then soon the saved deck has "# Insertion sort" on slide 2, and the live deck is unloaded

  Scenario: Claude Code is told when its change is in the deck but not saved yet
    Given Claude Code is connected as Ana and has read the deck
    And the next save fails
    When Claude Code replaces slide 3 with "# Quick sort"
    Then Claude Code is told "The change is in the deck, but the server could not save it yet. It keeps trying. Do not send the change again."
    And soon the saved deck has "# Quick sort" on slide 3

  Scenario: A stopping server names the decks it could not save
    Given Ana has the deck open live
    And every save fails
    When Ana changes slide 2 to "# Insertion sort"
    And the server stops
    Then the server names the deck as not saved

  Scenario: Claude Code's edit reaches open pages and keeps an edit made a second earlier
    Given Ana shared the project with Budi as an editor
    And Ana and Budi have the deck open live
    And Claude Code is connected as Ana and has read the deck
    When Budi changes slide 2 to "# Insertion sort"
    And a second later Claude Code replaces slide 3 with "# Quick sort"
    Then Ana and Budi see "# Quick sort" on slide 3
    And Ana and Budi still see "# Insertion sort" on slide 2

  Scenario: A whole deck from Claude Code keeps what people changed since its read
    Given Ana shared the project with Budi as an editor
    And Ana and Budi have the deck open live
    And Claude Code is connected as Ana and has read the deck
    When Budi changes slide 2 to "# Insertion sort"
    And Claude Code writes the deck it read with slide 3 changed to "# Quick sort"
    Then Ana and Budi see "# Quick sort" on slide 3
    And Ana and Budi still see "# Insertion sort" on slide 2
    And Claude Code is told its Markdown was merged, and the deck now has "Insertion sort" as slide 2

  Scenario: Slide numbers in Claude Code's edits mean the slides it read
    Given Ana shared the project with Budi as an editor
    And Budi has the deck open live
    And Claude Code is connected as Ana and has read the deck
    When Budi adds "# Insertion sort" as slide 2
    And Claude Code replaces slide 3 with "# Quick sort"
    Then Budi sees the slides "Sorting", "Insertion sort", "Bubble sort" and "Quick sort"
    And Claude Code is told the deck now has those slides

  Scenario: Each Claude Code session's write keeps what people changed since that session read
    Given Ana shared the project with Budi as an editor
    And Budi has the deck open live
    And Claude Code is connected as Ana and has read the deck
    When Budi changes slide 2 to "# Insertion sort"
    And another Claude Code session of Ana's reads the deck
    And the first session writes the deck it read with slide 3 changed to "# Quick sort"
    Then Budi sees "# Quick sort" on slide 3
    And Budi still sees "# Insertion sort" on slide 2

  Scenario: Edits Claude Code sends at the same time are not made again by its next write
    Given Claude Code is connected as Ana and has read the deck
    When Claude Code replaces slide 3 with "# Quick sort" while it adds "# Heap sort" as slide 4
    And Claude Code writes the deck with both changes
    Then the saved deck has the slides "Sorting", "Bubble sort", "Quick sort" and "Heap sort"

  Scenario: A whole deck from Claude Code that never read it says it replaced the deck
    Given Claude Code is connected as Ana
    When Claude Code writes a deck with the slides "Sorting" and "Heap sort" without reading it first
    Then Claude Code is told its Markdown replaced the whole deck

  Scenario: The reads the server keeps for one person do not push out another person's
    Given the server keeps at most 2 reads for each person and 3 in all
    When Ana's Claude Code reads one deck and Budi's reads five
    Then Ana's read is still kept
    And of Budi's reads only the last two are kept

  Scenario: A change from Claude Code that would make the deck too big is refused, and people keep their work
    Given Ana shared the project with Budi as an editor
    And Budi has the deck open live
    And Claude Code is connected as Ana and has read the deck
    When Budi writes 120000 characters on slide 2
    And Claude Code writes the deck it read with a slide of 90000 characters added
    Then Claude Code is told "Nothing was saved. This deck is too big to save. Remove some content."
    And Budi is still connected and never saw that slide
    When Budi closes the deck
    Then the saved deck has Budi's 120000 characters on slide 2

  Scenario: The server reads a deck as it is live, before it is saved
    Given Ana has the deck open live
    And Claude Code is connected as Ana
    When Ana changes slide 2 to "# Insertion sort"
    Then the saved deck still has "# Bubble sort" on slide 2
    But the deck's state from the API has "# Insertion sort" on slide 2
    And Claude Code reads "# Insertion sort" on slide 2

  Scenario: Claude Code writing while a page connects loses nothing
    Given Claude Code is connected as Ana
    When Ana's page connects while Claude Code writes a deck with the slides "Sorting" and "Heap sort"
    Then Ana's page shows the slides "Sorting" and "Heap sort"
    When Ana closes the deck
    Then the saved deck has the slides "Sorting" and "Heap sort"

  Scenario: Someone removed while their page is still joining is let go too
    Given Ana shared the project with Budi as an editor
    And the deck takes a moment to load
    When Budi opens the deck live
    And Ana removes Budi from the project while the deck loads
    Then Budi's connection closes because access changed, and joining again is refused

  Scenario: A removed person's client that ignores the closing socket changes nothing
    Given Ana shared the project with Budi as an editor
    And Ana and Budi have the deck open live
    And Budi's client stops reading from its socket
    When Ana removes Budi from the project
    And Budi's client changes slide 2 to "# Still here"
    Then the live deck still has "# Bubble sort" on slide 2

  Scenario: Removing someone closes their connection while the others keep editing
    Given Ana shared the project with Budi and Citra as editors
    And Ana, Budi and Citra have the deck open live
    When Ana removes Budi from the project
    Then Budi's connection closes because access changed, and joining again is refused
    And Ana and Citra are still connected
    When Citra changes slide 2 to "# Insertion sort"
    Then Ana sees "# Insertion sort" on slide 2

  Scenario: Deleting the deck lets everyone go
    Given Ana shared the project with Budi as an editor
    And Ana and Budi have the deck open live
    When Ana deletes the deck
    Then Ana's and Budi's connections close because access changed, and joining again is refused

  Scenario: Deleting the project lets everyone go
    Given Ana shared the project with Budi as an editor
    And Ana and Budi have the deck open live
    When Ana deletes the project
    Then Ana's and Budi's connections close because access changed, and joining again is refused

  Scenario: Someone who leaves the project is let go
    Given Ana shared the project with Budi as an editor
    And Ana and Budi have the deck open live
    When Budi leaves the project
    Then Budi's connection closes because access changed, and joining again is refused
    And Ana is still connected

  Scenario: Signing out ends the live connection
    Given Ana has the deck open live
    When Ana signs out
    Then Ana's connection closes because access changed, and joining again is refused

  Scenario: Pages that only listen stay connected, and a client that stops answering is let go
    Given connections that send nothing for a second are let go
    And Ana and a client that does not answer pings have the deck open live
    When neither sends anything for two seconds
    Then Ana is still connected
    But the client that does not answer pings was let go

  Scenario: A new role applies at once
    Given Ana shared the project with Budi as an editor
    And Budi has the deck open live
    When Ana makes Budi a viewer
    Then Budi's connection closes because access changed, and joins again read only

  Scenario: Deleting every slide at the same time leaves one empty slide
    Given Ana shared the project with Budi as an editor
    And Ana and Budi have the deck open live
    When Ana deletes slides 1 and 2 while Budi deletes slide 3
    Then Ana and Budi soon see one empty slide
    When Ana and Budi close the deck
    Then the saved deck has one empty slide

  Scenario: A page that clears the whole deck gets it back as last saved
    Given Ana shared the project with Budi as an editor
    And Ana and Budi have the deck open live
    When Budi's page clears the whole deck
    Then Ana and Budi soon see the slides "Sorting", "Bubble sort" and "Merge sort" again
    When Ana and Budi close the deck
    Then the saved deck has the slides "Sorting", "Bubble sort" and "Merge sort"

  Scenario: A deck past the content limit is not saved, and everyone is told
    Given Ana shared the project with Budi as an editor
    And Ana and Budi have the deck open live
    When Ana adds a slide with 210000 characters of text
    Then Ana's and Budi's connections close with "This deck is too big to save. Remove some content."
    And the saved deck still has the slides "Sorting", "Bubble sort" and "Merge sort"

  Scenario: A deck past 500 slides is not saved either
    Given Ana has the deck open live
    When Ana adds slides until the deck has 501
    Then Ana's connection closes with "This deck is too big to save. Remove some content."
    And the saved deck still has the slides "Sorting", "Bubble sort" and "Merge sort"

  Scenario: A page whose changes would take the deck's data past 5 MB is let go, and the others keep editing
    Given Ana shared the project with Budi as an editor
    And Ana and Budi have the deck open live
    When Budi's page stores 1 MB of data that no slide shows, 6 times
    Then Budi's connection closes with "This deck is too big to save. Remove some content."
    And the live deck holds no more than 5 MB
    When Ana changes slide 2 to "# Insertion sort"
    And Ana closes the deck
    Then the saved deck has the slides "Sorting", "Insertion sort" and "Merge sort"
    And it holds no more than 5 MB

  Scenario: A change too big for one message never reaches the deck
    Given Ana shared the project with Budi as an editor
    And Ana and Budi have the deck open live
    When Budi's page stores 3 MB of data that no slide shows in one change
    Then Budi's connection closes with "This deck is too big to save. Remove some content."
    And the live deck does not hold that data
    And Ana's connection stays open

  Scenario: A page that writes anything but the deck is let go
    Given Ana shared the project with Budi as an editor
    And Ana and Budi have the deck open live
    When Budi's page writes to a part of the document outside the deck
    Then Budi's connection closes with "This change is not part of the deck."
    And the live deck holds nothing outside the deck
    And Ana's connection stays open

  Scenario: Presence passes on only what pages show, and only a little of it
    Given Ana shared the project with Budi as a viewer
    And Ana and Budi have the deck open live
    When Budi's page adds a field of its own to its presence
    Then Ana sees Budi's presence without that field
    When Budi's page goes to slide "second" with 100 KB in its selection
    And then goes to slide "third" with nothing selected
    Then Ana sees Budi on slide "third", and never saw slide "second" or that selection

  Scenario: Decks too big to edit live cannot be added
    When Ana adds a deck with 501 slides
    Then it is refused with "This deck is too big to save. Remove some content."
    When Ana imports a project with a deck of 210000 characters
    Then that is refused the same way

  Scenario: Pages that save whole decks wait until nobody has the deck open live
    Given Ana has the deck open live
    When an older page saves a whole deck for Ana
    Then it is refused with "This deck is open for live editing. Reload the page to keep editing."
    When Ana closes the deck
    And an older page saves a whole deck for Ana
    Then the saved deck has the older page's content
