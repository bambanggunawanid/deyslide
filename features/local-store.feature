Feature: Decks saved as files on the device
  As a person who uses the Deyslide app
  I want my decks kept as Markdown files that the app and Claude Code both edit
  So that neither of us loses work, and Claude Code can see the slides it makes

  Scenario: The library folder's projects and decks are listed
    Given the library holds the project "Talks" with the deck "Sorting" of 3 slides
    When the app lists the library
    Then the store lists "Talks" with the deck "Sorting" of 3 slides
    And the project and deck ids start with "local-"
    When Claude Code adds the deck "Graphs" to "Talks" on disk
    Then the store lists "Talks" with the decks "Graphs" and "Sorting" without being asked

  Scenario: Opening a deck reads its file and writes nothing
    Given the library holds the project "Talks" with the deck "Sorting" of 3 slides, written with extra blank lines
    When the deck "Sorting" is opened
    Then the session is ready and says "Saved"
    And it shows the 3 slides of the file
    And after a moment the app has written nothing

  Scenario: A change in the app is written to the file a moment later
    Given the deck "Sorting" of 3 slides is open
    When the person changes the title of slide 2 to "Merge sort"
    Then the session says "Saving..."
    And a moment later the file shows "# Merge sort" on slide 2
    And the app wrote it over the text it had read
    And the session says "Saved"

  Scenario: A change undone before the write writes nothing
    Given the deck "Sorting" of 3 slides is open
    When the person changes the title of slide 2 to "Merge sort" and undoes it at once
    Then after a moment the app has written nothing
    And the session says "Saved"

  Scenario: A file change that lands between an edit and its write keeps both
    Given the deck "Sorting" of 3 slides is open
    And the library holds back its reports of changes
    When the person changes the title of slide 1 to "Sorting algorithms"
    And Claude Code changes slide 3 on disk to "# Heap sort" before the app writes
    Then the app's first write is refused, because the file changed
    And the file then shows "# Sorting algorithms" on slide 1 and "# Heap sort" on slide 3
    And the open deck shows both changes
    When the library reports its changes
    Then after a moment the app has written nothing more

  Scenario: A slide moved in the app and on disk at once is written once
    Given the deck "Sorting" of 3 slides is open
    When the person moves slide 3 up to slide 2
    And Claude Code makes the same move on disk before the app writes
    Then the file then holds "# Sorting", "# Insertion sort" and "# Bubble sort", each once
    And the open deck holds them each once too

  Scenario: A change Claude Code makes on disk shows up in the open deck
    Given the deck "Sorting" of 3 slides is open
    When Claude Code changes slide 2 on disk to "# Quick sort"
    Then the open deck shows "# Quick sort" on slide 2 without being opened again
    And after a moment the app has written nothing

  Scenario: A file on disk that has an error is never overwritten
    Given the deck "Sorting" of 3 slides is open
    When Claude Code writes the deck's file with frontmatter that is not valid YAML
    Then the session says "Not saved: The file on disk has an error: The frontmatter is not valid YAML." and where on slide 1
    When the person changes the title of slide 2 to "Merge sort"
    Then after a moment the app has written nothing
    And the file still holds the text with the error
    When Claude Code fixes the file on disk, with "# Heap sort" on slide 3
    Then the session says "Saved"
    And the file shows "# Merge sort" on slide 2 and "# Heap sort" on slide 3

  Scenario: A change made while the file on disk has an error is written once it is fixed, even after leaving the deck
    Given the deck page of "Sorting" in "Talks" is open in the app
    And Claude Code writes the deck's file with frontmatter that is not valid YAML
    When the person changes the title of slide 2 to "Merge sort" in the Markdown view
    And they go back to the project
    Then the file still holds the text with the error
    When Claude Code fixes the file on disk, with "# Heap sort" on slide 3
    Then the file shows "# Merge sort" on slide 2 and "# Heap sort" on slide 3
    And the deck "Sorting" opens again with both changes

  Scenario: A write that fails is tried again on its own
    Given the deck "Sorting" of 3 slides is open
    And the next 2 writes to the file fail with "The disk is full."
    When the person changes the title of slide 2 to "Merge sort"
    Then the session said "Not saved: The disk is full."
    And a moment later, with nothing else changed, the file shows "# Merge sort" on slide 2
    And the session says "Saved"

  Scenario: A change is written once the file stops changing, however often it changed before
    Given the deck "Sorting" of 3 slides is open
    And Claude Code changes slide 3 on disk just before each of the app's next 5 writes
    When the person changes the title of slide 1 to "Sorting algorithms"
    Then a moment later, with nothing else changed, the file shows "# Sorting algorithms" on slide 1 and "# Heap sort 5" on slide 3
    And the session says "Saved"

  Scenario: A deck file with an error opens once the file is fixed
    Given the library holds the project "Talks" with the deck "Sorting" whose frontmatter is not valid YAML
    When the deck "Sorting" is opened
    Then the session is not ready and says "Not saved: The file on disk has an error: The frontmatter is not valid YAML." and where on slide 1
    When Claude Code fixes the file on disk, with "# Heap sort" on slide 3
    Then the session is ready and says "Saved"
    And after a moment the app has written nothing

  Scenario: A deck renamed on disk says so on its page
    Given the deck page of "Sorting" in "Talks" is open in the app
    When the file "Sorting.md" is renamed to "Sorting v2.md" on disk
    Then the page says "Not saved: This deck was moved or renamed on disk."
    And the deck can no longer be edited on that page
    And the store lists "Talks" with the decks "Sorting v2" and "Sorting" while the page stays open
    When they go back to the project
    Then the store lists "Talks" with the deck "Sorting v2" of 3 slides

  Scenario: A change made just before the deck was renamed on disk stays in the app until the deck is deleted
    Given the deck page of "Sorting" in "Talks" is open in the app
    And the person changes the title of slide 2 to "Merge sort"
    When the file "Sorting.md" is renamed to "Sorting v2.md" on disk before the change is written
    Then the page says "Not saved: This deck was moved or renamed on disk."
    When they go back to the project
    Then the page lists the decks "Sorting v2" and "Sorting"
    When they open the deck "Sorting" again
    Then it shows "# Merge sort" on slide 2, ready to download
    When they go back to the project and delete the deck "Sorting"
    Then the page lists only the deck "Sorting v2"
    And nothing went to the trash and no file was written

  Scenario: Closing the window writes the last change first
    Given the deck page of "Sorting" in "Talks" is open in the app's main window on a computer
    And the person changes the title of slide 2 to "Merge sort" in the Markdown view
    When they close the window at once
    Then the file shows "# Merge sort" on slide 2
    And the window closed without a question

  Scenario: Closing the window with a change the file cannot take asks first
    Given the deck page of "Sorting" in "Talks" is open in the app's main window on a computer
    And Claude Code writes the deck's file with frontmatter that is not valid YAML
    And the person changes the title of slide 2 to "Merge sort" in the Markdown view
    When they close the window
    Then the app asks "Your last changes to Sorting could not be saved yet. The deck's page says why."
    When they choose "Keep open"
    Then the window stays open, with the change still on the page
    When they close the window again and choose "Close without them"
    Then the window closes

  Scenario: Closing the window asks first when the Markdown view holds typing back
    Given the deck page of "Sorting" in "Talks" is open in the app's main window on a computer
    And Claude Code writes the deck's file with frontmatter that is not valid YAML
    And the person types "lost unless kept" just under the second slide's separator, which the Markdown view cannot take
    When they close the window
    Then the app asks "Your last changes to Sorting could not be saved yet. The deck's page says why."

  Scenario: Renaming an open deck moves its page to the new id
    Given the deck page of "Sorting" in "Talks" is open in the app
    And the person changes the title of slide 2 to "Merge sort"
    When the deck is renamed to "Sorting v2" before the change is written
    Then the page address names the deck's new id
    And the page still shows the deck, saved
    And the file "Sorting v2.md" shows "# Merge sort" on slide 2
    And there is no file "Sorting.md"

  Scenario: Renaming a project moves its page to the new id
    Given the project page of "Talks" is open in the app
    When they rename the project to "Lectures"
    Then the page address names the project's new id
    And the page shows the project "Lectures" with the deck "Sorting"

  Scenario: Deleting a deck moves its file to the trash
    Given the project page of "Talks" with the decks "Graphs" and "Sorting" is open in the app on a computer
    When they delete the deck "Graphs"
    Then the question said "Graphs will go to the trash, or be deleted for good where the system has none."
    And "Graphs.md" went to the trash
    And the page lists only the deck "Sorting"

  Scenario: Deleting a project moves its folder to the trash
    Given the project page of "Talks" is open in the app
    When they delete the project
    Then the folder "Talks" went to the trash
    And they are on the home page, which has no projects on this device

  Scenario: A new deck is a plain Markdown file
    Given the project page of "Talks" is open in the app
    When they add the deck "Intro" from the blank template
    Then the file "Intro.md" holds a title slide "# Intro" without slide ids
    And they are on the deck page of "Intro"

  Scenario: Signed out, the app's home page lists the device
    Given the app on a computer, signed out, with the project "Talks" on this device
    When they open the home page
    Then the page has the section "On this device" listing "Talks"
    And there is no section "Your account"
    And the guest banner says "Your work is saved on this device only."

  Scenario: Signed in, the app's home page lists the device and the account apart
    Given the app on a computer, signed in as "Ana", with the project "Talks" on this device and "Lectures" in the account
    When they open the home page
    Then the section "On this device" lists "Talks"
    And the section "Your account" lists "Lectures"
    When they create the project "Notes" from the section "Your account"
    Then "Notes" is in the account and not on this device
    When they go home and create the project "Drafts" from the section "On this device"
    Then "Drafts" is a folder on this device and not in the account

  Scenario: When the account cannot be loaded, new projects are saved on this device
    Given the app on a computer, signed in as "Ana", whose account cannot be reached, with the project "Talks" on this device
    When they open the home page
    Then the page says "Your account's projects could not be loaded. Close and open Deyslide to try again. Until then, new projects are saved on this device."
    And the section "On this device" lists "Talks"
    And there is no section "Your account"

  Scenario: Signing in never moves the device's decks
    Given the app on a computer, signed out, with the project "Talks" on this device
    When they sign in as "Ana"
    Then the section "On this device" still lists "Talks"
    And the account has no projects

  Scenario: The Claude Code panel gives the command to copy
    Given the app on a computer, signed out, with the project "Talks" on this device
    When they open the home page
    Then the panel "Connect Claude Code" shows the command the app gives
    And it shows the hosted command for "https://deyslide.bambanggunawan.id"
    When they press the button to copy the command
    Then the clipboard holds the command
    And the button says "Copied"

  Scenario: The Claude Code panel says why there is no command
    Given the app on a computer, signed out, with the project "Talks" on this device
    And the app gives no command because "Move Deyslide to Applications, then open it again."
    When they open the home page
    Then the panel says "Move Deyslide to Applications, then open it again."
    And it shows no command to copy

  Scenario: Changing the library folder
    Given the app on a computer, signed out, with the project "Talks" on this device
    And the folder "/home/ana/Slides" holds the project "Lectures"
    When they open the home page
    And they change the library folder to "/home/ana/Slides"
    Then the panel says decks are saved in "/home/ana/Slides"
    And the section "On this device" lists "Lectures" and not "Talks"

  Scenario: Android keeps no Claude Code panel
    Given the app on Android, signed out, with the project "Talks" on this device
    When they open the home page
    Then the section "On this device" lists "Talks"
    And there is no "Connect Claude Code" panel

  Scenario: Claude Code's slides are drawn in a frame nobody sees
    Given the render bridge listens in the app's main window
    When the app asks for slides 1 and 3 of a 3 slide deck, at the last click
    Then the bridge frame was in the window, out of sight, at 1280 by 720
    And the frame drew slides 1 and 3 in print mode at their last click
    And the app got 2 slide images in base64 with their click counts
    And no bridge frame is left in the window

  Scenario: Render requests are answered one at a time, each in a frame of its own
    Given the render bridge listens in the app's main window
    When the app asks for slide 1 and, right after, for slide 2 of another deck
    Then slide 2 is drawn in a new frame, only after the first request was answered
    And both requests got their answer

  Scenario: Slides that cannot be drawn say why
    Given the render bridge listens in the app's main window
    And the frame fails to draw slide 2 with "Unexpected token"
    When the app asks for slides 1, 2 and 9 of a 3 slide deck, at the last click
    Then slide 1 has an image
    And slide 2 has no image and the error "Unexpected token"
    And slide 9 has no image and the error "The deck has 3 slides, so there is no slide 9."

  Scenario Outline: Only the main window of the app on a computer draws for Claude Code and saves before closing
    Given <where>
    When the app's pages start
    Then the page <listens> for render requests
    And the page <saves> before its window closes

    Examples:
      | where                                        | listens         | saves              |
      | the app on a computer, in its main window    | listens         | writes the changes |
      | the app on a computer, in an audience window | does not listen | does nothing       |
      | the app on Android                           | does not listen | does nothing       |
