Feature: Deck assistant in the editor
  As a person writing a deck
  I want to ask the assistant for changes next to the preview
  So that I see each change land while Claude works

  Scenario: Ask for a new slide
    Given Ana is signed in with the blank deck "Graphs" open and the assistant on
    When Ana asks the assistant "Add a slide about recursion"
    Then the editor holds a second slide "# Recursion"
    And the preview shows slide 2 of 2
    And the chat shows the reply "Added a slide about recursion." with the change "Added slide 2"
    And the deck is saved with 2 slides

  Scenario: Undo a reply
    Given Ana is signed in with the blank deck "Graphs" open and the assistant on
    And Ana asked the assistant "Add a slide about recursion"
    When Ana presses "Undo"
    Then the editor holds only the first slide again
    And the preview shows slide 1 of 1

  Scenario: The editor waits while Claude works
    Given Ana is signed in with the blank deck "Graphs" open and the assistant on
    And Claude is slow to finish
    When Ana asks the assistant "Add a slide about recursion"
    Then the editor is read only and the send button says "Working..."
    When Claude finishes
    Then the editor can be typed in again

  Scenario: The chat so far goes with each message
    Given Ana is signed in with the blank deck "Graphs" open and the assistant on
    And Ana asked the assistant "Add a slide about recursion"
    When Ana asks the assistant "Make it shorter"
    Then the assistant received the chat so far and the deck with 2 slides

  Scenario: The allowance is shown
    Given Ana is signed in with the blank deck "Graphs" open and the assistant on, with 40 percent of the allowance used
    Then the assistant says "40% of this month's allowance used"

  Scenario: A refused request keeps the message
    Given Ana is signed in with the blank deck "Graphs" open and the assistant on
    And the allowance has run out
    When Ana asks the assistant "Add a slide about recursion"
    Then the assistant shows "You have used this month's assistant allowance. It starts again on October 1."
    And Ana's message is back in the input

  Scenario: Guests are asked to sign in
    Given a guest has the blank deck "Graphs" open and the assistant on
    Then the assistant asks them to sign in

  Scenario: No assistant when the server has it off
    Given Ana is signed in with the blank deck "Graphs" open and the assistant off
    Then there is no assistant on the page

  Scenario: A collaborator's edit made during a reply survives
    Given Ana is signed in with the blank deck "Graphs" open and the assistant on
    And Budi has the same deck open in another browser
    And Claude takes a while before changing the deck
    When Ana asks the assistant "Add a slide about recursion"
    And Budi changes the title to "# Graphs, from Budi" while Claude works
    And Claude changes the deck
    Then the editor holds the title "# Graphs, from Budi" and a second slide "# Recursion"
    And Budi's copy holds both changes too
    When Ana presses "Undo"
    Then the editor holds only the first slide, with the title "# Graphs, from Budi"

  Scenario: Undo after typing elsewhere takes back only the reply
    Given Ana is signed in with the blank deck "Graphs" open and the assistant on
    And Ana asked the assistant "Add a slide about recursion"
    And Ana then changed the title to "# Graphs, typed" in the editor, and it was saved
    When Ana presses "Undo"
    Then the editor holds only the first slide, with the title "# Graphs, typed"
    And the deck is saved with only that slide

  Scenario: The preview keeps showing Claude's slide until Ana moves the cursor
    Given Ana is signed in with the blank deck "Graphs" open and the assistant on
    And Budi has the same deck open in another browser
    And the editor's cursor is on the first slide
    When Ana asks the assistant "Add a slide about recursion"
    Then the preview shows slide 2 of 2
    When Budi changes the title to "# Graphs, from Budi"
    Then the editor shows Budi's title, and the preview still shows slide 2 of 2
    When Ana moves the cursor within the first slide
    Then the preview shows slide 1 of 2

  Scenario: A reply with several changes adds each slide once, and Undo takes all of it back
    Given Ana is signed in with the blank deck "Graphs" open and the assistant on
    And Claude pauses for longer than half a second between its changes
    When Ana asks the assistant "Add slides about recursion and trees"
    Then the editor holds the slides "# Recursion" and "# Trees" after the first, each once
    And the preview shows slide 3 of 3
    When Ana presses "Undo"
    Then the editor holds only the first slide again

  Scenario: Undo after two replies takes back only the latest
    Given Ana is signed in with the blank deck "Graphs" open and the assistant on
    And Ana asked the assistant "Add a slide about recursion"
    And Ana asked the assistant "Add a slide about trees"
    When Ana presses "Undo"
    Then the editor holds the slide "# Recursion" after the first, and no slide "# Trees"

  Scenario: A question or a refused request keeps the Undo for the last change
    Given Ana is signed in with the blank deck "Graphs" open and the assistant on
    And Ana asked the assistant "Add a slide about recursion"
    When Ana asks the assistant "Is that slide clear?"
    And Ana asks the assistant "Add a slide about trees", which is refused
    Then "Undo" is still there
    When Ana presses "Undo"
    Then the editor holds only the first slide again

  Scenario: Undo goes away once someone edits a slide Claude added
    Given Ana is signed in with the blank deck "Graphs" open and the assistant on
    And Ana asked the assistant "Add a slide about recursion"
    When Ana types "My own notes" into the slide Claude added, and it is saved
    Then "Undo" is no longer there
    And the deck keeps the slide "# Recursion" with "My own notes"

  Scenario: Opening another deck while Claude works leaves it editable
    Given Ana is signed in with the blank decks "Graphs" and "Trees", "Graphs" open and the assistant on
    And Claude is slow to finish
    When Ana asks the assistant "Add a slide about recursion"
    And Ana opens the deck "Trees" while Claude works
    And Claude finishes
    Then the editor holds the deck "Trees" and can be typed in
