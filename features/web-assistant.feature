Feature: Deck assistant in the editor
  As a person writing a deck
  I want to ask the assistant for changes next to the preview
  So that I see each change land while Claude works

  Scenario: Ask for a new slide
    Given Ana is signed in with the blank deck "Graphs" open and the assistant on
    When she asks the assistant "Add a slide about recursion"
    Then the editor holds a second slide "# Recursion"
    And the preview shows slide 2 of 2
    And the chat shows the reply "Added a slide about recursion." with the change "Added slide 2"
    And the deck is saved with 2 slides

  Scenario: Undo a reply
    Given Ana is signed in with the blank deck "Graphs" open and the assistant on
    And she asked the assistant "Add a slide about recursion"
    When she presses "Undo"
    Then the editor holds only the first slide again
    And the preview shows slide 1 of 1

  Scenario: The editor waits while Claude works
    Given Ana is signed in with the blank deck "Graphs" open and the assistant on
    And Claude is slow to finish
    When she asks the assistant "Add a slide about recursion"
    Then the editor is read only and the send button says "Working..."
    When Claude finishes
    Then the editor can be typed in again

  Scenario: The chat so far goes with each message
    Given Ana is signed in with the blank deck "Graphs" open and the assistant on
    And she asked the assistant "Add a slide about recursion"
    When she asks the assistant "Make it shorter"
    Then the assistant received the chat so far and the deck with 2 slides

  Scenario: The allowance is shown
    Given Ana is signed in with the blank deck "Graphs" open and the assistant on, with 40 percent of the allowance used
    Then the assistant says "40% of this month's allowance used"

  Scenario: A refused request keeps the message
    Given Ana is signed in with the blank deck "Graphs" open and the assistant on
    And the allowance has run out
    When she asks the assistant "Add a slide about recursion"
    Then the assistant shows "You have used this month's assistant allowance. It starts again on October 1."
    And her message is back in the input

  Scenario: Guests are asked to sign in
    Given a guest has the blank deck "Graphs" open and the assistant on
    Then the assistant asks them to sign in

  Scenario: No assistant when the server has it off
    Given Ana is signed in with the blank deck "Graphs" open and the assistant off
    Then there is no assistant on the page
